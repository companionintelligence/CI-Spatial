import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { OsmoBleTransport } from './ble-transport.mjs';
import { decodeFrame } from '../protocol/duml.mjs';
import { CMD_SET, CMD_ID } from '../protocol/constants.mjs';

// The motion interlock, through the real request handler and route table of server/backend.mjs.
// Nothing listens: BACKEND_NO_LISTEN makes the module skip listen(), and each request is emitted at
// the module's own `server` with fake request and response objects. The transport is stubbed to
// report linked and to record every frame it would have written. No BLE, no gimbal, no port.
process.env.BACKEND_NO_LISTEN = '1';
process.env.BACKEND_TEST_ROUTES = '1';

/** Every frame the backend would have written to the gimbal, in order. */
const sent = [];
Object.defineProperty(OsmoBleTransport.prototype, 'connected', { get: () => true, configurable: true });
Object.defineProperty(OsmoBleTransport.prototype, 'linked', { get: () => true, configurable: true });
OsmoBleTransport.prototype.sendRaw = async function sendRaw(frame) {
  sent.push(Uint8Array.from(frame));
};

const backend = await import('./backend.mjs');
const { server, setScanStateForTest } = backend;

/**
 * One request through the real handler. `stream` lets a test hold the body open, so a scan can
 * start while the request is still arriving.
 */
function callOn(target, method, path, body, { stream } = {}) {
  return new Promise((resolve) => {
    const req = stream ?? Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost:8788' };
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(code) {
        this.statusCode = code;
        this.headersSent = true;
      },
      write(chunk) {
        chunks.push(String(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(String(chunk));
        resolve({ status: this.statusCode, body: JSON.parse(chunks.join('') || 'null') });
      },
    };
    target.emit('request', req, res);
  });
}
const call = (method, path, body, opts) => callOn(server, method, path, body, opts);

async function until(check, ms = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the request to reach the transport');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isZeroSpeedFrame(bytes) {
  const f = decodeFrame(bytes);
  return f.cmdSet === CMD_SET.GIMBAL_FN && f.cmdId === CMD_ID.GIMBAL_SPEED_CTRL && f.payload.slice(0, 6).every((b) => b === 0);
}

beforeEach(() => {
  sent.length = 0;
  setScanStateForTest({ scanRunning: false });
});

test('a running scan refuses an outside speed command with a 409, and nothing reaches the gimbal', async () => {
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/command', { type: 'speed', params: { yawDegPerSec: 30 } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /owns the gimbal/);
  assert.equal(sent.length, 0);
});

test('a running scan still lets a zero-speed stop through to the gimbal', async () => {
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/command', { type: 'speed', params: {} });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(isZeroSpeedFrame(sent[0]), true);
});

test('turning the stick on during a scan is a 409 with no enable value too, because the default is on', async () => {
  setScanStateForTest({ scanRunning: true });
  const on = await call('POST', '/api/command', { type: 'stickControlEnable', params: { enable: true } });
  assert.equal(on.status, 409);
  const byDefault = await call('POST', '/api/command', { type: 'stickControlEnable', params: {} });
  assert.equal(byDefault.status, 409);
  assert.equal(sent.length, 0);
});

test('turning the stick off during a scan is allowed', async () => {
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/command', { type: 'stickControlEnable', params: { enable: false } });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
});

test('a parked scan lets an outside speed command through, because nothing is controlling the motors', async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const r = await call('POST', '/api/command', { type: 'speed', params: { yawDegPerSec: 30 } });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
});

test('with no scan running, an outside speed command goes out', async () => {
  const r = await call('POST', '/api/command', { type: 'speed', params: { yawDegPerSec: 30 } });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
});

test('a closed-loop move is refused with a 409 while a scan runs unparked', async () => {
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/move-to', { yawDeg: 10, pitchDeg: 0, maxMs: 50 });
  assert.equal(r.status, 409);
  assert.equal(sent.length, 0);
});

test('a move-to is refused when a scan starts while its body is still arriving', async () => {
  // The scan state is checked after the body is read, so a scan that begins mid-request still wins.
  const body = new Readable({ read() {} });
  const pending = call('POST', '/api/move-to', undefined, { stream: body });
  setScanStateForTest({ scanRunning: true });
  body.push(JSON.stringify({ yawDeg: 10, pitchDeg: 0, maxMs: 50 }));
  body.push(null);
  const r = await pending;
  assert.equal(r.status, 409);
  assert.equal(sent.length, 0);
});

test('a malformed raw payloadHex is a 400 from the route, not a 500, and nothing is sent', async () => {
  const r = await call('POST', '/api/command', {
    type: 'raw', params: { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: 'abc' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.remediation, /hex pairs/);
  assert.equal(sent.length, 0);
});

test('a command probe with no stop still ends on a zero-speed stop, so no speed stays latched', async () => {
  const r = await call('POST', '/api/test/command-probe', { type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 10 });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 2);
  assert.equal(isZeroSpeedFrame(sent[0]), false);
  assert.equal(isZeroSpeedFrame(sent[1]), true);
});

test('a capture will not start while a command probe is still driving the gimbal', async () => {
  const probe = call('POST', '/api/test/command-probe', { type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 300 });
  await until(() => sent.length >= 1);
  // Pan 120 is inside the reachable arc (+82 through 180 to -100); pan 0 is in the dead zone.
  const refused = await call('POST', '/api/grid-capture', { pans: [120], tilts: [0], capturePhotos: false });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /still driving the gimbal/);
  const done = await probe;
  assert.equal(done.status, 200);
});

test('with BACKEND_TEST_ROUTES off, a test route says it is disabled rather than that no route exists', async () => {
  process.env.BACKEND_TEST_ROUTES = '0';
  const off = await import('./backend.mjs?test-routes=off');
  process.env.BACKEND_TEST_ROUTES = '1';
  const r = await callOn(off.server, 'POST', '/api/test/command-probe', { type: 'speed', params: {} });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /Test route disabled/);
  assert.equal(sent.length, 0);
});
