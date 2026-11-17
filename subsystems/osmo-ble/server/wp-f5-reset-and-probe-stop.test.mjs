import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { OsmoBleTransport } from './ble-transport.mjs';
import { decodeFrame } from '../protocol/duml.mjs';
import { CMD_SET, CMD_ID } from '../protocol/constants.mjs';
import { makeArc } from '../protocol/dome.mjs';

// F5-2 and F5-7 through the real request handler of server/backend.mjs.
//
// F5-2: a reset is recognised from the frame that leaves the process, so every route that sends one forgets the
// measured pan arc: the named command, a raw frame and a probe alike.
// F5-7: the command probe ends on a zero-speed stop for every command type when no stop is given, not only speeds.
//
// Nothing listens (BACKEND_NO_LISTEN). The transport is the real one, with its write characteristic replaced by a
// stub, so a write can answer, or never return. No BLE, no gimbal, no network.
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
const { server, setScanStateForTest, setMeasuredArcForTest, transportForTest } = backend;
const transport = transportForTest();

/** Every frame that reached a characteristic that answers, in order. */
const sent = [];
const healthy = { writeAsync: async (bytes) => { sent.push(Uint8Array.from(bytes)); } };
/** A write that never answers: the link has gone silent under it. */
const hung = { writeAsync: () => new Promise(() => {}) };
function useCharacteristic(characteristic) {
  transport._writeChar = null;
  transport._writeCandidates = [{ characteristic, withResponse: false, uuid: 'fff5' }];
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

/** Put a measured arc in place, as a probe that just finished would have. */
function measuredNow() {
  setMeasuredArcForTest(makeArc({ startDeg: 10, endDeg: 100, source: 'measured', measuredAt: Date.now() }));
}

/** The arc block the status payload reports, which says whether the arc is still measured. */
async function panArc() {
  return (await call('GET', '/api/status')).body.panArc;
}

function isZeroSpeedFrame(bytes) {
  const f = decodeFrame(bytes);
  return f.cmdSet === CMD_SET.GIMBAL_FN && f.cmdId === CMD_ID.GIMBAL_SPEED_CTRL && f.payload.slice(0, 6).every((b) => b === 0);
}

/** The gimbal-function reset-and-centre frame, sent as a raw frame the way a caller who knows the bytes would. */
const RAW_RESET = { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_RESET_AND_CENTER, payloadHex: '0100' };

beforeEach(() => {
  sent.length = 0;
  setScanStateForTest({ scanRunning: false });
  setMeasuredArcForTest(null);
  useCharacteristic(healthy);
});

// ── F5-2: a reset is judged from the frame, so a raw reset and a probe's reset invalidate the arc ──────────

test('F5-2: a reset sent as a raw frame forgets the measured arc, the same as the named reset', { timeout: 10000 }, async () => {
  measuredNow();
  const r = await call('POST', '/api/command', { type: 'raw', params: RAW_RESET });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 1, 'the raw frame went out');
  const f = decodeFrame(sent[0]);
  assert.equal(f.cmdSet, CMD_SET.GIMBAL_FN);
  assert.equal(f.cmdId, CMD_ID.GIMBAL_RESET_AND_CENTER, 'it really was the reset frame');
  const arc = await panArc();
  assert.equal(arc.source, 'default', 'the datum may have moved, so the measured arc is no longer trusted');
  assert.match(arc.unmeasuredReason, /gimbal was reset/);
});

test('F5-2: a raw reset whose write never answers still forgets the measured arc, and the route reports the failure', { timeout: 10000 }, async () => {
  measuredNow();
  useCharacteristic(hung);
  const r = await call('POST', '/api/command', { type: 'raw', params: RAW_RESET });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.match(r.body.error, /no answer to a write on fff5/);
  assert.equal((await panArc()).source, 'default', 'the reset may have reached the gimbal, so the datum is not trusted');
});

test('F5-2: a raw reset the interlock refuses forgets nothing, because nothing was sent', { timeout: 10000 }, async () => {
  measuredNow();
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/command', { type: 'raw', params: RAW_RESET });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(sent.length, 0, 'nothing reached the gimbal');
  assert.equal((await panArc()).source, 'measured');
});

test('F5-2: a command probe of a reset forgets the measured arc', { timeout: 10000 }, async () => {
  measuredNow();
  const r = await call('POST', '/api/test/command-probe', { type: 'resetAndCenter', params: {}, waitMs: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 2, 'the reset, then its trailing stop');
  assert.equal((await panArc()).source, 'default');
});

test('F5-2 control: a raw zero-speed stop is not a reset, so the measured arc stays', { timeout: 10000 }, async () => {
  measuredNow();
  const stop = { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, payloadHex: '0000000000000000' };
  const r = await call('POST', '/api/command', { type: 'raw', params: stop });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await panArc()).source, 'measured');
});

// ── F5-7: the command probe always ends on a zero-speed stop when the caller gives none ───────────────────

test('F5-7: a command probe of a non-speed type with no stop still ends on a zero-speed stop', { timeout: 10000 }, async () => {
  const r = await call('POST', '/api/test/command-probe', { type: 'setMode', params: { mode: 'follow' }, waitMs: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 2, 'the mode change, then the trailing stop');
  assert.equal(isZeroSpeedFrame(sent[0]), false, 'the probed command is not itself a stop');
  assert.equal(isZeroSpeedFrame(sent[1]), true, 'the trailing frame is a zero-speed stop');
});

test('F5-7: a recenter probe with no stop also ends on a zero-speed stop', { timeout: 10000 }, async () => {
  const r = await call('POST', '/api/test/command-probe', { type: 'recenter', params: { durationSeconds: 1 }, waitMs: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 2, 'the recenter, then the trailing stop');
  assert.equal(isZeroSpeedFrame(sent[1]), true);
});

test('F5-7: an explicit zero-speed stop given for a non-speed type is the trailing frame', { timeout: 10000 }, async () => {
  const r = await call('POST', '/api/test/command-probe', {
    type: 'setMode', params: { mode: 'lock' }, waitMs: 10, stop: { type: 'speed', params: {} },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 2, 'the mode change, then the given stop');
  assert.equal(isZeroSpeedFrame(sent[1]), true);
});
