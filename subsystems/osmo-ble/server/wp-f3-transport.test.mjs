import test from 'node:test';
import assert from 'node:assert/strict';
import { OsmoBleTransport } from './ble-transport.mjs';

// The transport's write cap (F3-3) and the link-generation check on pairing (F3-9), with every BLE call
// replaced by a stub. No noble, no hardware, no network.

test('F3-3: a write that never answers is rejected at the cap, and is not re-sent on the next characteristic', { timeout: 10000 }, async () => {
  const transport = new OsmoBleTransport({});
  let hangs = 0;
  let fallbackWrites = 0;
  transport._writeCandidates = [
    { characteristic: { writeAsync: () => { hangs += 1; return new Promise(() => {}); } }, withResponse: false, uuid: 'fff5' },
    { characteristic: { writeAsync: async () => { fallbackWrites += 1; } }, withResponse: true, uuid: 'fff3' },
  ];
  const started = Date.now();
  await assert.rejects(
    transport.sendRaw(Uint8Array.from([0xaa, 0xbb])),
    (err) => err.timedOut === true && /no answer to a write on fff5/.test(err.message),
  );
  assert.ok(Date.now() - started < 6000, 'the write gives up at its cap');
  assert.equal(hangs, 1);
  assert.equal(fallbackWrites, 0, 'a link that never answers is not tried again on another characteristic');
  assert.equal(transport._writeChar, null, 'nothing is latched from a write that did not complete');
});

test('F3-3: a latched characteristic that never answers also fails at the cap', { timeout: 10000 }, async () => {
  const transport = new OsmoBleTransport({});
  transport._writeChar = {
    characteristic: { writeAsync: () => new Promise(() => {}) },
    withResponse: false,
    uuid: 'fff5',
  };
  await assert.rejects(transport.sendRaw(Uint8Array.from([0xaa])), { timedOut: true });
});

/** A pairing on a transport whose device answers the SetPairingPIN, optionally after a teardown. */
function pairingTransport({ teardownWhileAnswering }) {
  const transport = new OsmoBleTransport({});
  transport._peripheral = { state: 'connected' }; // pair() requires a handle; nothing here uses it
  let writes = 0;
  const characteristic = {
    writeAsync: async () => {
      writes += 1;
      if (writes === 1) return; // the pairing trigger
      // The SetPairingPIN is on the air. The device answers on this link, unless the link goes first.
      setTimeout(() => {
        if (teardownWhileAnswering) transport._resetLinkState();
        transport.emit('frame', { cmdSet: 0x07, cmdId: 0x45, flags: 0x80, payload: Uint8Array.from([0x00, 0x02]) });
      }, 5);
    },
  };
  transport._writeCandidates = [{ characteristic, withResponse: true, uuid: 'fff5' }];
  return transport;
}

test('F3-9: a teardown while pair() waits for its response does not latch paired onto the link that is gone', { timeout: 10000 }, async () => {
  const transport = pairingTransport({ teardownWhileAnswering: true });
  const result = await transport.pair('123456', { timeoutMs: 2000 });
  assert.equal(result.pairingRequired, true, 'the response did arrive, so the test reached the latch');
  assert.equal(transport.paired, false);
});

test('F3-9 control: a pairing on an undisturbed link latches paired', { timeout: 10000 }, async () => {
  const transport = pairingTransport({ teardownWhileAnswering: false });
  const result = await transport.pair('123456', { timeoutMs: 2000 });
  assert.equal(result.pairingRequired, true);
  assert.equal(transport.paired, true);
});
