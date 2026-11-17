import test from 'node:test';
import assert from 'node:assert/strict';
import { OsmoBleTransport } from './ble-transport.mjs';

// The link-lifetime races in OsmoBleTransport, with every BLE call replaced by a stub. No noble, no
// hardware: the transport is built with a fake noble, and the characteristics and peripherals below
// record what would have been written or torn down, in order.

const fakeNoble = { waitForPoweredOnAsync: async () => {} };

/** A write that does not finish until the test says so. */
function heldWrite(order, name) {
  let release;
  const characteristic = {
    writeAsync: () => {
      order.push(`${name}:start`);
      return new Promise((resolve) => {
        release = () => {
          order.push(`${name}:done`);
          resolve();
        };
      });
    },
  };
  return { characteristic, release: () => release() };
}

test('a teardown during a write does not latch the characteristic the write used (F13)', async () => {
  const transport = new OsmoBleTransport({ noble: fakeNoble });
  const order = [];
  const write = heldWrite(order, 'fff5');
  const candidate = { characteristic: write.characteristic, withResponse: false, uuid: 'fff5' };
  transport._writeCandidates = [candidate];

  const pending = transport.sendRaw(Uint8Array.from([0xaa, 0xbb]));
  transport._resetLinkState(); // the link is torn down while the frame is in flight
  write.release();
  await pending;

  assert.equal(transport._writeChar, null, 'a stale characteristic must not stay latched after a teardown');
});

test('a write that completes on the same link still latches its characteristic (F13 negative control)', async () => {
  const transport = new OsmoBleTransport({ noble: fakeNoble });
  const order = [];
  const write = heldWrite(order, 'fff5');
  const candidate = { characteristic: write.characteristic, withResponse: false, uuid: 'fff5' };
  transport._writeCandidates = [candidate];

  const pending = transport.sendRaw(Uint8Array.from([0xaa]));
  write.release();
  await pending;

  assert.equal(transport._writeChar, candidate);
});

test('a connect started during the stop window of a disconnect waits for that teardown (F12)', async () => {
  const transport = new OsmoBleTransport({ noble: fakeNoble });
  const order = [];
  const stop = heldWrite(order, 'stop');
  const oldCandidate = { characteristic: stop.characteristic, withResponse: false, uuid: 'fff5' };

  // The link that is up: linked, with a latched write characteristic and an old peripheral.
  Object.defineProperty(transport, 'linked', { get: () => true, configurable: true });
  transport._writeCandidates = [oldCandidate];
  transport._writeChar = oldCandidate;
  transport._peripheral = {
    disconnectAsync: async () => {
      order.push('old-peripheral:disconnect');
    },
  };

  // A new link comes up while the old disconnect is still stopping the gimbal.
  const newPeripheral = {
    disconnectAsync: async () => {
      order.push('new-peripheral:disconnect');
    },
  };
  transport._connectOnce = async (_noble, peripheralId) => {
    order.push(`connect:${peripheralId}`);
    transport._peripheral = newPeripheral;
    return { peripheralId };
  };

  const disconnecting = transport.disconnect();
  const connecting = transport.connect('new-gimbal', { attempts: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!order.includes('connect:new-gimbal'), 'connect must not start while the disconnect is stopping the gimbal');

  stop.release();
  await disconnecting;
  await connecting;

  assert.deepEqual(order, ['stop:start', 'stop:done', 'old-peripheral:disconnect', 'connect:new-gimbal']);
  assert.equal(transport._peripheral, newPeripheral, 'the new link must survive the old disconnect');
});
