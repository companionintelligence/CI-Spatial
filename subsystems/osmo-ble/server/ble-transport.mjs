// Node-side BLE transport for the Osmo, built on @stoprocent/noble. Handles scanning,
// connecting, the write-characteristic fallback probe (fff5 vs fff3 — sources disagree on
// which one a given Osmo model actually accepts DUML writes on), the pairing handshake, and
// reassembling/decoding the incoming DUML notification stream.

import { EventEmitter } from 'node:events';
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
import { deriveLinkState, describeLink, isLinked, isStreaming, isStaleHandleError, isTransientLinkError } from '../protocol/link_state.mjs';

const MAX_FRAME_HISTORY = 500;

/** How long to wait for a stale handle's HCI disconnect-complete before retrying anyway. */
const STALE_HANDLE_DROP_MS = 2000;
/** Settle time after a drop, before re-opening. The controller needs a beat to release the ACL. */
const STALE_HANDLE_SETTLE_MS = 250;
/** Cap on peripheral.disconnectAsync(), which never resolves for a handle that is already gone. */
const DISCONNECT_TIMEOUT_MS = 2000;
/**
 * How many times connect() re-tries a link that failed in a way a retry can fix.
 *
 * Three, because re-opening a link immediately after dropping a stale one is measurably racy —
 * on a real OM6 over BlueZ on 2026-08-30, roughly one attempt in three lost the link mid-
 * discovery with `Disconnected 62`, and the next attempt succeeded. One retry would leave a ~11%
 * chance of surfacing a failure the operator has to hand-retry; two leaves ~4%. See
 * isTransientLinkError() for what is and is not retried — a wrong device or a wedged gimbal
 * fails on the first attempt, immediately.
 */
const CONNECT_ATTEMPTS = 3;
/** Backoff between attempts, multiplied by the attempt number. */
const RECONNECT_BACKOFF_MS = 400;

function looksLikeDji(peripheral) {
  const name = peripheral.advertisement?.localName || '';
  const mfg = peripheral.advertisement?.manufacturerData;
  const nameMatch = /osmo|dji/i.test(name);
  const mfgMatch = mfg && mfg.length >= 2 && mfg[0] === DJI_MANUFACTURER_PREFIX[0] && mfg[1] === DJI_MANUFACTURER_PREFIX[1];
  return Boolean(nameMatch || mfgMatch);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve `promise`, or resolve to `onTimeout` after `ms` — never rejects, never leaves a dangling handler. */
async function withTimeout(promise, ms, onTimeout = 'timeout') {
  let timer;
  try {
    return await Promise.race([
      promise.then((v) => v, (err) => ({ error: err })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class OsmoBleTransport extends EventEmitter {
  /**
   * `noble` is injectable purely so the connect/recovery paths can be tested. The real module is
   * imported lazily on first use rather than at the top of this file: importing @stoprocent/noble
   * constructs its bindings and opens a raw HCI socket as a side effect, which a unit test must
   * never do — it would take the adapter away from a running backend mid-scan.
   */
  constructor({ noble = null } = {}) {
    super();
    this._nobleOverride = noble;
    this._nobleModule = null;
    this._peripheral = null;
    this._connecting = false;
    this._writeChar = null; // latched Characteristic once we know which one the device accepts
    this._notifyChars = [];
    this._writeCandidates = [];
    // The 'data' listeners we attached, kept so they can be removed on teardown. noble reuses
    // its Characteristic objects across reconnects, so leaving them attached would stack a
    // second copy of every handler on each reconnect and double-decode the frame stream.
    this._notifySubs = [];
    /** The peripheral's own 'disconnect' listener, kept so it can be detached — see _establishLink. */
    this._disconnectSub = null;
    /** uuids we successfully subscribed to. Empty means no telemetry can ever arrive. */
    this._subscribedChars = [];
    // One reassembler per characteristic: each notify source is an independent byte stream,
    // and DUML frames can arrive split across several ATT packets, so bytes from different
    // characteristics must never be concatenated into the same buffer.
    this._reassemblers = new Map();
    this._msgIds = new MsgIdSequence();
    this._paired = false;
    this.frames = []; // rolling history of decoded frames, most recent last
    this.lastQuaternion = null;
    /**
     * When lastQuaternion was received (ms epoch), or 0 if never.
     *
     * Exists so a control loop can tell a FRESH sample from the one it already acted on.
     * Quaternion frames arrive well slower than the closed loop's ~400ms tick, so without this
     * the loop issues 2-3 full corrections against one reading and overshoots by that multiple
     * — visible as bit-identical float64 angles on consecutive ticks in any move history.
     */
    this.lastQuaternionAt = 0;
    /**
     * When ANY notification last arrived (ms epoch), or 0 if never — the measurement behind the
     * `streaming` link state. Stamped on raw bytes, before reassembly and before decoding: a
     * partial ATT packet still proves the link is alive, and a frame this transport cannot parse
     * is a protocol gap, not a dead link.
     */
    this.lastNotifyAt = 0;
    this.notifyCount = 0;
  }

  async _noble() {
    if (this._nobleOverride) return this._nobleOverride;
    this._nobleModule ??= (await import('@stoprocent/noble')).default;
    return this._nobleModule;
  }

  /**
   * The link's honest state — see protocol/link_state.mjs. Computed on read rather than stored,
   * because `streaming` decays with time: a link that stops reporting has to become false on its
   * own, without something remembering to flip a flag.
   */
  get linkState() {
    return deriveLinkState({
      peripheralState: this._peripheral?.state ?? null,
      connecting: this._connecting,
      subscribedChars: this._subscribedChars,
      lastNotifyAt: this.lastNotifyAt,
    });
  }

  /**
   * True only when telemetry is demonstrably flowing.
   *
   * This deliberately no longer means "noble's connect call returned". A GATT handle whose
   * subscriptions were never established reported `connected: true` with `lastQuaternion: null`
   * forever — healthy in /api/status and in the web UI, while every closed-loop move ran blind.
   * Callers that only need to WRITE (above all `stopMotors()`) must use `linked`, not this.
   */
  get connected() {
    return isStreaming(this.linkState);
  }

  /** A GATT handle is open, so commands can be written. Says nothing about telemetry. */
  get linked() {
    return isLinked(this.linkState);
  }

  /** uuids currently subscribed for notifications. Empty on a half-open link. */
  get subscribedChars() {
    return [...this._subscribedChars];
  }

  /** One sentence explaining the current state, suitable for an API error body or the UI. */
  get linkDetail() {
    return describeLink(this.linkState, { subscribedChars: this._subscribedChars, lastNotifyAt: this.lastNotifyAt });
  }

  get paired() {
    return this._paired;
  }

  /** Scan for `timeoutMs` and return every peripheral seen, DJI-looking ones first. */
  async scan(timeoutMs = 5000) {
    const noble = await this._noble();
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

  /**
   * Connect to a peripheral by its noble id (from scan()), discover fff0, and subscribe to every
   * notify characteristic on it.
   *
   * Resolves only for a link a caller can actually use: a GATT handle AND at least one live
   * subscription. Three guarantees this method did not previously make:
   *
   *   1. A stale handle is dropped and re-established rather than trusted. See
   *      isStaleHandleError() for how noble ends up holding one after a backend restart.
   *   2. Every failure after the handle exists tears that handle back down before rethrowing.
   *      Previously `this._peripheral` was assigned the instant noble's connect returned, so a
   *      throw out of service discovery or subscribeAsync() left the object reporting connected
   *      for a link that would never deliver a byte — recoverable only by restarting the process.
   *   3. A link that drops mid-setup is retried, bounded, rather than surfaced. Re-opening
   *      straight after a drop is measurably racy on real hardware — see CONNECT_ATTEMPTS.
   *      Errors a retry cannot fix (wrong device, wedged gimbal) still fail on the first attempt.
   */
  async connect(peripheralId, { attempts = CONNECT_ATTEMPTS } = {}) {
    const noble = await this._noble();
    await noble.waitForPoweredOnAsync(10000);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return { ...(await this._connectOnce(noble, peripheralId)), attempt };
      } catch (err) {
        lastError = err;
        if (attempt === attempts || !isTransientLinkError(err)) break;
        this.emit('link-recovery', { peripheralId, reason: err.message, action: 'retry', attempt, attempts });
        await sleep(RECONNECT_BACKOFF_MS * attempt);
      }
    }
    throw lastError;
  }

  /** One connect attempt: acquire a handle, establish the link, or leave nothing behind. */
  async _connectOnce(noble, peripheralId) {
    let info;
    this._connecting = true;
    try {
      const peripheral = await this._acquirePeripheral(noble, peripheralId);
      this._peripheral = peripheral;
      try {
        info = await this._establishLink(peripheral, peripheralId);
      } catch (err) {
        // Half-open is not a state this object is allowed to rest in.
        await this._teardown();
        throw err;
      }
    } finally {
      this._connecting = false;
    }
    // Read after `_connecting` clears, so this reports what the link actually is. Expect
    // `linked`, not `streaming`: subscriptions exist but the first notification has not
    // necessarily landed yet. A 200 from here is not a promise that telemetry is flowing —
    // poll /api/status for that.
    return { ...info, link: this.linkState, linkDetail: this.linkDetail };
  }

  /**
   * Get a GATT handle, recovering once from noble's already-connected rejection.
   *
   * The recovery is the whole point: the previous behaviour was to surface the error and leave
   * the stale handle in place, so every retry hit the same rejection and the only fix was a full
   * process restart — which is also the one action guaranteed to leave latched motors driving
   * with nothing able to stop them.
   */
  async _acquirePeripheral(noble, peripheralId) {
    let { error, peripheral } = await this._connectAttempt(noble, peripheralId);
    if (!error) return peripheral;
    if (!isStaleHandleError(error)) throw error;

    this.emit('link-recovery', { peripheralId, reason: error.message, action: 'drop-stale-handle' });
    await this._dropStaleHandle(noble, peripheralId, peripheral);
    ({ error, peripheral } = await this._connectAttempt(noble, peripheralId));
    if (error) {
      // `cause` is load-bearing, not decoration: isTransientLinkError() reads through it, so a
      // racy re-open still gets connect()'s retry instead of being buried under this wrapper.
      throw new Error(
        `connect(): ${peripheralId} was held by a stale BLE handle this process never subscribed on, `
        + `and re-opening it after dropping that handle failed: ${error.message}. The link is most `
        + `likely still up at the controller — check with "bluetoothctl info", or power-cycle the gimbal.`,
        { cause: error },
      );
    }
    return peripheral;
  }

  /**
   * One connect attempt, keeping BOTH the error and the peripheral.
   *
   * noble.connectAsync() throws the peripheral away on rejection, and the already-connected
   * rejection is exactly the case where that handle is the only thing that can clear the
   * condition — Noble#connect passes it to the callback (`callback(error, peripheral)`) and the
   * promise wrapper drops it. So use the callback form directly.
   */
  _connectAttempt(noble, peripheralId) {
    return new Promise((resolve) => {
      noble.connect(peripheralId, undefined, (error, peripheral) =>
        resolve({ error: error ?? null, peripheral: peripheral ?? null }));
    });
  }

  /**
   * Force a stale peripheral back to a state a fresh connect can succeed from.
   *
   * Waits for the real HCI disconnect-complete (which is what flips noble's state to
   * 'disconnected') rather than assuming the request took effect, then gives the controller a
   * beat to release the ACL before the caller re-opens. Timing out is still forward progress:
   * peripheral.disconnect() sets state to 'disconnecting' synchronously, and anything other than
   * 'connected' clears noble's already-connected guard on the retry.
   */
  async _dropStaleHandle(noble, peripheralId, peripheral) {
    try {
      if (peripheral) peripheral.disconnect();
      else noble.disconnect(peripheralId);
    } catch {
      // A handle noble has already forgotten throws here — that is the state we were asking for.
    }
    const deadline = Date.now() + STALE_HANDLE_DROP_MS;
    while (peripheral && peripheral.state !== 'disconnected' && Date.now() < deadline) await sleep(50);
    await sleep(STALE_HANDLE_SETTLE_MS);
  }

  /** Discover fff0, subscribe every notify characteristic, latch the write candidates. */
  async _establishLink(peripheral, peripheralId) {
    // Tracked (not a bare `once`) so _resetLinkState can detach it. noble reuses its Peripheral
    // objects across reconnects, and a disconnect handler left over from an earlier link would
    // fire later and null out a NEWER peripheral — the identity check below is the second
    // guard against the same thing.
    const onDisconnect = () => {
      if (this._peripheral !== peripheral) return;
      this._peripheral = null;
      this._resetLinkState();
      this.emit('disconnect');
    };
    this._disconnectSub = { peripheral, onDisconnect };
    peripheral.once('disconnect', onDisconnect);

    const services = await peripheral.discoverServicesAsync([]);
    const service = services.find((s) => s.uuid === SERVICE_SHORT);
    if (!service) {
      const found = services.map((s) => s.uuid).join(', ') || '(none)';
      throw new Error(`Osmo service (${SERVICE_SHORT}) not found on this device. Services seen: ${found}`);
    }

    const characteristics = await service.discoverCharacteristicsAsync([]);
    this._notifyChars = characteristics.filter((c) => ALL_NOTIFY_CHARS_SHORT.includes(c.uuid));

    // Per-characteristic rather than all-or-nothing: fff0 is subscribed defensively (no role
    // ever observed on it) and fff4 is the one that actually carries telemetry, so one refusing
    // must not cost us the stream. What is NOT tolerated is zero subscriptions — that is the
    // silent link this whole method exists to stop reporting as connected.
    const failures = [];
    for (const ch of this._notifyChars) {
      if (!ch.properties.includes('notify') && !ch.properties.includes('indicate')) continue;
      const handler = (data) => this._handleNotifyData(ch.uuid, data);
      ch.on('data', handler);
      try {
        await ch.subscribeAsync();
        this._notifySubs.push({ characteristic: ch, handler });
        this._subscribedChars.push(ch.uuid);
      } catch (err) {
        ch.removeListener('data', handler);
        failures.push(`${ch.uuid}: ${err.message}`);
      }
    }
    if (!this._subscribedChars.length) {
      const seen = this._notifyChars.map((c) => `${c.uuid} [${c.properties.join('/')}]`).join(', ') || '(none)';
      throw new Error(
        `connect(): linked to ${peripheralId}, but no notify characteristic accepted a subscription, `
        + `so no telemetry could ever arrive. Characteristics seen: ${seen}. `
        + `${failures.length ? `Subscribe errors: ${failures.join('; ')}. ` : ''}`
        + `Refusing to report this link as connected — power-cycle the gimbal and reconnect.`,
      );
    }

    this._writeCandidates = WRITE_CHAR_CANDIDATES.map(({ uuid, withResponse }) => ({
      characteristic: characteristics.find((c) => c.uuid === uuid),
      withResponse,
      uuid,
    })).filter((c) => c.characteristic);

    return {
      serviceUuid: service.uuid,
      subscribedChars: [...this._subscribedChars],
      subscribeFailures: failures,
      // Honest about what has been earned so far: subscriptions exist, but no notification has
      // necessarily arrived yet, so this is `linked` until one does. Callers that need feedback
      // should poll /api/status rather than treat a 200 here as "telemetry is flowing".
      link: this.linkState,
      characteristics: characteristics.map((c) => ({ uuid: c.uuid, properties: c.properties })),
    };
  }

  _handleNotifyData(sourceCharUuid, buffer) {
    // Stamped first, on the raw bytes: this is the measurement behind `streaming`, and it must
    // not depend on the bytes decoding into something this transport recognizes.
    this.lastNotifyAt = Date.now();
    this.notifyCount++;
    if (!this._reassemblers.has(sourceCharUuid)) this._reassemblers.set(sourceCharUuid, new FrameReassembler());
    const frames = this._reassemblers.get(sourceCharUuid).push(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length));
    for (const frame of frames) {
      const enriched = { at: Date.now(), sourceCharUuid, ...frame };
      if (!frame.error) {
        this.frames.push(enriched);
        if (this.frames.length > MAX_FRAME_HISTORY) this.frames.shift();
        const quat = decodeQuaternion(frame);
        if (quat) {
          this.lastQuaternion = quat;
          this.lastQuaternionAt = enriched.at;
        }
      }
      this.emit('frame', enriched);
    }
  }

  /**
   * Send just the pairing-trigger byte pair, without following it with a SetPairingPIN — the
   * device is expected to enter pairing mode and show a PIN on its own screen, which is a
   * precondition for the caller to be able to supply one to pair() at all. Split out from
   * pair() (which still calls this internally, unchanged) so a caller who does not yet have a
   * PIN can make the device show one without guessing at pair()'s required `pin` argument —
   * guessing risks tripping a real device-side lockout on repeated bad attempts, which would
   * make the eventual real pairing attempt harder, not easier.
   *
   * Goes through the same fff5-then-fff3 candidate probe as every other write (see sendRaw)
   * rather than a hardcoded fff4 — fff4 was fff4 "PairingRequestor" per research on a different
   * Osmo model, but on real hardware tested here its GATT properties are notify-only (no
   * write/writeWithoutResponse at all), so a hardcoded fff4 write always fails with a GATT-level
   * "Write Not Permitted" before ever reaching the device.
   */
  async triggerPairing() {
    if (!this._peripheral) throw new Error('triggerPairing(): not connected');
    await this.sendRaw(PAIRING_TRIGGER_BYTES);
  }

  /**
   * Run the pairing handshake: trigger + SetPairingPIN, probing fff5-then-fff3 for whichever
   * one the device actually accepts writes on. `pin` must be read off the device's own screen —
   * see protocol/commands.mjs for why a hardcoded default is unsafe to assume.
   */
  async pair(pin, { identifier, timeoutMs = 4000 } = {}) {
    if (!this._peripheral) throw new Error('pair(): not connected');

    await this.triggerPairing();
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

  /**
   * Forget everything that describes the current link, without touching the peripheral itself.
   * Shared by the disconnect event and by _teardown() so the two can never drift — the failure
   * mode being guarded against is a field left set after the link is gone, which is what makes
   * a state getter lie.
   */
  _resetLinkState() {
    for (const { characteristic, handler } of this._notifySubs) characteristic.removeListener('data', handler);
    this._notifySubs = [];
    if (this._disconnectSub) {
      this._disconnectSub.peripheral.removeListener('disconnect', this._disconnectSub.onDisconnect);
      this._disconnectSub = null;
    }
    this._subscribedChars = [];
    this._notifyChars = [];
    this._writeChar = null;
    this._writeCandidates = [];
    this._reassemblers.clear();
    this._paired = false;
    this.lastNotifyAt = 0;
    this.notifyCount = 0;
    // A pose from a link that is gone is not a reading. Clearing it is what keeps
    // "connected: false with a plausible-looking quaternion" off the status payload, and stops
    // the control loop steering on a pose captured before the link dropped.
    this.lastQuaternion = null;
    this.lastQuaternionAt = 0;
  }

  /**
   * Drop the link and every trace of it. Used by disconnect() and by connect()'s failure path.
   *
   * Emits 'disconnect' itself rather than relying on the peripheral's own event, because
   * _resetLinkState() has just detached that listener — so the event fires exactly once whether
   * the drop was ours or the device's, and a listener (the backend broadcasts status on it)
   * never has to care which.
   */
  async _teardown() {
    const peripheral = this._peripheral;
    this._peripheral = null;
    this._resetLinkState();
    if (!peripheral) return;
    // Capped: peripheral.disconnectAsync() resolves on the peripheral's own 'disconnect' event,
    // which a handle that is already gone at the controller never emits.
    await withTimeout(peripheral.disconnectAsync().catch(() => {}), DISCONNECT_TIMEOUT_MS);
    this.emit('disconnect');
  }

  async disconnect() {
    await this._teardown();
  }
}
