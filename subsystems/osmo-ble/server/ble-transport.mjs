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
import { MsgIdSequence, buildSetPairingPin, buildGimbalSpeedControl } from '../protocol/commands.mjs';
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
 * Cap on the zero-speed write disconnect() sends first. A write to a link that has silently gone
 * can hang, and a hung stop must not hold the disconnect open.
 */
const STOP_WRITE_TIMEOUT_MS = 2000;
/**
 * Cap on one GATT write in sendRaw(). A write to a link that has silently gone never answers, and an
 * external motion holds the gimbal interlock for as long as its write is pending. Generous for a healthy
 * link (a write with response takes tens of milliseconds), so it fires only on a link that is gone.
 */
const WRITE_TIMEOUT_MS = 2000;
/**
 * Cap on the pairing trigger's write. That write is the one that makes the OS show its confirmation dialog,
 * and it may hold until someone answers that dialog, so the 2 s motion cap could cut it short. Still finite:
 * a link that has gone must fail the request, not hold it open. Hardware checking of when the write returns
 * is pending, see the README.
 */
export const PAIRING_TRIGGER_TIMEOUT_MS = 60000;
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
    /** Bumped on every link reset. A write that spans a reset must not latch the characteristic it used. */
    this._linkGeneration = 0;
    /** The disconnect still stopping the gimbal, if one is running. connect() waits for it. */
    this._disconnecting = null;
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
    // A disconnect that is still stopping the gimbal owns the current link until it finishes.
    // Connecting now would let that disconnect tear the new link down, so wait for it first.
    if (this._disconnecting) await this._disconnecting.catch(() => {});
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
   *
   * Capped at PAIRING_TRIGGER_TIMEOUT_MS rather than the 2 s motion cap, because the OS confirmation
   * dialog this write may hold open waits on a person.
   */
  async triggerPairing() {
    if (!this._peripheral) throw new Error('triggerPairing(): not connected');
    await this.sendRaw(PAIRING_TRIGGER_BYTES, { timeoutMs: PAIRING_TRIGGER_TIMEOUT_MS });
  }

  /**
   * Run the pairing handshake: trigger + SetPairingPIN, probing fff5-then-fff3 for whichever
   * one the device actually accepts writes on. `pin` must be read off the device's own screen —
   * see protocol/commands.mjs for why a hardcoded default is unsafe to assume.
   */
  async pair(pin, { identifier, timeoutMs = 4000 } = {}) {
    if (!this._peripheral) throw new Error('pair(): not connected');
    // The link this pairing started on, checked before `_paired` is latched (the same check sendRaw uses).
    const generation = this._linkGeneration;

    await this.triggerPairing();
    await sleep(1000);

    const msgId = this._msgIds.next();
    const frame = buildSetPairingPin(msgId, pin, identifier);

    const response = await this._writeAndAwaitResponse(frame, { cmdSet: 0x07, cmdId: 0x45, timeoutMs });
    if (!response) {
      throw new Error('pair(): no response to SetPairingPIN on either fff5 or fff3 — device may use a different characteristic mapping than researched, or may not be in range/pairing mode');
    }
    const status = response.payload.length >= 2 ? response.payload[1] : response.payload[0];
    // Latch only if the link is still the one this pairing started on. A teardown during the wait has
    // already cleared the pairing, and a response that arrives after it must not latch it again.
    if (generation === this._linkGeneration) this._paired = true;
    return { alreadyPaired: status === 0x01, pairingRequired: status === 0x02, raw: response };
  }

  /**
   * Write a pre-built DUML frame using the latched write characteristic, probing candidates
   * on the first call if none is latched yet. `timeoutMs` caps each write; the default is the motion cap.
   */
  async sendRaw(frameBytes, { timeoutMs = WRITE_TIMEOUT_MS } = {}) {
    if (this._writeChar) {
      await this._writeCapped(this._writeChar, frameBytes, timeoutMs);
      return;
    }
    const generation = this._linkGeneration;
    for (const candidate of this._writeCandidates) {
      try {
        await this._writeCapped(candidate, frameBytes, timeoutMs);
        // Latch only if the link is still the one this write started on. A teardown during the write
        // has already cleared the link, and a stale latch would send every later frame to a dead handle.
        if (generation === this._linkGeneration) this._writeChar = candidate;
        return;
      } catch (err) {
        // A write that never answered means the link is gone, not that this characteristic is the wrong
        // one, so the frame is not sent again on the next candidate.
        if (err.timedOut) throw err;
        // otherwise try next candidate
      }
    }
    throw new Error('sendRaw(): failed to write on any known characteristic (fff5, fff3)');
  }

  /**
   * One GATT write, rejected with `timedOut` set if it has not answered within `timeoutMs`.
   * Without the cap, a write that never returns holds its caller forever, and an external motion
   * holds the gimbal interlock for as long as its write is pending.
   */
  async _writeCapped(candidate, frameBytes, timeoutMs = WRITE_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`sendRaw(): no answer to a write on ${candidate.uuid} within ${timeoutMs} ms — the link is probably gone.`);
        err.timedOut = true;
        reject(err);
      }, timeoutMs);
    });
    try {
      await Promise.race([
        candidate.characteristic.writeAsync(Buffer.from(frameBytes), candidate.withResponse === false),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Internal: write + wait for a matching response frame, trying each write candidate in order. */
  async _writeAndAwaitResponse(frameBytes, { cmdSet, cmdId, timeoutMs }) {
    const generation = this._linkGeneration;
    for (const candidate of this._writeCandidates) {
      const waiter = this._waitForFrame((f) => f.cmdSet === cmdSet && f.cmdId === cmdId && (f.flags & 0x80) !== 0, timeoutMs);
      try {
        await candidate.characteristic.writeAsync(Buffer.from(frameBytes), candidate.withResponse === false);
      } catch {
        continue;
      }
      const response = await waiter;
      if (response) {
        if (generation === this._linkGeneration) this._writeChar = candidate;
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
    this._linkGeneration += 1;
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

  /**
   * Drop the link, stopping the motors first.
   *
   * The gimbal's speed command is a latch: a link torn down while a speed is outstanding leaves the
   * gimbal driving, and nothing can reach it once the link is gone. So the zero-speed frame goes out
   * before _teardown() clears the write characteristic. It is gated on `linked`, not `connected`,
   * for the reason stopMotors() in backend.mjs gives: a link that has stopped reporting is the one
   * most likely to be latched. Every caller is covered this way: POST /api/disconnect, the macOS
   * unpair, and any caller added later.
   */
  async disconnect() {
    // Published as pending, so a connect() that starts during the stop window waits for this teardown
    // instead of being torn down by it. The stop write awaits, and the link must not change under it.
    const run = this._stopAndTeardown();
    this._disconnecting = run;
    try {
      await run;
    } finally {
      if (this._disconnecting === run) this._disconnecting = null;
    }
  }

  /** The stop and the teardown of the link that was up when disconnect() was called. */
  async _stopAndTeardown() {
    if (this.linked) {
      await withTimeout(this.sendRaw(buildGimbalSpeedControl(this.nextMsgId(), {})), STOP_WRITE_TIMEOUT_MS);
    }
    await this._teardown();
  }
}
