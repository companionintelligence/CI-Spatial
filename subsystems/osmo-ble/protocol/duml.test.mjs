// Validates the DUML codec against a real captured frame before it ever touches hardware.
//
// Test vector source: lib-osmo-ble's tools/verify-crc.mjs example invocation, a real
// SetPairingPIN request captured from the DJI Mimo app talking to an Osmo Pocket 3:
//   node tools/verify-crc.mjs 552204ea020780924007450f30303137343933313932383631303204353136302e42
//
// Decoded by hand during protocol research: sender=App(0x02), receiver=WiFi(0x07),
// msgId=0x8092, flags=REQUEST(0x40), cmdSet=WIFI(0x07), cmdId=SET_PAIRING_PIN(0x45),
// payload = packString("001749319286102") + packString("5160").
// If this test passes, the CRC8/CRC16 engines and frame layout are bit-exact.

import assert from 'node:assert/strict';
import { crc8, crc16, encodeFrame, decodeFrame, packString, unpackString, FrameReassembler } from './duml.mjs';

const hex = '552204ea020780924007450f30303137343933313932383631303204353136302e42';
const captured = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));

// 1. Header CRC8 must match the captured byte exactly.
assert.equal(crc8(captured.subarray(0, 3)), 0xea, 'CRC8 mismatch against captured frame');

// 2. Body CRC16 (over everything but the trailing CRC16 itself) must match.
const capturedCrc16 = captured[captured.length - 2] | (captured[captured.length - 1] << 8);
assert.equal(crc16(captured.subarray(0, captured.length - 2)), capturedCrc16, 'CRC16 mismatch against captured frame');

// 3. Full decode must succeed and recover the expected fields.
const decoded = decodeFrame(captured);
assert.equal(decoded.sender, 0x02);
assert.equal(decoded.receiver, 0x07);
assert.equal(decoded.msgId, 0x8092);
assert.equal(decoded.flags, 0x40);
assert.equal(decoded.cmdSet, 0x07);
assert.equal(decoded.cmdId, 0x45);

const { value: identifier, nextOffset } = unpackString(decoded.payload, 0);
const { value: pin } = unpackString(decoded.payload, nextOffset);
assert.equal(identifier, '001749319286102');
assert.equal(pin, '5160');

// 4. Round-trip: re-encoding the same logical fields must reproduce the captured bytes exactly.
const rebuilt = encodeFrame({
  sender: 0x02,
  receiver: 0x07,
  msgId: 0x8092,
  flags: 0x40,
  cmdSet: 0x07,
  cmdId: 0x45,
  payload: Uint8Array.from([...packString('001749319286102'), ...packString('5160')]),
});
assert.deepEqual(rebuilt, captured, 'Re-encoded frame does not byte-for-byte match the captured frame');

// 5. Reassembler handles a frame split across several small BLE-notify-sized chunks.
const reassembler = new FrameReassembler();
let recovered = [];
for (let i = 0; i < captured.length; i += 7) {
  recovered.push(...reassembler.push(captured.subarray(i, i + 7)));
}
assert.equal(recovered.length, 1, 'Reassembler should recover exactly one frame from split chunks');
assert.equal(recovered[0].cmdId, 0x45);

console.log('OK: DUML codec verified bit-exact against captured SetPairingPIN frame.');
console.log(`    identifier=${JSON.stringify(identifier)} pin=${JSON.stringify(pin)}`);
