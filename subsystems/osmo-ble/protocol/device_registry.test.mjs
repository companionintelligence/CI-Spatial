import test from 'node:test';
import assert from 'node:assert/strict';
import { envSlug, hostLabel, parseEnvFile, parseMcpDevices, resolveDevice } from './device_registry.mjs';

// A trimmed copy of the repo's real .mcp.json shape, including the stdio entry that is not a
// phone and must not be offered as one.
const MCP_JSON = {
  mcpServers: {
    'android-tab-s8-ultra': {
      type: 'http',
      url: 'http://liams-tab-s8-ultra.capybara-ulmer.ts.net:8080/mcp',
      headers: { Authorization: 'Bearer ${ANDROID_MCP_TOKEN_TAB_S8_ULTRA}' },
    },
    'android-beam-pro-1': {
      type: 'http',
      url: 'http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp',
      headers: { Authorization: 'Bearer ${ANDROID_MCP_TOKEN_BEAM_PRO_1}' },
    },
    'osmo-gimbal': { command: 'node', args: ['subsystems/osmo-ble/server/mcp-server.mjs'] },
  },
};
const DEVICES = parseMcpDevices(MCP_JSON);
const SECRET = 'sk-not-a-real-token-0123456789';

test('envSlug maps a device name onto its token variable suffix', () => {
  assert.equal(envSlug('beam-pro-1'), 'BEAM_PRO_1');
  assert.equal(envSlug('android-tab-s9-ultra'), 'TAB_S9_ULTRA');
});

test('hostLabel reduces a device URL to the name .mcp.json keys it by', () => {
  assert.equal(hostLabel('http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp'), 'beam-pro-1');
  assert.equal(hostLabel('not a url'), '');
});

test('parseMcpDevices reads the URL and the token VARIABLE NAME, skipping non-http entries', () => {
  assert.deepEqual(DEVICES.map((d) => d.name).sort(), ['beam-pro-1', 'tab-s8-ultra']);
  const beam = DEVICES.find((d) => d.name === 'beam-pro-1');
  assert.equal(beam.url, 'http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp');
  assert.equal(beam.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
});

// The hostname is NOT a reliable source for the token variable — the real fleet has
// liams-tab-s8-ultra behind ANDROID_MCP_TOKEN_TAB_S8_ULTRA. Deriving the variable from the
// host would look right on beam-pro-1 and be wrong on half the fleet, which is why the
// mapping is read from the file that already states it.
test('the token variable follows the .mcp.json key, not the hostname', () => {
  const tab = DEVICES.find((d) => d.name === 'tab-s8-ultra');
  assert.equal(tab.tokenEnv, 'ANDROID_MCP_TOKEN_TAB_S8_ULTRA');
  assert.equal(hostLabel(tab.url), 'liams-tab-s8-ultra');
});

test('a literal Authorization header is never read as a token', () => {
  const devices = parseMcpDevices({
    mcpServers: { 'android-x': { url: 'http://x.ts.net:8080/mcp', headers: { Authorization: `Bearer ${SECRET}` } } },
  });
  assert.equal(devices[0].tokenEnv, 'ANDROID_MCP_TOKEN_X');
  assert.ok(!JSON.stringify(devices).includes(SECRET));
});

test('parseEnvFile reads KEY=VALUE, ignoring comments, blanks and quotes', () => {
  const parsed = parseEnvFile('# comment\n\nANDROID_MCP_TOKEN_BEAM_PRO_1="abc"\nexport OTHER=1\nnot a pair\n');
  assert.equal(parsed.ANDROID_MCP_TOKEN_BEAM_PRO_1, 'abc');
  assert.equal(parsed.OTHER, '1');
  assert.equal(Object.keys(parsed).length, 2);
});

test('a device with its own token resolves with no request fields at all', () => {
  const r = resolveDevice({ request: {}, env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET }, devices: DEVICES });
  assert.equal(r.ok, true);
  assert.equal(r.device, 'beam-pro-1');
  assert.equal(r.url, 'http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp');
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
});

test('ANDROID_MCP_DEVICE picks which phone, and gets THAT phone\'s token', () => {
  const env = { ANDROID_MCP_DEVICE: 'tab-s8-ultra', ANDROID_MCP_TOKEN_TAB_S8_ULTRA: 'tab-tok', ANDROID_MCP_TOKEN_BEAM_PRO_1: 'beam-tok' };
  const r = resolveDevice({ request: {}, env, devices: DEVICES });
  assert.equal(r.ok, true);
  assert.equal(r.device, 'tab-s8-ultra');
  assert.equal(r.token, 'tab-tok');
});

test('a per-device token wins over a shared ANDROID_MCP_TOKEN', () => {
  const env = { ANDROID_MCP_TOKEN: 'shared-wrong', ANDROID_MCP_TOKEN_BEAM_PRO_1: 'beam-right' };
  const r = resolveDevice({ request: { device: 'beam-pro-1' }, env, devices: DEVICES });
  assert.equal(r.token, 'beam-right');
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN_BEAM_PRO_1');
});

test('a bare ANDROID_MCP_URL still finds the per-device token by matching the host back to the registry', () => {
  const env = { ANDROID_MCP_URL: 'http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp', ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET };
  const r = resolveDevice({ request: {}, env, devices: DEVICES });
  assert.equal(r.ok, true);
  assert.equal(r.device, 'beam-pro-1');
  assert.equal(r.token, SECRET);
});

test('a single-phone setup with only ANDROID_MCP_URL/ANDROID_MCP_TOKEN keeps working', () => {
  const env = { ANDROID_MCP_URL: 'http://phone.example:8080/mcp', ANDROID_MCP_TOKEN: SECRET };
  const r = resolveDevice({ request: {}, env, devices: [] });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
  assert.equal(r.tokenEnv, 'ANDROID_MCP_TOKEN');
});

test('explicit request fields still win over everything resolved', () => {
  const env = { ANDROID_MCP_TOKEN_BEAM_PRO_1: 'from-env' };
  const r = resolveDevice({ request: { deviceUrl: 'http://other:8080/mcp', deviceToken: 'from-request' }, env, devices: DEVICES });
  assert.equal(r.url, 'http://other:8080/mcp');
  assert.equal(r.token, 'from-request');
  assert.equal(r.tokenEnv, null, 'a request-supplied token came from no variable');
});

test('an explicit URL with no token of its own still resolves the token from the environment', () => {
  const env = { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET };
  const r = resolveDevice({
    request: { deviceUrl: 'http://beam-pro-1.capybara-ulmer.ts.net:8080/mcp' },
    env,
    devices: DEVICES,
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
});

test('a known fleet with no token set names each device\'s token variable', () => {
  const r = resolveDevice({ request: {}, env: {}, devices: DEVICES });
  assert.equal(r.ok, false);
  assert.match(r.remediation, /ANDROID_MCP_TOKEN_BEAM_PRO_1/);
  assert.match(r.remediation, /ANDROID_MCP_TOKEN_TAB_S8_ULTRA/);
  assert.match(r.remediation, /beam-pro-1/);
});

test('an empty registry falls back to the single-phone variables, not an empty list', () => {
  const r = resolveDevice({ request: {}, env: {}, devices: [] });
  assert.equal(r.ok, false);
  assert.match(r.remediation, /ANDROID_MCP_URL/);
  assert.match(r.remediation, /ANDROID_MCP_TOKEN/);
  assert.doesNotMatch(r.remediation, /\(none/);
});

test('a known device whose token is missing names that exact variable', () => {
  const r = resolveDevice({ request: { device: 'beam-pro-1' }, env: {}, devices: DEVICES });
  assert.equal(r.ok, false);
  assert.match(r.remediation, /ANDROID_MCP_TOKEN_BEAM_PRO_1/);
  assert.match(r.error, /token/i);
});

// Guessing here would drive the wrong phone — the one on the desk rather than the one in the
// cradle — and produce a capture that looks fine until someone opens the photos.
test('two configured phones and no choice made is a question, not a coin toss', () => {
  const env = { ANDROID_MCP_TOKEN_TAB_S8_ULTRA: 'a', ANDROID_MCP_TOKEN_BEAM_PRO_1: 'b' };
  const r = resolveDevice({ request: {}, env, devices: DEVICES });
  assert.equal(r.ok, false);
  assert.match(r.error, /More than one phone/);
  assert.match(r.remediation, /ANDROID_MCP_DEVICE=/);
});

test('an unknown device name is refused with the list of known ones', () => {
  const r = resolveDevice({ request: { device: 'pixel-9' }, env: { ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET }, devices: DEVICES });
  assert.equal(r.ok, false);
  assert.match(r.error, /pixel-9/);
  assert.match(r.remediation, /beam-pro-1, tab-s8-ultra/);
});

// A refusal is the one path that gets pasted into a chat window, a ticket, or a screenshot.
test('no refusal ever carries a token value', () => {
  const env = {
    ANDROID_MCP_TOKEN: SECRET,
    ANDROID_MCP_TOKEN_TAB_S8_ULTRA: SECRET,
    ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET,
  };
  const refusals = [
    resolveDevice({ request: {}, env: {}, devices: DEVICES }),
    resolveDevice({ request: { device: 'beam-pro-1' }, env: {}, devices: DEVICES }),
    resolveDevice({ request: {}, env, devices: DEVICES }),
    resolveDevice({ request: { device: 'pixel-9' }, env, devices: DEVICES }),
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(SECRET), `refusal leaked a token: ${r.error}`);
  }
});
