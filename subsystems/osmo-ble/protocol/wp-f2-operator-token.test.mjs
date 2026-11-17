import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpDevices, resolveDevice } from './device_registry.mjs';

// Operator-configured URLs (ANDROID_MCP_URL, .mcp.json) keep the label fallback HEAD had, so the
// per-device token is still found. Request URLs never do. These tests pin both halves.
const DEVICES = parseMcpDevices({
  mcpServers: {
    'android-beam-pro-1': {
      type: 'http',
      url: 'http://beam-pro-1.example.ts.net:8080/mcp',
      headers: { Authorization: 'Bearer ${ANDROID_MCP_TOKEN_BEAM_PRO_1}' },
    },
  },
});
const SECRET = 'sk-not-a-real-token-0123456789';
const SHARED = 'sk-not-a-real-shared-0123456789';
const BEAM_8080 = 'http://beam-pro-1.example.ts.net:8080/mcp';
const BEAM_9999 = 'http://beam-pro-1.example.ts.net:9999/mcp';

test('env-only: ANDROID_MCP_URL with ANDROID_MCP_TOKEN_<NAME> and no registry finds the token by host label', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: BEAM_8080, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
  assert.equal(r.device, 'beam-pro-1');
  assert.equal(r.url, BEAM_8080);
});

test('env-only: with ANDROID_MCP_URL set, the per-device token wins over the shared ANDROID_MCP_TOKEN', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: BEAM_8080, ANDROID_MCP_TOKEN: SHARED, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
});

test('env-only: the shared ANDROID_MCP_TOKEN still works for a single phone with no per-device token', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: BEAM_8080, ANDROID_MCP_TOKEN: SHARED },
    devices: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SHARED);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN');
});

test('env-only: a missing token is refused, and the refusal names the per-device variable', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: BEAM_8080 },
    devices: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /beam-pro-1/);
  assert.match(r.remediation, /ANDROID_MCP_TOKEN_BEAM_PRO_1/);
});

test('the same host on another port: an operator URL still finds the phone\'s token, with the registry', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: BEAM_9999, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: DEVICES,
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
});

test('the same host on another port: an operator URL still finds the phone\'s token, env-only', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: BEAM_9999, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
});

test('the same host on another port: a request URL gets no stored token, with or without a registry', () => {
  for (const devices of [DEVICES, []]) {
    const r = resolveDevice({
      request: { deviceUrl: BEAM_9999 },
      env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET, ANDROID_MCP_TOKEN: SHARED },
      devices,
    });
    assert.equal(r.ok, false, `devices=${devices.length}`);
    assert.ok(!JSON.stringify(r).includes(SECRET), 'refusal must not carry the token');
    assert.ok(!JSON.stringify(r).includes(SHARED), 'refusal must not carry the shared token');
    assert.match(r.remediation, /deviceToken/);
  }
});

test('a request URL on the phone\'s host label is never named after the phone, with or without a registry', () => {
  for (const devices of [[], DEVICES]) {
    const r = resolveDevice({
      request: { deviceUrl: 'http://beam-pro-1.attacker.example:8080/mcp' },
      env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET, ANDROID_MCP_TOKEN: SHARED },
      devices,
    });
    assert.equal(r.ok, false, `refused, devices=${devices.length}`);
    assert.equal(r.token, undefined, 'a refused request URL gets no token');
    assert.equal(r.tokenEnv, undefined, 'no token variable is named for it either');
    assert.ok(!JSON.stringify(r).includes(SECRET));
    assert.ok(!JSON.stringify(r).includes(SHARED));
    assert.match(r.remediation, /deviceToken/, 'the refusal says how to supply a token for that address');
  }
});
