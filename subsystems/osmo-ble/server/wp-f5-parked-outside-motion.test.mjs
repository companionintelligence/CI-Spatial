import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { OsmoBleTransport } from './ble-transport.mjs';
import { decodeFrame } from '../protocol/duml.mjs';
import { CMD_SET, CMD_ID } from '../protocol/constants.mjs';

// F5-1 through the real request handler of server/backend.mjs. While a scan is parked, a move or probe the backend
// started is still driving the same two motors, so nothing may join it except a stop. Nothing listens
// (BACKEND_NO_LISTEN). The transport is the real one, with the link reported as up and its write characteristic
// replaced by a stub, so every frame that reaches the gimbal is recorded here. The phone is never called.
process.env.BACKEND_NO_LISTEN = '1';
process.env.BACKEND_TEST_ROUTES = '1';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ANDROID_MCP_')) delete process.env[name];
}
process.env.ANDROID_MCP_ENV_FILE = ''; // never read the repo's .env from a test
process.env.ANDROID_MCP_CONFIG = '/nonexistent/wp-f5-no-device-registry.json';

Object.defineProperty(OsmoBleTransport.prototype, 'connected', { get: () => true, configurable: true });
Object.defineProperty(OsmoBleTransport.prototype, 'linked', { get: () => true, configurable: true });

const backend = await import('./backend.mjs');
const { server, setScanStateForTest, transportForTest, externalMotionCountForTest } = backend;
const transport = transportForTest();

/** Every frame that reached a characteristic that answers, in order. */
const sent = [];
const healthy = { writeAsync: async (bytes) => { sent.push(Uint8Array.from(bytes)); } };
function useHealthyLink() {
  transport._writeChar = null;
  transport._writeCandidates = [{ characteristic: healthy, withResponse: false, uuid: 'fff5' }];
}

/** One request through the real handler, answered as JSON. */
function call(method, path, body) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
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
    server.emit('request', req, res);
  });
}

async function until(check, ms = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the request to register');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isZeroSpeedFrame(bytes) {
  const f = decodeFrame(bytes);
  return f.cmdSet === CMD_SET.GIMBAL_FN && f.cmdId === CMD_ID.GIMBAL_SPEED_CTRL && f.payload.slice(0, 6).every((b) => b === 0);
}

/**
 * Start an outside move and wait until it is registered as driving the gimbal. With no pose to steer on, the move
 * waits between ticks and sends nothing, so it stays in flight until maxMs without touching `sent`.
 * Returns the pending request, not awaited, so the test decides when it ends.
 */
async function startOutsideMove(maxMs) {
  const pending = call('POST', '/api/move-to', { yawDeg: 120, pitchDeg: 0, maxMs, tickMs: 20 });
  await until(() => externalMotionCountForTest() === 1);
  return { pending };
}

beforeEach(() => {
  sent.length = 0;
  setScanStateForTest({ scanRunning: false });
  transport.lastQuaternion = null;
  useHealthyLink();
});

test('F5-1: a joystick speed is refused with a 409 while a parked scan has an outside move still driving', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const { pending: move } = await startOutsideMove(2500);
  const before = sent.length;
  const r = await call('POST', '/api/command', { type: 'speed', params: { yawDegPerSec: 30 } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /still driving the gimbal/);
  assert.match(r.body.remediation, /stops on its own/);
  assert.equal(sent.length, before, 'the refused speed reached no characteristic');
  assert.equal((await move).status, 200);
});

test('F5-1: a recenter, a reset, a mode change, a stick-on and an absolute angle are all refused while the outside move drives; a stop is not', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const { pending: move } = await startOutsideMove(3000);
  const before = sent.length;
  const refused = [
    { type: 'recenter', params: { durationSeconds: 1 } },
    { type: 'resetAndCenter', params: {} },
    { type: 'setMode', params: { mode: 'follow' } },
    { type: 'stickControlEnable', params: { enable: true } },
    { type: 'absoluteAngle', params: { yawDeg: 20 } },
  ];
  for (const body of refused) {
    const r = await call('POST', '/api/command', body);
    assert.equal(r.status, 409, body.type + ': ' + JSON.stringify(r.body));
  }
  assert.equal(sent.length, before, 'nothing that moves the gimbal reached it');

  const stop = await call('POST', '/api/command', { type: 'speed', params: {} });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const fresh = sent.slice(before);
  assert.ok(fresh.length >= 1, 'the stop went out');
  assert.ok(fresh.every(isZeroSpeedFrame), 'only zero-speed frames went out while the move was driving');
  assert.equal((await move).status, 200);
});

test('F5-1: a second move-to and an arc probe are refused while a parked scan has an outside move still driving', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const { pending: move } = await startOutsideMove(2500);
  const arc = await call('POST', '/api/arc-probe', {});
  assert.equal(arc.status, 409, JSON.stringify(arc.body));
  assert.match(arc.body.error, /still driving the gimbal/);
  const second = await call('POST', '/api/move-to', { yawDeg: 40, pitchDeg: 0, maxMs: 50 });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(second.body.error, /still driving the gimbal/);
  assert.equal(sent.length, 0, 'neither refused request reached the gimbal');
  assert.equal((await move).status, 200);
});

test('F5-1: once the outside move has ended, a parked scan lets a joystick speed through again', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const { pending: move } = await startOutsideMove(300);
  assert.equal((await move).status, 200);
  const r = await call('POST', '/api/command', { type: 'speed', params: { yawDegPerSec: 30 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 1 + 1, 'the move ended with its own stop, then the speed went out');
});

test('F5-1 control: a parked scan with nothing outside still lets a joystick speed through', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const r = await call('POST', '/api/command', { type: 'speed', params: { yawDegPerSec: 30 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 1);
});

test('F5-1: a probe does not refuse its own speed or its own stop, while a parked scan has nothing else driving', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const r = await call('POST', '/api/test/command-probe', { type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 2, 'the probe speed, then its stop');
  assert.equal(isZeroSpeedFrame(sent[1]), true);
});

test('F5-1: a recenter probe does not refuse its own recenter while a parked scan has nothing else driving', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const r = await call('POST', '/api/test/recenter-probe', { durationSeconds: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 1, 'the recenter went out');
});

test('F5-1: a second probe is refused while a first probe is still driving a parked scan, and the first one finishes', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const first = call('POST', '/api/test/command-probe', { type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 400 });
  await until(() => externalMotionCountForTest() === 1);
  const second = await call('POST', '/api/test/command-probe', { type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 10 });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(second.body.error, /still driving the gimbal/);
  const done = await first;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(sent.length, 2, 'only the first probe reached the gimbal: its speed, then its stop');
});
