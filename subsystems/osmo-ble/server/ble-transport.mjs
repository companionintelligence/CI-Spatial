// Node-side BLE transport for the Osmo, built on @stoprocent/noble. Handles scanning,
// connecting, the write-characteristic fallback probe (fff5 vs fff3 — sources disagree on
// which one a given Osmo model actually accepts DUML writes on), the pairing handshake, and
// reassembling/decoding the incoming DUML notification stream.

import { EventEmitter } from 'node:events';
import noble from '@stoprocent/noble';
import { FrameReassembler } from '../protocol/duml.mjs';
import {
  SERVICE_SHORT,
  ALL_NOTIFY_CHARS_SHORT,
  WRITE_CHAR_CANDIDATES,
  PAIRING_TRIGGER_BYTES,
  DJI_MANUFACTURER_PREFIX,
} from '../protocol/constants.mjs';
import { MsgIdSequence, buildSetPairingPin } from '../protocol/commands.mjs';
import { decodeQuaternion } from '../protocol/telemetry.mjs';

const MAX_FRAME_HISTORY = 500;

function looksLikeDji(peripheral) {
  const name = peripheral.advertisement?.localName || '';
  const mfg = peripheral.advertisement?.manufacturerData;
  const nameMatch = /osmo|dji/i.test(name);
  const mfgMatch = mfg && mfg.length >= 2 && mfg[0] === DJI_MANUFACTURER_PREFIX[0] && mfg[1] === DJI_MANUFACTURER_PREFIX[1];
  return Boolean(nameMatch || mfgMatch);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OsmoBleTransport extends EventEmitter {
  constructor() {
    super();
    this._peripheral = null;
    this._writeChar = null; // latched Characteristic once we know which one the device accepts
    this._notifyChars = [];
    // One reassembler per characteristic: each notify source is an independent byte stream,
    // and DUML frames can arrive split across several ATT packets, so bytes from different
    // characteristics must never be concatenated into the same buffer.
    this._reassemblers = new Map();
    this._msgIds = new MsgIdSequence();
    this._paired = false;
    this.frames = []; // rolling history of decoded frames, most recent last
    this.lastQuaternion = null;
  }

  get connected() {
    return this._peripheral?.state === 'connected';
  }

  get paired() {
    return this._paired;
  }

  /** Scan for `timeoutMs` and return every peripheral seen, DJI-looking ones first. */
  async scan(timeoutMs = 5000) {
    await noble.waitForPoweredOnAsync(10000);
    const seen = new Map();
    const onDiscover = (peripheral) => {
      seen.set(peripheral.id, peripheral);
    };
    noble.on('discover', onDiscover);
    await noble.startScanningAsync([], true);
    await sleep(timeoutMs);
    await noble.stopScanningAsync();
    noble.removeListener('discover', onDiscover);

    const results = [...seen.values()].map((p) => ({
      id: p.id,
      name: p.advertisement?.localName || '(no name)',
      rssi: p.rssi,
      likelyOsmo: looksLikeDji(p),
      manufacturerDataHex: p.advertisement?.manufacturerData ? p.advertisement.manufacturerData.toString('hex') : null,
    }));
    results.sort((a, b) => Number(b.likelyOsmo) - Number(a.likelyOsmo) || b.rssi - a.rssi);
    return results;
  }

  /** Connect to a peripheral by its noble id (from scan()), discover fff0 + subscribe to all its characteristics. */
  async connect(peripheralId) {
    await noble.waitForPoweredOnAsync(10000);
    const peripheral = await noble.connectAsync(peripheralId);
    this._peripheral = peripheral;
    peripheral.once('disconnect', () => {
      this._writeChar = null;
      this._paired = false;
      this.emit('disconnect');
    });

    const services = await peripheral.discoverServicesAsync([]);
    const service = services.find((s) => s.uuid === SERVICE_SHORT);
    if (!service) {
      const found = services.map((s) => s.uuid).join(', ') || '(none)';
      throw new Error(`Osmo service (${SERVICE_SHORT}) not found on this device. Services seen: ${found}`);
    }

    const characteristics = await service.discoverCharacteristicsAsync([]);
    this._notifyChars = characteristics.filter((c) => ALL_NOTIFY_CHARS_SHORT.includes(c.uuid));
    for (const ch of this._notifyChars) {
      if (ch.properties.includes('notify') || ch.properties.includes('indicate')) {
        ch.on('data', (data) => this._handleNotifyData(ch.uuid, data));
        await ch.subscribeAsync();
      }
    }

    this._writeCandidates = WRITE_CHAR_CANDIDATES.map(({ uuid, withResponse }) => ({
      characteristic: characteristics.find((c) => c.uuid === uuid),
      withResponse,
      uuid,
    })).filter((c) => c.characteristic);

    return { serviceUuid: service.uuid, characteristics: characteristics.map((c) => ({ uuid: c.uuid, properties: c.properties })) };
  }

  _handleNotifyData(sourceCharUuid, buffer) {
    if (!this._reassemblers.has(sourceCharUuid)) this._reassemblers.set(sourceCharUuid, new FrameReassembler());
    const frames = this._reassemblers.get(sourceCharUuid).push(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length));
    for (const frame of frames) {
      const enriched = { at: Date.now(), sourceCharUuid, ...frame };
      if (!frame.error) {
        this.frames.push(enriched);
        if (this.frames.length > MAX_FRAME_HISTORY) this.frames.shift();
        const quat = decodeQuaternion(frame);
        if (quat) this.lastQuaternion = quat;
      }
      this.emit('frame', enriched);
    }
  }

  /**
   * Run the pairing handshake: trigger + SetPairingPIN, probing fff5-then-fff3 for whichever
   * one the device actually accepts writes on. `pin` must be read off the device's own screen —
   * see protocol/commands.mjs for why a hardcoded default is unsafe to assume.
   *
   * The trigger write goes through the same fff5-then-fff3 candidate probe as every other
   * write (see sendRaw) rather than a hardcoded fff4 — fff4 was fff4 "PairingRequestor" per
   * research on a different Osmo model, but on real hardware tested here its GATT properties
   * are notify-only (no write/writeWithoutResponse at all), so a hardcoded fff4 write always
   * fails with a GATT-level "Write Not Permitted" before ever reaching the device.
   */
  async pair(pin, { identifier, timeoutMs = 4000 } = {}) {
    if (!this._peripheral) throw new Error('pair(): not connected');

    await this.sendRaw(PAIRING_TRIGGER_BYTES);
    await sleep(1000);

    const msgId = this._msgIds.next();
    const frame = buildSetPairingPin(msgId, pin, identifier);

    const response = await this._writeAndAwaitResponse(frame, { cmdSet: 0x07, cmdId: 0x45, timeoutMs });
    if (!response) {
      throw new Error('pair(): no response to SetPairingPIN on either fff5 or fff3 — device may use a different characteristic mapping than researched, or may not be in range/pairing mode');
    }
    const status = response.payload.length >= 2 ? response.payload[1] : response.payload[0];
    this._paired = true; // latch write channel regardless; treat any response as forward progress
    return { alreadyPaired: status === 0x01, pairingRequired: status === 0x02, raw: response };
  }

  /**
   * Write a pre-built DUML frame using the latched write characteristic, probing candidates
   * on the first call if none is latched yet.
   */
  async sendRaw(frameBytes) {
    if (this._writeChar) {
      await this._writeChar.characteristic.writeAsync(Buffer.from(frameBytes), !this._writeChar.withResponse);
      return;
    }
    for (const candidate of this._writeCandidates) {
      try {
        await candidate.characteristic.writeAsync(Buffer.from(frameBytes), candidate.withResponse === false);
        this._writeChar = candidate;
        return;
      } catch {
        // try next candidate
      }
    }
    throw new Error('sendRaw(): failed to write on any known characteristic (fff5, fff3)');
  }

  /** Internal: write + wait for a matching response frame, trying each write candidate in order. */
  async _writeAndAwaitResponse(frameBytes, { cmdSet, cmdId, timeoutMs }) {
    for (const candidate of this._writeCandidates) {
      const waiter = this._waitForFrame((f) => f.cmdSet === cmdSet && f.cmdId === cmdId && (f.flags & 0x80) !== 0, timeoutMs);
      try {
        await candidate.characteristic.writeAsync(Buffer.from(frameBytes), candidate.withResponse === false);
      } catch {
        continue;
      }
      const response = await waiter;
      if (response) {
        this._writeChar = candidate;
        return response;
      }
    }
    return null;
  }

  _waitForFrame(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const onFrame = (frame) => {
        if (frame.error) return;
        if (predicate(frame)) {
          cleanup();
          resolve(frame);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('frame', onFrame);
      };
      this.on('frame', onFrame);
    });
  }

  /** Build a fresh msgId for a caller-constructed command frame. */
  nextMsgId() {
    return this._msgIds.next();
  }

  async disconnect() {
    if (this._peripheral) {
      await this._peripheral.disconnectAsync();
      this._peripheral = null;
    }
  }
}
