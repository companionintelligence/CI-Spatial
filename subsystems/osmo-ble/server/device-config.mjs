// Finds the two files that already hold the answer — the repo's .mcp.json (device URLs, and the
// name of each device's token variable) and its .env (the token values) — and hands them to the
// pure resolver in ../protocol/device_registry.mjs.
//
// Read fresh on every resolution rather than cached at import: a capture happens at most a few
// times a minute, the files are under 2 KB, and an operator who has just pasted a token into
// .env should not have to work out that the backend needs restarting to see it. Every failure
// here is swallowed into "no registry" — a missing or malformed .mcp.json must degrade to the
// plain ANDROID_MCP_URL/ANDROID_MCP_TOKEN path, never take the backend down.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, parseMcpDevices, resolveDevice } from '../protocol/device_registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from subsystems/osmo-ble/server/ until a .mcp.json turns up. Bounded, and works from
 * a git worktree (each worktree has its own checkout of both files) as well as from the main
 * checkout. Stops at the filesystem root.
 */
function findRepoRoot() {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '.mcp.json')) || existsSync(join(dir, 'CLAUDE.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(HERE, '../../..');
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The android-* devices declared in .mcp.json (or ANDROID_MCP_CONFIG). Never throws. */
export function loadDeviceRegistry(root = findRepoRoot()) {
  const path = process.env.ANDROID_MCP_CONFIG || join(root, '.mcp.json');
  return parseMcpDevices(readJsonFile(path));
}

/**
 * process.env, with the repo's .env filled in underneath it for ANDROID_MCP_* names only.
 *
 * The repo convention is that .env is NOT auto-loaded (see .env.example's header) and this does
 * not change that: nothing is exported into process.env, and only the android-remote-control
 * variables are ever looked up. It exists because the token for tonight's capture was sitting
 * in .env the whole time while the backend insisted it was unset. A real environment variable
 * always wins. Set ANDROID_MCP_ENV_FILE to point somewhere else, or to '' to skip the file.
 */
export function loadEnv(root = findRepoRoot()) {
  const configured = process.env.ANDROID_MCP_ENV_FILE;
  if (configured === '') return { ...process.env };
  const path = configured || join(root, '.env');
  let fromFile = {};
  try {
    fromFile = parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    fromFile = {}; // no .env is the normal case, not an error
  }
  const merged = {};
  for (const [k, v] of Object.entries(fromFile)) {
    if (k.startsWith('ANDROID_MCP_')) merged[k] = v;
  }
  return { ...merged, ...process.env };
}

/**
 * Resolve the phone a capture request should drive.
 *
 * @param {object} body  request body — an explicit deviceUrl/deviceToken/device still wins.
 * @returns {{ok: true, url, token, device, tokenEnv, source}|{ok: false, error, remediation}}
 *          The `token` on a successful result is a secret: pass it to AndroidMcpClient and
 *          nowhere else. Never put it in a response, an event, a manifest, or a log line.
 */
export function resolveCaptureDevice(body = {}) {
  const root = findRepoRoot();
  return resolveDevice({ request: body, env: loadEnv(root), devices: loadDeviceRegistry(root) });
}

/**
 * The same resolution, reduced to what is safe to show an operator: which phone would be
 * driven, where the URL came from, and — when it would refuse — exactly which variable to set.
 * Deliberately returns no token and no way to infer one beyond "a value is present".
 */
export function describeCaptureDevice(body = {}) {
  const resolved = resolveCaptureDevice(body);
  if (!resolved.ok) {
    return {
      configured: false,
      devices: loadDeviceRegistry().map((d) => ({ name: d.name, url: d.url, tokenEnv: d.tokenEnv })),
      error: resolved.error,
      remediation: resolved.remediation,
    };
  }
  return {
    configured: true,
    device: resolved.device,
    url: resolved.url,
    // Which variable supplied the token — its NAME, never its value. null means the token came
    // in on the request itself.
    tokenEnv: resolved.tokenEnv,
    urlSource: resolved.source,
  };
}
