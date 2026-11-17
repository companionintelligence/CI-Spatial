// Which phone do we drive, and with which token?
//
// Pure resolution logic — no file or network I/O, so it can be tested directly. The I/O
// (finding and reading .mcp.json and .env) lives in ../server/device-config.mjs.
//
// Why this exists: on 2026-08-29 a real six-column dome had to be shuttled by hand, photo by
// photo, because POST /api/capture-photo refused with "deviceUrl is required (or set
// ANDROID_MCP_URL)" and then "deviceToken is required (or set ANDROID_MCP_TOKEN)" — while the
// device URL was sitting in the repo's .mcp.json and the token in its .env the whole time. The
// backend read neither.
//
// The hard part is NOT plumbing one global. THE TOKEN IS PER-DEVICE: every phone in the fleet
// runs its own android-remote-control-mcp server with its own bearer token, which is why
// .env.example has ANDROID_MCP_TOKEN_TAB_S8_ULTRA / _TAB_S9_ULTRA / _BEAM_PRO_1 / _BEAM_PRO and
// says in as many words that "a single shared ANDROID_MCP_TOKEN cannot work across the fleet".
// So the job is to pick the RIGHT token for the phone being driven.
//
// .mcp.json already states that mapping exactly once, per device:
//
//   "android-beam-pro-1": {
//     "url": "http://beam-pro-1.example.ts.net:8080/mcp",
//     "headers": { "Authorization": "Bearer ${ANDROID_MCP_TOKEN_BEAM_PRO_1}" }
//   }
//
// — the URL and the NAME OF the variable holding that device's token, side by side. Parsing it
// out of there (rather than hardcoding a second copy of the fleet's hostnames here) is the
// ADR 0001 reuse-don't-duplicate reading: one registry, not two that can drift.
//
// Note what is deliberately NOT read: a literal, non-placeholder Authorization value. Only a
// `${VAR}` placeholder is honoured, and only as a variable NAME to look up. CLAUDE.md forbids
// hardcoding real tokens into the tracked .mcp.json, and a resolver that happily consumed one
// would quietly reward doing it.

/** Devices are keyed `android-<name>` in .mcp.json; the token variables are UPPER_SNAKE. */
export function envSlug(name) {
  return String(name).trim().replace(/^android-/i, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

/**
 * `http://beam-pro-1.example.ts.net:8080/mcp` -> `beam-pro-1`: the name a host is keyed by.
 * A name is not an address. A request URL is never matched or named by it; an operator's own URL
 * (env or .mcp.json) may be, as resolveDevice() explains.
 */
export function hostLabel(url) {
  try {
    return new URL(url).hostname.split('.')[0].toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The origin (scheme, host, port) of an http(s) URL, or '' for anything else.
 *
 * This is the address a request-supplied URL must match to receive a stored token. Origin, not
 * hostLabel(): two hosts can share a first label (`beam-pro-1.example.com` and
 * `beam-pro-1.attacker.example`), and only the exact address a phone is registered at may receive
 * that phone's token when the URL came in on the request.
 *
 * @param {string} url
 * @returns {string}
 */
export function urlOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

/**
 * Minimal KEY=VALUE reader for the repo's .env.
 *
 * Hand-rolled rather than reaching for node:util's experimental parseEnv, and deliberately
 * dumb: no interpolation, no `export` semantics, no multi-line values. It exists so a token an
 * operator has already written into .env is found, not to become a second configuration
 * language. Callers only ever look up ANDROID_MCP_* names in the result.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Pull the android devices out of a parsed .mcp.json.
 *
 * @returns {{name: string, url: string, tokenEnv: string}[]}
 */
export function parseMcpDevices(config) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const devices = [];
  for (const [key, entry] of Object.entries(servers)) {
    if (!/^android-/i.test(key)) continue;
    const url = typeof entry?.url === 'string' ? entry.url : '';
    if (!url) continue; // a stdio entry (like osmo-gimbal itself) is not a phone we can reach
    const name = key.replace(/^android-/i, '').toLowerCase();
    const auth = entry?.headers?.Authorization ?? entry?.headers?.authorization ?? '';
    // Only a ${VAR} placeholder — never a literal token. See the header comment.
    const placeholder = String(auth).match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
    devices.push({ name, url, tokenEnv: placeholder ? placeholder[1] : `ANDROID_MCP_TOKEN_${envSlug(name)}` });
  }
  return devices;
}

const SETUP_DOC = 'subsystems/osmo-ble/README.md — "Configuring the phone it drives"';

function refuse(error, remediation) {
  return { ok: false, error, remediation };
}

/**
 * The rule that decides which phone an operator's ANDROID_MCP_URL belongs to. It goes into the
 * refusal, so a URL that was not used has a stated reason.
 */
function hostLabelRule(name) {
  return 'With no .mcp.json entry, an ANDROID_MCP_URL is used for a phone only when the first label of its host name is '
    + `that phone's name, such as ${name}.<tailnet>.ts.net.`;
}

/**
 * Work out the phone to drive and the token to drive it with.
 *
 * Precedence, highest first: an explicit `deviceUrl`/`deviceToken` in the request body (so a
 * one-off device never needs a restart), then the environment, then .mcp.json for the URL.
 * The two halves resolve independently — the common real case is a URL from .mcp.json and a
 * token from the environment, which is precisely the pair that already existed in the repo.
 *
 * @param {object} opts
 * @param {object} opts.request   the HTTP request body (deviceUrl / deviceToken / device)
 * @param {object} opts.env       merged environment (process.env over .env)
 * @param {{name,url,tokenEnv}[]} opts.devices  registry from parseMcpDevices()
 * @returns {{ok: true, url: string, token: string, device: string|null, tokenEnv: string|null, source: string}
 *          |{ok: false, error: string, remediation: string}}
 *          On success `token` is present but MUST NOT be echoed anywhere — not into a
 *          response body, an error, an NDJSON event, a manifest, or a log line.
 */
export function resolveDevice({ request = {}, env = {}, devices = [] } = {}) {
  const named = String(request.device ?? env.ANDROID_MCP_DEVICE ?? '').trim().replace(/^android-/i, '').toLowerCase();
  const known = devices.map((d) => d.name).sort();
  const knownList = known.length ? known.join(', ') : '(none — no android-* entry in .mcp.json)';

  let entry = null;
  if (named) {
    entry = devices.find((d) => d.name === named) ?? null;
    // A named device with no .mcp.json entry is still drivable if the environment carries its
    // URL, so this is only fatal once that has been ruled out too. The operator's ANDROID_MCP_URL
    // counts for the named phone only when its host IS that phone and its own token is set, so a
    // phone's token is never sent to another phone's address.
    const namedSlug = envSlug(named);
    const operatorUrlLabel = hostLabel(env.ANDROID_MCP_URL ?? '');
    const operatorUrlNamesPhone = operatorUrlLabel === named;
    const operatorUrlIsNamedPhone = operatorUrlNamesPhone && Boolean(env[`ANDROID_MCP_TOKEN_${namedSlug}`]);
    if (!entry && !env[`ANDROID_MCP_URL_${namedSlug}`] && !operatorUrlIsNamedPhone && !request.deviceUrl) {
      // The URL is for this phone, but its token is missing. Say that, rather than that the phone is unknown.
      if (operatorUrlNamesPhone) {
        return refuse(
          `The ANDROID_MCP_URL is for "${named}", but ANDROID_MCP_TOKEN_${namedSlug} is not set.`,
          `Export ANDROID_MCP_TOKEN_${namedSlug} (read it from that phone's Settings → Access) in the shell `
          + `that starts this backend, then restart it, or put it in the repo's .env, which this backend reads. `
          + `${hostLabelRule(named)} See ${SETUP_DOC}.`,
        );
      }
      const urlNote = operatorUrlLabel
        ? ` The ANDROID_MCP_URL is for "${operatorUrlLabel}", so it is not used for "${named}".`
        : '';
      return refuse(
        `No phone named "${named}" is configured.`,
        `Known devices: ${knownList}. Add an "android-${named}" entry to .mcp.json, or set `
        + `ANDROID_MCP_URL_${namedSlug} and ANDROID_MCP_TOKEN_${namedSlug}.${urlNote} `
        + `${hostLabelRule(named)} See ${SETUP_DOC}.`,
      );
    }
  }

  // ---- URL ----------------------------------------------------------------
  let url = '';
  let source = '';
  if (request.deviceUrl) {
    url = String(request.deviceUrl);
    source = 'request';
  } else if (named && env[`ANDROID_MCP_URL_${envSlug(named)}`]) {
    url = env[`ANDROID_MCP_URL_${envSlug(named)}`];
    source = `env ANDROID_MCP_URL_${envSlug(named)}`;
  } else if (entry) {
    url = entry.url;
    source = `.mcp.json android-${entry.name}`;
  } else if (env.ANDROID_MCP_URL) {
    url = env.ANDROID_MCP_URL;
    source = 'env ANDROID_MCP_URL';
  } else {
    // Nothing named anything. Pick the one device that is actually usable — a registry entry
    // whose per-device token is set. One is an answer; several is a question, not a coin toss.
    const usable = devices.filter((d) => env[d.tokenEnv]);
    if (usable.length === 1) {
      entry = usable[0];
      url = entry.url;
      source = `.mcp.json android-${entry.name} (the only device with ${entry.tokenEnv} set)`;
    } else if (usable.length > 1) {
      const names = usable.map((d) => d.name).sort();
      return refuse(
        `More than one phone is configured (${names.join(', ')}) and none was named.`,
        `Say which to drive: set ANDROID_MCP_DEVICE=${names[0]}, or send {"device": "${names[0]}"} `
        + `in the request. See ${SETUP_DOC}.`,
      );
    } else if (devices.length) {
      // The registry knows the phones; what is missing is the token for whichever one is in the
      // cradle. Name the variable per device, since that is the thing to go and set.
      return refuse(
        'No phone is configured for photo capture, so the backend cannot take the picture itself.',
        `Export the token for the phone you are driving — one of ${devices.map((d) => d.tokenEnv).sort().join(', ')} `
        + `(read it from that phone's Settings → Access) — in the shell that starts this backend, `
        + `and set ANDROID_MCP_DEVICE to the matching device (${knownList}) if you export more than one. See ${SETUP_DOC}.`,
      );
    } else {
      return refuse(
        'No phone is configured for photo capture, so the backend cannot take the picture itself.',
        'Set ANDROID_MCP_URL to the device\'s MCP endpoint (http://<device>.<tailnet>.ts.net:8080/mcp) and '
        + 'ANDROID_MCP_TOKEN to its token, from the phone\'s Settings → Access. For a fleet, list each phone in '
        + `.mcp.json as android-<name> and export its own ANDROID_MCP_TOKEN_<DEVICE> instead. See ${SETUP_DOC}.`,
      );
    }
  }

  const fromRequest = source === 'request';

  // A URL that did not name a device is matched back to a registry entry by ORIGIN, so the phone's
  // own token is still found when the phone is given by its address. An operator's own URL (env or
  // .mcp.json) may also match by host label, as it did before, so ANDROID_MCP_URL on the same host
  // at another port still finds that phone's token. A request URL never matches by label.
  if (!entry && urlOrigin(url)) {
    entry = devices.find((d) => urlOrigin(d.url) === urlOrigin(url)) ?? null;
  }
  if (!entry && !fromRequest && hostLabel(url)) {
    const label = hostLabel(url);
    entry = devices.find((d) => hostLabel(d.url) === label) ?? null;
  }

  // ---- Token --------------------------------------------------------------
  // A stored token is one phone's secret, so it may only travel to that phone's own address. A URL
  // that came in on the request therefore gets a stored token only when its origin is exactly the
  // registry entry's origin, and never the shared ANDROID_MCP_TOKEN, which belongs to no phone. A
  // URL from the environment or .mcp.json is the operator's own choice of address, so it keeps the
  // full fallback order below. Such a URL with no registry entry is named by its host label, which
  // is how ANDROID_MCP_TOKEN_<LABEL> is found. A request URL is never named that way.
  const deviceName = entry?.name || named || (fromRequest ? null : hostLabel(url) || null);
  const slug = deviceName ? envSlug(deviceName) : '';
  const sameAddress = entry !== null && urlOrigin(url) !== '' && urlOrigin(url) === urlOrigin(entry.url);
  // Ordered so the most specific wins, and so the fleet-hostile shared ANDROID_MCP_TOKEN is
  // last: it still works for a one-phone setup, but it can never shadow a per-device token.
  const candidates = [];
  if (!fromRequest || sameAddress) {
    if (entry?.tokenEnv) candidates.push(entry.tokenEnv);
    if (slug) candidates.push(`ANDROID_MCP_TOKEN_${slug}`);
    if (!fromRequest) candidates.push('ANDROID_MCP_TOKEN');
  }

  let token = '';
  let tokenEnv = null;
  if (request.deviceToken) {
    token = String(request.deviceToken);
    tokenEnv = null;
  } else {
    for (const name2 of candidates) {
      if (env[name2]) {
        token = env[name2];
        tokenEnv = name2;
        break;
      }
    }
  }

  if (!token) {
    const wanted = candidates[0];
    if (!wanted) {
      return refuse(
        `No access token for the phone at ${url}.`,
        'A stored token is only sent to the address its phone is registered at, and this URL is not one '
        + `of them. Send deviceToken with the request for this address, or drive a registered phone by name. See ${SETUP_DOC}.`,
      );
    }
    return refuse(
      `No access token for the phone at ${url}${deviceName ? ` ("${deviceName}")` : ''}.`
      + ' Each phone runs its own remote-control server with its own token, so there is one variable per device.',
      `Export ${wanted} (read it from that phone's Settings → Access) in the shell that starts this `
      + `backend, then restart it — or put it in the repo's .env, which this backend reads. `
      + `See ${SETUP_DOC}.`,
    );
  }

  return { ok: true, url, token, device: deviceName, tokenEnv, source };
}
