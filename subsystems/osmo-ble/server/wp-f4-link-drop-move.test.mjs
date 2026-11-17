import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { OsmoBleTransport } from './ble-transport.mjs';

// F4-5: a move whose link drops under it ends as cancelled, not as a 500, when the link is gone before its stop
// write. Driven through the real request handler of server/backend.mjs with nothing listening. The link flags are
// stubbed, and a drop goes through the transport's own reset, so the stop write meets the same empty write path
// it meets in production. No BLE, no gimbal, no port.
process.env.BACKEND_NO_LISTEN = '1';

let linkUp = true;
Object.defineProperty(OsmoBleTransport.prototype, 'connected', { get: () => linkUp, configurable: true });
Object.defineProperty(OsmoBleTransport.prototype, 'linked', { get: () => linkUp, configurable: true });

const { server, setScanStateForTest, transportForTest } = await import('./backend.mjs');
const transport = transportForTest();

/** A level pose (pan 0, tilt 0), so a move to pan 120 has far to go and drives. */
const LEVEL = [0, 0, 0, 1];
/** A short move: the tick and settle are brief, so the stop write comes quickly. */
const MOVE = { yawDeg: 120, pitchDeg: 0, maxMs: 4000, tickMs: 10, settleMs: 10 };

/** Every frame that reached the characteristic, in order. */
const sent = [];
let writes = 0;
/** Runs as each write is issued, so a test can drop the link at a chosen write. */
let onWrite = () => {};
const healthy = {
  writeAsync: async (bytes) => {
    writes += 1;
    sent.push(Uint8Array.from(bytes));
    onWrite(writes);
  },
};

/**
 * The link goes, as it does in production: the transport forgets its write path (this is what makes the stop
 * write find no characteristic), and when announced, the 'disconnect' event that cancels outside motions goes out.
 */
function dropLink({ announce = true } = {}) {
  linkUp = false;
  transport._resetLinkState();
  if (announce) transport.emit('disconnect');
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

beforeEach(() => {
  sent.length = 0;
  writes = 0;
  onWrite = () => {};
  linkUp = true;
  setScanStateForTest({ scanRunning: false });
  transport.lastQuaternion = LEVEL;
  transport._writeChar = null;
  transport._writeCandidates = [{ characteristic: healthy, withResponse: false, uuid: 'fff5' }];
});

test('F4-5: a move whose link drops before its stop write ends as cancelled, not as a 500', async () => {
  onWrite = (n) => { if (n === 1) dropLink(); }; // the link goes during the first tick
  const r = await call('POST', '/api/move-to', MOVE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cancelled, true);
  assert.equal(r.body.converged, false);
  assert.equal(sent.length, 1, 'only the tick speed reached a characteristic; the stop had no link to go over');
});

test('F4-5: an arc probe whose move is cut short by a link reset says so, and measures nothing', async () => {
  onWrite = (n) => { if (n === 1) dropLink(); };
  const r = await call('POST', '/api/arc-probe', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /link was reset/);
  assert.equal(r.body.arc.source, 'default', 'nothing was measured, so the fallback stays in place');
});

test('F4-5: a stop that finds the link already down is a cancelled move, even before the disconnect event arrives', async () => {
  onWrite = (n) => { if (n === 1) dropLink({ announce: false }); };
  const r = await call('POST', '/api/move-to', MOVE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cancelled, true);
});

test('F4-5 control: a stop that fails while the link is still up is still an error', async () => {
  onWrite = (n) => { if (n === 2) throw new Error('the device rejected the stop write'); };
  const r = await call('POST', '/api/move-to', MOVE);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.match(r.body.error, /rejected the stop write/);
});
