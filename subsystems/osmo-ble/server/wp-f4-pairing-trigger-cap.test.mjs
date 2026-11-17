import test from 'node:test';
import assert from 'node:assert/strict';
import { OsmoBleTransport, PAIRING_TRIGGER_TIMEOUT_MS } from './ble-transport.mjs';

// F4-2: the pairing trigger's write is capped at PAIRING_TRIGGER_TIMEOUT_MS, not the 2 s motion cap, so an OS
// confirmation dialog that holds the write open does not fail POST /api/pair-trigger at 2 s. Timers are mocked,
// so the long cap is crossed in no real time. The write is a stub that answers when the test says so.

/** A transport with a link handle and one write characteristic whose answer the test controls. */
function linkWithWrite() {
  const transport = new OsmoBleTransport({});
  transport._peripheral = { state: 'connected' }; // triggerPairing() needs a handle; nothing here uses it
  const write = { answer: null };
  transport._writeCandidates = [{
    characteristic: { writeAsync: () => new Promise((resolve) => { write.answer = resolve; }) },
    withResponse: true,
    uuid: 'fff4',
  }];
  return { transport, write };
}

/** Lets promise callbacks that are already due run. Real setImmediate, so the mocked timers stay untouched. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('F4-2: the pairing trigger is still waiting at 2.5 s, past the motion write cap', { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, write } = linkWithWrite();
  let outcome = 'pending';
  const trigger = transport.triggerPairing().then(
    () => { outcome = 'resolved'; },
    (err) => { outcome = err; },
  );
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(outcome, 'pending', 'the confirmation dialog may still be open, so the trigger must not give up at 2 s');
  write.answer();
  await trigger;
  assert.equal(outcome, 'resolved');
});

test('F4-2: the pairing trigger still fails at its own cap, so a silent link is an error and not a hang', { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport } = linkWithWrite();
  const trigger = transport.triggerPairing();
  t.mock.timers.tick(PAIRING_TRIGGER_TIMEOUT_MS + 1);
  await assert.rejects(trigger, { timedOut: true });
});

test('F4-2 control: an ordinary motion write is still cut at 2 s', { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport } = linkWithWrite();
  const write = transport.sendRaw(Uint8Array.from([0xaa]));
  t.mock.timers.tick(2000);
  await assert.rejects(write, { timedOut: true });
});
