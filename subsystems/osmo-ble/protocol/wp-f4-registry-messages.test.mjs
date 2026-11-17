import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDevice } from './device_registry.mjs';

// F4-4: the refusals for an operator's ANDROID_MCP_URL when a phone is named but has no .mcp.json entry. A URL for
// the named phone whose token is missing gets its own message. A URL for another phone says why it was not used.
// Both state the host-label rule. No refusal carries a token.
const BEAM = 'http://beam-pro-1.example.ts.net:8080/mcp';
const TAB = 'http://tab-s8-ultra.example.ts.net:8080/mcp';
const SECRET = 'sk-not-a-real-token-0123456789';
const SHARED = 'sk-not-a-real-shared-0123456789';

test('F4-4: a URL for the named phone, with that phone\'s token missing, says so rather than that the phone is unknown', () => {
  const r = resolveDevice({ request: { device: 'beam-pro-1' }, env: { ANDROID_MCP_URL: BEAM }, devices: [] });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /No phone named/);
  assert.match(r.error, /ANDROID_MCP_URL is for "beam-pro-1"/);
  assert.match(r.error, /ANDROID_MCP_TOKEN_BEAM_PRO_1 is not set/);
  assert.match(r.remediation, /Export ANDROID_MCP_TOKEN_BEAM_PRO_1/);
  assert.match(r.remediation, /first label of its host name/);
});

test('F4-4: a shared ANDROID_MCP_TOKEN does not rescue that refusal, because the named phone needs its own token', () => {
  const r = resolveDevice({
    request: { device: 'beam-pro-1' },
    env: { ANDROID_MCP_URL: BEAM, ANDROID_MCP_TOKEN: SHARED },
    devices: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ANDROID_MCP_TOKEN_BEAM_PRO_1 is not set/);
  assert.ok(!JSON.stringify(r).includes(SHARED), 'the refusal carries no token');
});

test('F4-4: a URL for another phone is not used for the named one, and the refusal says why', () => {
  const r = resolveDevice({
    request: { device: 'beam-pro-1' },
    env: { ANDROID_MCP_URL: TAB, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /No phone named "beam-pro-1" is configured/);
  assert.match(r.remediation, /ANDROID_MCP_URL is for "tab-s8-ultra"/);
  assert.match(r.remediation, /first label of its host name/);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'the refusal carries no token');
});

test('F4-4 control: the named phone\'s own URL and token resolve', () => {
  const r = resolveDevice({
    request: { device: 'beam-pro-1' },
    env: { ANDROID_MCP_URL: BEAM, ANDROID_MCP_TOKEN_BEAM_PRO_1: SECRET },
    devices: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.token, SECRET);
  assert.equal(r.url, BEAM);
});
