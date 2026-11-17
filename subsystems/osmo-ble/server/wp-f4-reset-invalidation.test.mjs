import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { OsmoBleTransport } from './ble-transport.mjs';
import { makeArc } from '../protocol/dome.mjs';

// F4-1: a reset whose write times out still forgets the measured pan arc, and the route still reports the
// failure. Driven through the real request handler of server/backend.mjs with nothing listening. The link is
// reported as up, and the write goes through the real sendRaw(), so the 2 s cap in ble-transport.mjs is the
// one that fires. No BLE, no gimbal, no port.
process.env.BACKEND_NO_LISTEN = '1';

let linkUp = true;
Object.defineProperty(OsmoBleTransport.prototype, 'connected', { get: () => linkUp, configurable: true });
Object.defineProperty(OsmoBleTransport.prototype, 'linked', { get: () => linkUp, configurable: true });

const { server, setScanStateForTest, setMeasuredArcForTest, transportForTest } = await import('./backend.mjs');
const transport = transportForTest();

/** A write that is accepted at once, and one that never answers, so the real cap is what ends it. */
const answering = { writeAsync: async () => {} };
const silent = { writeAsync: () => new Promise(() => {}) };
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

beforeEach(() => {
  linkUp = true;
  setScanStateForTest({ scanRunning: false });
  setMeasuredArcForTest(null);
  useCharacteristic(answering);
});

test('F4-1: a reset whose write times out still forgets the measured arc, and the route reports the failure', { timeout: 10000 }, async () => {
  measuredNow();
  useCharacteristic(silent);
  const r = await call('POST', '/api/command', { type: 'resetAndCenter', params: {} });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.match(r.body.error, /no answer to a write on fff5/);
  const arc = await panArc();
  assert.equal(arc.source, 'default', 'the reset may have reached the gimbal, so the measured datum is no longer trusted');
  assert.match(arc.unmeasuredReason, /gimbal was reset/);
});

test('F4-1: a reset that goes out forgets the measured arc', async () => {
  measuredNow();
  const r = await call('POST', '/api/command', { type: 'resetAndCenter', params: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await panArc()).source, 'default');
});

test('F4-1: a reset the interlock refuses forgets nothing, because nothing was sent', async () => {
  measuredNow();
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/command', { type: 'resetAndCenter', params: {} });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal((await panArc()).source, 'measured');
});

test('F4-1 control: a plain recenter leaves the measured arc alone', async () => {
  measuredNow();
  const r = await call('POST', '/api/command', { type: 'recenter', params: { durationSeconds: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await panArc()).source, 'measured');
});
