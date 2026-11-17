import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpDevices, resolveDevice, urlOrigin } from './device_registry.mjs';

// The repo's .mcp.json shape, as the existing device_registry tests use it.
const DEVICES = parseMcpDevices({
  mcpServers: {
    'android-tab-s8-ultra': {
      type: 'http',
      url: 'http://tab-s8-ultra-1.example.ts.net:8080/mcp',
      headers: { Authorization: 'Bearer ${ANDROID_MCP_TOKEN_TAB_S8_ULTRA}' },
    },
    'android-beam-pro-1': {
      type: 'http',
      url: 'http://beam-pro-1.example.ts.net:8080/mcp',
      headers: { Authorization: 'Bearer ${ANDROID_MCP_TOKEN_BEAM_PRO_1}' },
    },
  },
});
const SECRET = 'sk-not-a-real-token-0123456789';
const BEAM = 'http://beam-pro-1.example.ts.net:8080/mcp';

test('urlOrigin keeps scheme, host and port, and nothing from the path', () => {
  assert.equal(urlOrigin(BEAM), 'http://beam-pro-1.example.ts.net:8080');
  assert.equal(urlOrigin('HTTPS://Beam-Pro-1.example.ts.net/x?y=1'), 'https://beam-pro-1.example.ts.net');
  assert.equal(urlOrigin('ftp://beam-pro-1.example.ts.net/'), '');
  assert.equal(urlOrigin('not a url'), '');
});

test('a host that only shares the first DNS label does not receive the phone\'s token', () => {
  const r = resolveDevice({
    request: { deviceUrl: 'http://beam-pro-1.attacker.example:8080/mcp' },
    env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: DEVICES,
  });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'refusal must not carry the token');
  assert.match(r.remediation, /deviceToken/);
});

test('a host named after a device gets no per-device token derived from its label', () => {
  // The old code built ANDROID_MCP_TOKEN_<slug> from the request host even with no registry entry.
  const r = resolveDevice({
    request: { deviceUrl: 'http://tab-s8-ultra.attacker.example:8080/mcp' },
    env: { ANDROID_MCP_TOKEN_TAB_S8_ULTRA: SECRET },
    devices: DEVICES,
  });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('a registered host on a different port or scheme is a different address and gets no stored token', () => {
  for (const deviceUrl of [
    'http://beam-pro-1.example.ts.net:9999/mcp',
    'https://beam-pro-1.example.ts.net:8080/mcp',
  ]) {
    const r = resolveDevice({ request: { deviceUrl }, env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET }, devices: DEVICES });
    assert.equal(r.ok, false, deviceUrl);
    assert.ok(!JSON.stringify(r).includes(SECRET), deviceUrl);
  }
});

test('a request URL never receives the shared ANDROID_MCP_TOKEN', () => {
  const r = resolveDevice({
    request: { deviceUrl: 'http://anywhere.example:8080/mcp' },
    env: { ANDROID_MCP_TOKEN: SECRET },
    devices: [],
  });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('a named phone given a request URL somewhere else gets no stored token', () => {
  const r = resolveDevice({
    request: { device: 'beam-pro-1', deviceUrl: 'http://evil.example:8080/mcp' },
    env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: DEVICES,
  });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('a request URL on the registered address still gets that phone\'s own token', () => {
  const r = resolveDevice({
    request: { deviceUrl: 'http://beam-pro-1.example.ts.net:8080/mcp/' },
    env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: DEVICES,
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
});

test('a request-supplied deviceToken is used as given, whatever the URL', () => {
  const r = resolveDevice({
    request: { deviceUrl: 'http://anywhere.example:8080/mcp', deviceToken: 'caller-token' },
    env: { ANDROID_MCP_TOKEN: SECRET, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: DEVICES,
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'caller-token');
  assert.equal(r.tokenEnv, null);
});

test('an operator-configured URL keeps the single-phone shared token', () => {
  const r = resolveDevice({
    request: {},
    env: { ANDROID_MCP_URL: 'http://phone.example:8080/mcp', ANDROID_MCP_TOKEN: SECRET },
    devices: DEVICES,
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN');
});
