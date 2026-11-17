import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpDevices, resolveDevice } from './device_registry.mjs';

// F3-1: an operator's ANDROID_MCP_URL resolves for the named phone too, when that phone's own token is
// set and the URL is that phone's address. F3-2: when the registry names a different variable for a
// phone, an operator URL on that phone's host finds the token through the registry, not by guessing.
const SECRET = 'sk-not-a-real-token-0123456789';
const OTHER = 'sk-not-a-real-other-0123456789';
const BEAM_8080 = 'http://beam-pro-1.example.ts.net:8080/mcp';
const BEAM_9999 = 'http://beam-pro-1.example.ts.net:9999/mcp';

test('F3-1: ANDROID_MCP_DEVICE with an env-only ANDROID_MCP_URL resolves when that phone\'s token is set', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_DEVICE: 'beam-pro-1', ANDROID_MCP_URL: BEAM_8080, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: [],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.device, 'beam-pro-1');
  assert.equal(r.url, BEAM_8080);
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
});

test('F3-1: a named phone is not given the URL of a different phone, and that phone\'s token stays home', () => {
  // ANDROID_MCP_DEVICE names beam-pro, but the URL is beam-pro-1's: beam-pro\'s token must not go there.
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_DEVICE: 'beam-pro', ANDROID_MCP_URL: BEAM_8080, ANDROID_MCP_TOKEN_BEAM_PRO: SECRET },
    devices: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /No phone named "beam-pro"/);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('F3-1: the named variant refuses when only another phone\'s token is set, and leaks neither', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_DEVICE: 'beam-pro-1', ANDROID_MCP_URL: BEAM_8080, ANDROID_MCP_TOKEN_TAB_S8_ULTRA: SECRET },
    devices: [],
  });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('F3-1: the named variant keeps the request-path refusal, so a request URL gets no stored token', () => {
  const r = resolveDevice({
    request: { deviceUrl: BEAM_8080 },
    env: { ANDROID_MCP_DEVICE: 'beam-pro-1', ANDROID_MCP_URL: BEAM_8080, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.token, undefined);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.match(r.remediation, /deviceToken/);
});

test('F3-2: an operator URL keeps its token when the registry names a different variable for that phone', () => {
  const devices = parseMcpDevices({
    mcpServers: {
      'android-beam-pro-1': {
        type: 'http',
        url: BEAM_8080,
        headers: { Authorization: 'Bearer ${OSMO_BEAM_TOKEN}' },
      },
    },
  });
  // The phone's registered variable is OSMO_BEAM_TOKEN. The host-label guess would pick
  // ANDROID_MCP_TOKEN_BEAM_PRO_1 instead, so that one is set to a different value to make the difference visible.
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: BEAM_9999, OSMO_BEAM_TOKEN: SECRET, ANDROID_MCP_TOKEN_BEAM_PRO_1: OTHER },
    devices,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.device, 'beam-pro-1');
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'OSMO_BEAM_TOKEN');
});
