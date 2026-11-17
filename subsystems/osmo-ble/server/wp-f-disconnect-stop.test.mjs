import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OsmoBleTransport } from './ble-transport.mjs';
import { decodeFrame } from '../protocol/duml.mjs';
import { CMD_SET, CMD_ID } from '../protocol/constants.mjs';

// A fake BLE stack, enough for connect() and disconnect(): one notify characteristic (fff4) and the
// two write candidates (fff5, then fff3). Every write and every teardown is appended to one log, so
// a test can assert which came first. No noble and no hardware. `writes` makes the stack misbehave:
// 'fail' rejects every write, 'hang' never answers one.
function fakeGimbal({ writes = 'ok' } = {}) {
  const steps = [];
  const writer = (uuid, withoutResponse) => (bytes) => {
    if (writes === 'fail') return Promise.reject(new Error('GATT write refused'));
    if (writes === 'hang') return new Promise(() => {});
    steps.push({ kind: 'write', uuid, withoutResponse, bytes: Uint8Array.from(bytes) });
    return Promise.resolve();
  };
  const characteristic = (uuid, properties, writeAsync) => Object.assign(new EventEmitter(), {
    uuid,
    properties,
    subscribeAsync: async () => {},
    writeAsync,
  });
  const chars = [
    characteristic('fff4', ['notify'], () => Promise.resolve()),
    characteristic('fff5', ['writeWithoutResponse'], writer('fff5', true)),
    characteristic('fff3', ['write'], writer('fff3', false)),
  ];
  const peripheral = Object.assign(new EventEmitter(), {
    state: 'connected',
    discoverServicesAsync: async () => [{ uuid: 'fff0', discoverCharacteristicsAsync: async () => chars }],
    disconnectAsync: async () => {
      steps.push({ kind: 'teardown' });
      peripheral.state = 'disconnected';
    },
  });
  const noble = {
    waitForPoweredOnAsync: async () => {},
    connect: (_id, _options, callback) => callback(null, peripheral),
  };
  return { noble, peripheral, steps };
}

async function connectedTransport(options) {
  const gimbal = fakeGimbal(options);
  const transport = new OsmoBleTransport({ noble: gimbal.noble });
  await transport.connect('gimbal-1');
  assert.equal(transport.linked, true, 'the fake link should be linked before the test disconnects it');
  return { transport, steps: gimbal.steps, peripheral: gimbal.peripheral };
}

test('disconnect sends a zero-speed frame before tearing the link down', async () => {
  const { transport, steps } = await connectedTransport();
  await transport.disconnect();
  assert.deepEqual(steps.map((s) => s.kind), ['write', 'teardown']);
  const frame = decodeFrame(steps[0].bytes);
  assert.equal(frame.cmdSet, CMD_SET.GIMBAL_FN);
  assert.equal(frame.cmdId, CMD_ID.GIMBAL_SPEED_CTRL);
  assert.ok(frame.payload.subarray(0, 6).every((b) => b === 0), 'all three axes are zero');
});

test('no stop is written to a link that is already gone, and teardown still runs', async () => {
  const { transport, steps, peripheral } = await connectedTransport();
  peripheral.state = 'disconnected';
  assert.equal(transport.linked, false);
  await transport.disconnect();
  assert.deepEqual(steps.map((s) => s.kind), ['teardown']);
});

test('a stop write that fails does not stop the disconnect from completing', async () => {
  const { transport, steps } = await connectedTransport({ writes: 'fail' });
  await transport.disconnect();
  assert.deepEqual(steps.map((s) => s.kind), ['teardown']);
});

test('a stop write that never returns does not hold the disconnect open', async () => {
  const { transport, steps } = await connectedTransport({ writes: 'hang' });
  const started = Date.now();
  await transport.disconnect();
  assert.ok(Date.now() - started < 10000, 'disconnect should give up on the stop after its cap');
  assert.deepEqual(steps.map((s) => s.kind), ['teardown']);
});
