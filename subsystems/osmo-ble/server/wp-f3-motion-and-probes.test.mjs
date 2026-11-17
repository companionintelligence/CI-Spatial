import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { OsmoBleTransport } from './ble-transport.mjs';
import { decodeFrame } from '../protocol/duml.mjs';
import { CMD_SET, CMD_ID, GIMBAL_MODE } from '../protocol/constants.mjs';
import { buildGimbalSetMode } from '../protocol/commands.mjs';

// The outside motions (move-to, command probe), the capture interlock and the orientation route, through
// the real request handler of server/backend.mjs. Nothing listens (BACKEND_NO_LISTEN). The transport is
// the real one, with the link reported as up and its write characteristic replaced by a stub, so a write
// can answer, or never return. The phone's MCP endpoint is a stubbed fetch, so there is no network.
process.env.BACKEND_NO_LISTEN = '1';
process.env.BACKEND_TEST_ROUTES = '1';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ANDROID_MCP_')) delete process.env[name];
}
process.env.ANDROID_MCP_ENV_FILE = ''; // never read the repo's .env from a test
process.env.ANDROID_MCP_CONFIG = '/nonexistent/wp-f3-no-device-registry.json';

Object.defineProperty(OsmoBleTransport.prototype, 'connected', { get: () => true, configurable: true });
Object.defineProperty(OsmoBleTransport.prototype, 'linked', { get: () => true, configurable: true });

const backend = await import('./backend.mjs');
const { server, setScanStateForTest, transportForTest, externalMotionCountForTest } = backend;
const transport = transportForTest();

/** Every frame that reached a characteristic that answers, in order. */
const sent = [];
const healthy = { writeAsync: async (bytes) => { sent.push(Uint8Array.from(bytes)); } };
/** A write that never answers: the link has gone silent under it. */
let hungWrites = 0;
const hung = { writeAsync: () => { hungWrites += 1; return new Promise(() => {}); } };

function useHealthyLink() {
  transport._writeChar = null;
  transport._writeCandidates = [{ characteristic: healthy, withResponse: false, uuid: 'fff5' }];
}
function useHungLink() {
  transport._writeChar = null;
  transport._writeCandidates = [{ characteristic: hung, withResponse: false, uuid: 'fff5' }];
}

/**
 * One request through the real handler. A streamed (NDJSON) response comes back as an array of
 * events, anything else as parsed JSON.
 */
function call(method, path, body) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost:8788' };
    const chunks = [];
    let contentType = 'application/json';
    const res = {
      headersSent: false,
      writeHead(code, headers = {}) {
        this.statusCode = code;
        this.headersSent = true;
        contentType = headers['Content-Type'] ?? contentType;
      },
      write(chunk) {
        chunks.push(String(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(String(chunk));
        const text = chunks.join('');
        const body = contentType === 'application/x-ndjson'
          ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
          : JSON.parse(text || 'null');
        resolve({ status: this.statusCode, body });
      },
    };
    server.emit('request', req, res);
  });
}

async function until(check, ms = 3000) {
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

/** The payload of a setMode frame for `mode`, to compare against what was sent. */
function modePayload(mode) {
  return Array.from(decodeFrame(buildGimbalSetMode(0, mode)).payload);
}

// A pose the closed loop can act on: quaternion [x, y, z, w] for pan 0, tilt 0.
const LEVEL = [0, 0, 0, 1];
// A capture of one position with no photos, short enough to finish within a test.
const GRID_NO_PHOTOS = { pans: [120], tilts: [0], capturePhotos: false, probeArc: false, maxMs: 200, dwellMs: 1 };

// The phone's MCP endpoint, stubbed. It answers the calls the backend makes and records photos.
const PHONE = 'http://fake-phone.test:8080/mcp';
const TOKEN = 'wp-f3-test-token';
const phone = { saves: 0 };
const jsonResponse = (body, headers = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
});
globalThis.fetch = async (url, init = {}) => {
  if (url !== PHONE) throw new Error(`wp-f3 test made a network call to ${url}`);
  if (init.method === 'DELETE') return new Response('', { status: 200 });
  const msg = JSON.parse(init.body);
  if (msg.method === 'initialize') {
    return jsonResponse(
      { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-phone' } } },
      { 'mcp-session-id': 'wp-f3-session' },
    );
  }
  if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
  if (msg.method === 'tools/call') {
    if (msg.params.name === 'android_save_camera_photo') phone.saves += 1;
    const text = msg.params.name === 'android_share_file_via_web' ? 'http://fake-phone.test:8080/s/wp-f3.jpg' : 'ok';
    return jsonResponse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
  }
  throw new Error(`wp-f3 test saw an unexpected MCP call: ${msg.method}`);
};

beforeEach(() => {
  sent.length = 0;
  hungWrites = 0;
  phone.saves = 0;
  setScanStateForTest({ scanRunning: false });
  transport.lastQuaternion = null;
  useHealthyLink();
});

// ── F3-3: a write that never returns cannot hold the capture interlock ─────────────────────────────

test('F3-3: a move whose write never answers ends at the write cap, and does not hold the capture interlock', { timeout: 15000 }, async () => {
  transport.lastQuaternion = LEVEL;
  useHungLink();
  const started = Date.now();
  const moved = await call('POST', '/api/move-to', { yawDeg: 120, pitchDeg: 0, maxMs: 4000 });
  assert.equal(moved.status, 500, JSON.stringify(moved.body));
  assert.match(moved.body.error, /no answer to a write/);
  assert.ok(Date.now() - started < 9000, 'the move ends at the write cap, not when a write finally returns');

  useHealthyLink();
  const grid = await call('POST', '/api/grid-capture', GRID_NO_PHOTOS);
  assert.equal(grid.status, 200, JSON.stringify(grid.body));
  assert.equal(grid.body[0].phase, 'start', 'a finished move must not leave a capture refused as driving the gimbal');
});

test('F3-3: a link teardown releases the capture interlock at once, even while a write is still hung', { timeout: 15000 }, async () => {
  transport.lastQuaternion = LEVEL;
  useHungLink();
  const pending = call('POST', '/api/move-to', { yawDeg: 120, pitchDeg: 0, maxMs: 4000 });
  await until(() => hungWrites === 1);

  transport.emit('disconnect'); // the link goes while the write is still hung
  useHealthyLink();
  const grid = await call('POST', '/api/grid-capture', GRID_NO_PHOTOS);
  assert.equal(grid.status, 200, JSON.stringify(grid.body));
  assert.equal(grid.body[0].phase, 'start', 'the teardown released the interlock, not the write cap');

  const moved = await pending;
  assert.equal(moved.status, 500, 'the hung write still fails at its cap, and that move ends with it');
});

test('F3-3: a move bound to a link that goes stops, and does not resume on the next link', { timeout: 15000 }, async () => {
  transport.lastQuaternion = null; // nothing to act on yet, so the move is between ticks
  const pending = call('POST', '/api/move-to', { yawDeg: 120, pitchDeg: 0, maxMs: 4000 });
  await until(() => externalMotionCountForTest() === 1); // the move is running, and bound to this link

  transport.emit('disconnect');
  transport.lastQuaternion = LEVEL; // a pose arrives on the next link before the loop wakes
  const moved = await pending;
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.cancelled, true);
  assert.ok(sent.length > 0, 'the cancelled move sent its stop, so the check below is not vacuous');
  assert.ok(sent.every(isZeroSpeedFrame), 'the cancelled move sent no speed on the new link, only a stop');
});

// ── F3-4: grid-advance does not overlap an outside move that is still driving ───────────────────────

test('F3-4: grid-advance is refused while an outside move is still driving, and succeeds once it has ended', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true, parked: true });
  const move = call('POST', '/api/move-to', { yawDeg: 120, pitchDeg: 0, maxMs: 1500 });
  await until(() => externalMotionCountForTest() === 1); // the move is still driving when the advance arrives

  const refused = await call('POST', '/api/grid-advance');
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /still driving the gimbal/);
  assert.equal((await move).status, 200);

  const advanced = await call('POST', '/api/grid-advance');
  assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
});

// ── F3-5: a stop that cannot stop the gimbal is refused before the probe's speed goes out ───────────

test('F3-5: a probe whose stop cannot stop the gimbal is a 400, and nothing is sent', { timeout: 10000 }, async () => {
  transport.lastQuaternion = LEVEL;
  for (const stop of [{}, { type: 'bogus' }, { type: 'speed', params: { yawDegPerSec: 30 } }]) {
    const r = await call('POST', '/api/test/command-probe', { type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 10, stop });
    assert.equal(r.status, 400, `${JSON.stringify(stop)}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.remediation, 'the refusal says what a valid stop looks like');
    assert.equal(sent.length, 0, `no frame reached the gimbal for ${JSON.stringify(stop)}`);
  }
});

test('F3-5: a zero-speed stop is accepted, and the probe ends on it', { timeout: 10000 }, async () => {
  const r = await call('POST', '/api/test/command-probe', {
    type: 'speed', params: { yawDegPerSec: 30 }, waitMs: 10, stop: { type: 'speed', params: {} },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 2, 'the probe speed, then the stop');
  assert.equal(isZeroSpeedFrame(sent[1]), true);
});

// ── F3-6: the orientation changes that the capture route and the one-off photo route make ──────────

test('F3-6: capture-photo with bothOrientations is refused with a 409 during an unparked scan, before any photo', { timeout: 10000 }, async () => {
  setScanStateForTest({ scanRunning: true });
  const r = await call('POST', '/api/capture-photo', { bothOrientations: true, deviceUrl: PHONE, deviceToken: TOKEN });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /owns the gimbal/);
  assert.equal(sent.length, 0, 'the orientation change was refused, so nothing reached the gimbal');
  assert.equal(phone.saves, 0, 'and no photo was taken');
});

test('F3-6: capture-photo with bothOrientations takes both shots when no scan runs', { timeout: 10000 }, async () => {
  const r = await call('POST', '/api/capture-photo', { bothOrientations: true, deviceUrl: PHONE, deviceToken: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.shots.length, 2);
  assert.equal(phone.saves, 2);
});

test('F3-6: a capture\'s own orientation changes go out while the scan it runs is running', { timeout: 10000 }, async () => {
  transport.lastQuaternion = LEVEL;
  const events = await call('POST', '/api/grid-capture', {
    pans: [120], tilts: [0], bothOrientations: true, capturePhotos: true,
    deviceUrl: PHONE, deviceToken: TOKEN, probeArc: false, maxMs: 200, dwellMs: 1,
  });
  assert.equal(events.status, 200);
  const refusals = events.body.filter((e) => e.phase === 'error');
  assert.deepEqual(refusals, [], 'the run itself was not refused');
  assert.equal(events.body.at(-1).phase, 'done');
  assert.equal(phone.saves, 2, 'one landscape and one portrait shot');

  const modes = sent
    .map((bytes) => decodeFrame(bytes))
    .filter((f) => f.cmdSet === CMD_SET.GIMBAL_FN && f.cmdId === CMD_ID.GIMBAL_SET_WORK_MODE)
    .map((f) => Array.from(f.payload));
  assert.deepEqual(modes, [modePayload(GIMBAL_MODE.FOLLOW), modePayload(GIMBAL_MODE.LOCK)]);
});
