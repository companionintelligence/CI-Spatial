// DUML (DJI Universal Markup Language) BLE frame codec.
//
// Wire format (11-byte header + payload + 2-byte trailing CRC16):
//   0       magic byte, always 0x55
//   1       length low byte (10-bit total length, low 8 bits)
//   2       bits[0:1] = length high 2 bits, bits[2:7] = version (always 1 here)
//   3       header CRC8, over bytes [0..3)
//   4       sender component id
//   5       receiver component id
//   6-7     message id, BIG-ENDIAN
//   8       flags (0x00 notify, 0x40 request/ack-required, 0x80 response, 0xC0 response-to-ack)
//   9       cmdSet
//   10      cmdId
//   11..N   payload
//   N..N+2  CRC16 over bytes [0..N), LITTLE-ENDIAN
//
// CRC parameters and every field above were cross-verified across three independent
// implementations (node-osmo, lib-osmo-ble, djictl) and checked bit-for-bit against a
// real captured frame (see duml.test.mjs) before being trusted here. Pure JS / Uint8Array
// only, so this file runs unmodified in both Node and the browser.

/** Generic bit-by-bit CRC matching the classic width/poly/init/xorout/refin/refout model. */
function makeCrc({ width, poly, init, xorout, refin, refout }) {
  const mask = width === 16 ? 0xffff : 0xff;
  const topBit = 1 << (width - 1);

  function reflect(value, bits) {
    let out = 0;
    for (let i = 0; i < bits; i++) {
      if (value & (1 << i)) out |= 1 << (bits - 1 - i);
    }
    return out;
  }

  return function crc(bytes) {
    let reg = init & mask;
    for (let raw of bytes) {
      const b = refin ? reflect(raw, 8) : raw;
      reg ^= width === 16 ? (b << 8) : b;
      for (let bit = 0; bit < 8; bit++) {
        if (reg & topBit) {
          reg = ((reg << 1) ^ poly) & mask;
        } else {
          reg = (reg << 1) & mask;
        }
      }
    }
    if (refout) reg = reflect(reg, width);
    return (reg ^ xorout) & mask;
  };
}

export const crc8 = makeCrc({ width: 8, poly: 0x31, init: 0xee, xorout: 0x00, refin: true, refout: true });
export const crc16 = makeCrc({ width: 16, poly: 0x1021, init: 0x496c, xorout: 0x0000, refin: true, refout: true });

/** [1-byte utf8 length][utf8 bytes] — used for pairing identifier/PIN. */
export function packString(str) {
  const body = new TextEncoder().encode(str);
  if (body.length > 255) throw new RangeError('packString: string too long for 1-byte length prefix');
  const out = new Uint8Array(1 + body.length);
  out[0] = body.length;
  out.set(body, 1);
  return out;
}

export function unpackString(bytes, offset = 0) {
  const len = bytes[offset];
  const str = new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + len));
  return { value: str, nextOffset: offset + 1 + len };
}

/**
 * Encode a DUML frame.
 * @param {object} opts
 * @param {number} opts.sender - sender component id
 * @param {number} opts.receiver - receiver component id
 * @param {number} opts.msgId - 16-bit transaction/sequence id
 * @param {number} opts.flags - flags byte (see FLAGS in constants.mjs)
 * @param {number} opts.cmdSet
 * @param {number} opts.cmdId
 * @param {Uint8Array} [opts.payload]
 * @returns {Uint8Array}
 */
export function encodeFrame({ sender, receiver, msgId, flags, cmdSet, cmdId, payload = new Uint8Array(0) }) {
  const total = 13 + payload.length;
  if (total > 1023) throw new RangeError('encodeFrame: payload too large for 10-bit length field');
  const buf = new Uint8Array(total);
  buf[0] = 0x55;
  buf[1] = total & 0xff;
  buf[2] = ((total >> 8) & 0x03) | (1 << 2); // version = 1
  buf[3] = crc8(buf.subarray(0, 3));
  buf[4] = sender & 0xff;
  buf[5] = receiver & 0xff;
  buf[6] = (msgId >> 8) & 0xff; // big-endian
  buf[7] = msgId & 0xff;
  buf[8] = flags & 0xff;
  buf[9] = cmdSet & 0xff;
  buf[10] = cmdId & 0xff;
  buf.set(payload, 11);
  const crc = crc16(buf.subarray(0, total - 2));
  buf[total - 2] = crc & 0xff;
  buf[total - 1] = (crc >> 8) & 0xff; // little-endian
  return buf;
}

/**
 * Decode+validate a single DUML frame. Throws on any structural/CRC mismatch.
 * @param {Uint8Array} buf
 */
export function decodeFrame(buf) {
  if (buf.length < 13) throw new Error(`decodeFrame: frame too short (${buf.length} bytes)`);
  if (buf[0] !== 0x55) throw new Error(`decodeFrame: bad magic byte 0x${buf[0].toString(16)}`);
  const total = buf[1] | ((buf[2] & 0x03) << 8);
  if (total !== buf.length) throw new Error(`decodeFrame: length mismatch (header says ${total}, got ${buf.length})`);
  const hdrCrc = crc8(buf.subarray(0, 3));
  if (hdrCrc !== buf[3]) throw new Error(`decodeFrame: header CRC8 mismatch (expected 0x${hdrCrc.toString(16)}, got 0x${buf[3].toString(16)})`);
  const bodyCrc = crc16(buf.subarray(0, total - 2));
  const gotCrc = buf[total - 2] | (buf[total - 1] << 8);
  if (bodyCrc !== gotCrc) throw new Error(`decodeFrame: body CRC16 mismatch (expected 0x${bodyCrc.toString(16)}, got 0x${gotCrc.toString(16)})`);
  return {
    sender: buf[4],
    receiver: buf[5],
    msgId: (buf[6] << 8) | buf[7],
    flags: buf[8],
    cmdSet: buf[9],
    cmdId: buf[10],
    payload: buf.subarray(11, total - 2),
  };
}

/**
 * Streaming reassembler for the BLE notification stream: DUML frames can arrive split
 * across multiple ATT notify packets (BLE MTU is usually smaller than a full frame).
 * Feed raw notify payloads in; get back any complete frames extracted so far.
 */
export class FrameReassembler {
  constructor() {
    this._buf = new Uint8Array(0);
  }

  push(chunk) {
    const merged = new Uint8Array(this._buf.length + chunk.length);
    merged.set(this._buf, 0);
    merged.set(chunk, this._buf.length);
    this._buf = merged;

    const frames = [];
    for (;;) {
      const start = this._buf.indexOf(0x55);
      if (start === -1) {
        this._buf = new Uint8Array(0);
        break;
      }
      if (start > 0) this._buf = this._buf.subarray(start);
      if (this._buf.length < 3) break; // not enough to read the length field yet
      const total = this._buf[1] | ((this._buf[2] & 0x03) << 8);
      if (total < 13 || total > 1023) {
        // Not a real frame start — drop this byte and resync.
        this._buf = this._buf.subarray(1);
        continue;
      }
      if (this._buf.length < total) break; // wait for more data
      const frameBytes = this._buf.subarray(0, total);
      this._buf = this._buf.subarray(total);
      try {
        frames.push(decodeFrame(frameBytes));
      } catch (err) {
        frames.push({ error: err, raw: frameBytes });
      }
    }
    return frames;
  }
}
