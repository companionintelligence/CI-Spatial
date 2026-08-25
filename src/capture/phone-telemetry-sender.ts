/**
 * PhoneTelemetrySender — streams the phone's OWN compass / orientation / GPS up to the gimbal
 * backend, so the scanner-control UI can show the phone's absolute heading beside the gimbal's
 * relative one while a scan is running.
 *
 * The flow, end to end:
 *
 *   this class (4Hz tick)
 *     └─ WS send → subsystems/osmo-ble/server/backend.mjs, the SAME /ws socket the control UI
 *        already listens on, so no second server, port, or connection was introduced
 *          └─ handleInboundWsMessage(): isPhoneTelemetry() → normalizePhoneTelemetry()
 *               ├─ cached as `lastPhoneTelemetry`, surfaced on GET /api/status and in the status
 *               │  frame a new client receives on connect (so a late joiner isn't blank)
 *               └─ broadcast to every OTHER /ws client → the control UI's readout
 *
 * Why the two headings are never merged: the gimbal's quaternion is relative to wherever the
 * gimbal booted and carries no compass reference, while the phone's magnetometer is absolute but
 * unreliable indoors near steel and wiring — the exact condition this app scans in. ADR 0005
 * settles it: geometry for relative alignment, compass for absolute orientation. This sender
 * feeds the second half of that pair and nothing else.
 *
 * Degradation is the design, not an afterthought. No orientation permission, no magnetometer, no
 * geolocation, and no reachable socket are each survivable: the affected fields go null, the rest
 * keep flowing, and nothing here throws into a capture session. A field that cannot be measured
 * is reported as null — never as a plausible-looking number (see the heading discussion below).
 *
 * Page integration lives elsewhere on purpose: this module owns sampling and transport, not
 * buttons or layout.
 */
import type { GeoFix, GeoTracker } from '../geo/geo-tracker'

/**
 * Discriminator, mirroring PHONE_TELEMETRY in
 * `subsystems/osmo-ble/protocol/phone_telemetry.mjs`.
 */
export const PHONE_TELEMETRY = 'phone-telemetry'

/**
 * The pinned wire shape, mirroring the `PhoneTelemetry` typedef in
 * `subsystems/osmo-ble/protocol/phone_telemetry.mjs`.
 *
 * This is a deliberate parallel declaration, not a second contract: that file is plain `.mjs`
 * living outside `src/`, carrying JSDoc types rather than TypeScript ones, and this project's
 * `tsconfig.json` compiles `include: ["src"]` with `allowJs` off — so it cannot be imported here
 * as types. Same situation as `vite.config.ts` and `server/main.ts` each holding their own copy
 * of `resolveHostname()`. The consequence is real and worth stating plainly: if the `.mjs`
 * contract changes, this interface must change with it, and nothing will fail loudly if it
 * doesn't — the backend will simply start rejecting frames in `isPhoneTelemetry()`.
 */
export interface PhoneTelemetryFrame {
  type: typeof PHONE_TELEMETRY
  /** Compass heading, degrees clockwise, 0–360. Null whenever no trustworthy heading exists. */
  heading: number | null
  /** Platform-reported ± on `heading`, in degrees. Null when the platform doesn't report one. */
  headingAccuracyDeg: number | null
  /** Device pitch (DeviceOrientationEvent.beta), degrees. */
  pitch: number | null
  /** Device roll (DeviceOrientationEvent.gamma), degrees. */
  roll: number | null
  lat: number | null
  lng: number | null
  /** GPS horizontal accuracy (68% radius), metres. */
  accuracyM: number | null
  altitudeM: number | null
  /** ISO timestamp the frame was assembled on the phone. */
  at: string
  /** Human label for this phone, e.g. 'beam-pro-1'. */
  deviceLabel: string | null
}

/**
 * Which sensor path produced the last heading. Exposed because "null heading" has several very
 * different causes and an operator staring at a blank compass deserves to know which one.
 */
export type HeadingSource =
  /** iOS `webkitCompassHeading`, with a non-negative `webkitCompassAccuracy`. */
  | 'ios-compass'
  /** `DeviceOrientationEvent.alpha` from an event that declared itself absolute. */
  | 'absolute-alpha'
  /** No trustworthy heading — `heading` is null. Includes the refused-permission case. */
  | 'none'

export type OrientationPermission =
  /** `start()` hasn't run yet. */
  | 'not-requested'
  /** This browser has no `DeviceOrientationEvent.requestPermission` — nothing to ask for. */
  | 'not-required'
  | 'granted'
  /** Refused by the user, OR the request itself failed — see `permissionError` to tell which. */
  | 'denied'

export interface PhoneTelemetryStatus {
  /** `start()` has run and `stop()` hasn't. */
  running: boolean
  /** Socket is open right now. */
  connected: boolean
  orientationPermission: OrientationPermission
  /**
   * Set when the permission request threw rather than resolving — on iOS that usually means
   * `start()` was not called from inside a real user gesture, which is NOT the same as the user
   * saying no. Kept separate so a wiring bug isn't misreported as a user decision.
   */
  permissionError: string | null
  headingSource: HeadingSource
  /** Frames handed to `send()` without throwing. Not an acknowledgement of delivery. */
  framesSent: number
}

export interface PhoneTelemetrySenderOptions {
  /** Full `ws://…/ws` or `wss://…/ws` URL of the gimbal backend. See `phoneTelemetryWsUrl()`. */
  url: string
  /**
   * The app's EXISTING GeoTracker. Only `snapshot()` is used, so a caller can pass the live
   * tracker it already started (`src/geo/geo-tracker.ts`) — do not construct a second one just
   * for this, and do not add a second geolocation wrapper here: two `watchPosition` watches on
   * one page means two GPS duty cycles on a phone that is already recording video.
   *
   * Omit it and lat/lng/accuracy/altitude simply stay null; everything else still streams.
   */
  geo?: Pick<GeoTracker, 'snapshot'> | null
  /** Human label carried on every frame so the UI can name the phone. */
  deviceLabel?: string | null
  /** Send rate, clamped to 0.5–20Hz. Default 4Hz. */
  hz?: number
}

const DEFAULT_HZ = 4
const MIN_HZ = 0.5
const MAX_HZ = 20
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 15_000
/**
 * Skip a tick when the socket already has this much unsent. `send()` never blocks — it queues —
 * so a phone at the edge of Wi-Fi otherwise accumulates a backlog of telemetry that will arrive
 * as a burst of stale samples. Dropping a sample is the right call for a stream whose only value
 * is being current.
 */
const MAX_BUFFERED_BYTES = 16_384

/** Wrap any degree value into 0–360. */
function normalizeDeg(deg: number): number {
  const wrapped = deg % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/**
 * Browser-side twin of `normalizePhoneTelemetry()`'s `n()` in the protocol module (which can't be
 * imported here — see `PhoneTelemetryFrame`). Not cosmetic: a NaN reaching the backend fails
 * `isPhoneTelemetry()`, and the whole frame — heading, position, everything — gets dropped.
 */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Build the backend's WebSocket URL from its HTTP origin, e.g.
 * `http://gimbal-host:8788` → `ws://gimbal-host:8788/ws`. Offered so the integrating page doesn't
 * have to hand-assemble it (and get the scheme swap wrong on an HTTPS page).
 */
export function phoneTelemetryWsUrl(backendHttpUrl: string): string {
  const url = new URL(backendHttpUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export class PhoneTelemetrySender {
  private readonly _url: string
  private readonly _geo: Pick<GeoTracker, 'snapshot'> | null
  private readonly _deviceLabel: string | null
  private readonly _periodMs: number

  private _ws: WebSocket | null = null
  private _timer: ReturnType<typeof setInterval> | null = null
  private _reconnectHandle: ReturnType<typeof setTimeout> | null = null
  private _reconnectDelay = RECONNECT_BASE_MS
  private _running = false
  private _orientationBound = false
  private _permission: OrientationPermission = 'not-requested'
  private _permissionError: string | null = null
  private _framesSent = 0

  // Latest sensor values, written by the orientation listener and read by the send tick.
  //
  // THIS SPLIT IS THE THROTTLE. DeviceOrientation fires at the display rate — 60Hz on most
  // phones, more on some — and doing anything per event (building a frame, touching the socket)
  // would be 15x the necessary work and 15x the radio traffic for a readout a human is looking
  // at. The listener only assigns fields; the interval decides when a frame goes out. Nothing
  // accumulates, so a slow tick can never build a backlog of sensor events: the tick always
  // sends the newest reading and the intermediate ones are simply overwritten, which is the
  // correct behaviour for a live attitude readout.
  private _heading: number | null = null
  private _headingAccuracyDeg: number | null = null
  private _headingSource: HeadingSource = 'none'
  private _pitch: number | null = null
  private _roll: number | null = null
  /**
   * True once an absolute-frame orientation event has arrived. Android Chrome fires BOTH
   * `deviceorientationabsolute` (earth-referenced) and `deviceorientation` (relative alpha) at
   * full rate; without this latch the relative events would clear the heading microseconds after
   * each absolute event set it, and the readout would flicker between a bearing and nothing at
   * whatever phase the tick happened to sample. iOS never fires the absolute event, so this stays
   * false there and the `deviceorientation` stream (which carries `webkitCompassHeading`) is used.
   */
  private _absoluteSeen = false

  constructor(options: PhoneTelemetrySenderOptions) {
    this._url = options.url
    this._geo = options.geo ?? null
    this._deviceLabel = options.deviceLabel ?? null
    // Math.min/max propagate NaN rather than clamping it, so a NaN `hz` (an unparsed query
    // param, a bad config value) would survive the clamp, make `1000 / hz` NaN, and
    // `setInterval(fn, NaN)` silently degrades to the ~4ms minimum — a ~250x overshoot that
    // floods the socket and the backend's re-broadcast. Reject non-finite input up front.
    const requested = Number.isFinite(options.hz as number) ? (options.hz as number) : DEFAULT_HZ
    const hz = Math.min(MAX_HZ, Math.max(MIN_HZ, requested))
    this._periodMs = Math.round(1000 / hz)
  }

  /**
   * Start sampling and sending.
   *
   * **Call this synchronously from inside a real user-gesture handler** (a click/tap listener).
   * iOS requires `DeviceOrientationEvent.requestPermission()` to originate in a gesture, and this
   * method issues that request before its first `await` so the gesture is still live when it
   * fires. Called from a timer or a promise chain on iOS, the request rejects — which is recorded
   * as `permissionError`, not silently treated as a refusal.
   *
   * Never throws, and never rejects. A denied permission, an absent sensor, and an unreachable
   * backend all resolve to a running sender that reports nulls for what it cannot measure.
   */
  async start(): Promise<PhoneTelemetryStatus> {
    if (this._running) return this.status()
    this._running = true
    await this._requestOrientationPermission()
    // stop() can land during that await — the permission sheet is modal and backing out of the
    // panel while it is up is an ordinary thing for an operator to do. Without this guard the
    // work below would run after stop() had already torn everything down, leaving a 4Hz timer
    // and two sensor listeners alive for the life of the page.
    if (!this._running) return this.status()
    this._bindOrientation()
    this._openSocket()
    this._timer = setInterval(() => this._tick(), this._periodMs)
    return this.status()
  }

  /** Stop sending, unbind sensors, close the socket. Idempotent. */
  stop(): void {
    this._running = false
    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._reconnectHandle !== null) {
      clearTimeout(this._reconnectHandle)
      this._reconnectHandle = null
    }
    this._reconnectDelay = RECONNECT_BASE_MS
    if (this._orientationBound) {
      window.removeEventListener('deviceorientationabsolute', this._onAbsoluteOrientation)
      window.removeEventListener('deviceorientation', this._onRelativeOrientation)
      this._orientationBound = false
    }
    try {
      this._ws?.close()
    } catch {
      // Already closing or closed — nothing left to do, and this must not throw out of stop().
    }
    this._ws = null
  }

  status(): PhoneTelemetryStatus {
    return {
      running: this._running,
      connected: this._ws !== null && this._ws.readyState === WebSocket.OPEN,
      orientationPermission: this._permission,
      permissionError: this._permissionError,
      headingSource: this._headingSource,
      framesSent: this._framesSent,
    }
  }

  /**
   * The frame that would be sent right now. Safe before `start()` and after `stop()` — it just
   * reports nulls for whatever isn't being sampled. Exposed so a page can render the same numbers
   * locally without a second sampling path.
   *
   * `at` is when this frame was ASSEMBLED, not when each component was measured. The GPS fix in
   * particular can be seconds old — `GeoTracker` watches position continuously and hands back its
   * most recent one — and the pinned contract carries a single timestamp, so a stale fix is
   * republished under a fresh `at` rather than being given an invented age. Treat `at` as frame
   * time and `accuracyM` as the honest statement about the position.
   */
  sample(): PhoneTelemetryFrame {
    const fix = this._snapshotGeo()
    return {
      type: PHONE_TELEMETRY,
      heading: this._heading,
      headingAccuracyDeg: this._headingAccuracyDeg,
      pitch: this._pitch,
      roll: this._roll,
      lat: finiteOrNull(fix?.lat),
      lng: finiteOrNull(fix?.lng),
      accuracyM: finiteOrNull(fix?.accuracy),
      altitudeM: finiteOrNull(fix?.altitudeM),
      at: new Date().toISOString(),
      deviceLabel: this._deviceLabel,
    }
  }

  // ── Sensors ────────────────────────────────────────────────────────────────────────────────

  private async _requestOrientationPermission(): Promise<void> {
    // Same shape main.ts uses for its AR-start gate: the method only exists on iOS, so it is
    // reached through a cast rather than the DOM lib's type.
    type PermissionApi = { requestPermission?(): Promise<string> }
    if (typeof DeviceOrientationEvent === 'undefined') {
      this._permission = 'denied'
      this._permissionError = 'DeviceOrientationEvent does not exist in this browser'
      return
    }
    const api = DeviceOrientationEvent as unknown as PermissionApi
    if (typeof api.requestPermission !== 'function') {
      // Android/desktop: no gate to pass. This is NOT a claim that a magnetometer exists — if
      // there is none, no event ever fires and `heading` stays null on its own.
      this._permission = 'not-required'
      return
    }
    let outcome: string
    try {
      outcome = await api.requestPermission()
    } catch (err) {
      // iOS rejects (rather than resolving 'denied') when the call didn't originate in a user
      // gesture. Recorded distinctly because the remedies are different: one is "the user must
      // change their mind", the other is "the integrating page called start() from the wrong
      // place". Either way heading/pitch/roll stay null rather than being faked.
      this._permission = 'denied'
      this._permissionError = err instanceof Error ? err.message : String(err)
      console.warn('[phone-telemetry] orientation permission request failed — heading/pitch/roll will stay null', err)
      return
    }
    this._permission = outcome === 'granted' ? 'granted' : 'denied'
    if (this._permission === 'denied') {
      console.warn(`[phone-telemetry] orientation permission "${outcome}" — heading/pitch/roll will stay null`)
    }
  }

  private _bindOrientation(): void {
    if (this._orientationBound) return
    // Refused permission means no event will ever fire; binding anyway would just leave listeners
    // on the page implying a data source that doesn't exist.
    if (this._permission === 'denied') return
    this._orientationBound = true
    window.addEventListener('deviceorientationabsolute', this._onAbsoluteOrientation, { passive: true })
    window.addEventListener('deviceorientation', this._onRelativeOrientation, { passive: true })
  }

  // Two stable bound listeners rather than one, because the EVENT NAME is itself evidence about
  // the reference frame — `deviceorientationabsolute` is earth-referenced by definition, while
  // `deviceorientation` may or may not be. Stable fields so stop() can actually remove them.
  private readonly _onAbsoluteOrientation = (event: Event): void => {
    this._ingestOrientation(event, true)
  }

  private readonly _onRelativeOrientation = (event: Event): void => {
    this._ingestOrientation(event, false)
  }

  /**
   * Fold one orientation event into the latest-sample fields.
   *
   * **The heading rule, and why it is this strict.** `webkitCompassHeading` and
   * `DeviceOrientationEvent.alpha` are not the same measurement and are not equally trustworthy:
   *
   *   - `webkitCompassHeading` (iOS/WebKit) is a real compass bearing from CoreLocation, in
   *     degrees clockwise, and it comes with `webkitCompassAccuracy`. A NEGATIVE accuracy is
   *     iOS's documented way of saying the heading is invalid (uncalibrated magnetometer,
   *     typically). We honour that and report null — `src/geo/geo-tracker.ts` takes this value
   *     without checking the accuracy, and this is a deliberate, narrow divergence from it, not
   *     an oversight: this frame has a `headingAccuracyDeg` field, so the accuracy has to be read
   *     anyway, and once read, ignoring "invalid" would be a choice to publish a known-bad number.
   *   - `alpha` is only earth-referenced when the event says so. On many Android builds a plain
   *     `deviceorientation` event's alpha is measured from an ARBITRARY origin fixed at page load
   *     — it looks exactly like a compass bearing, changes exactly like one when you turn, and is
   *     offset from north by an unknown constant. Passing that off as a bearing would put a
   *     confidently wrong arrow on the operator's screen, which is worse than an empty one. So
   *     relative alpha is discarded and `heading` reports null with `headingSource: 'none'`.
   *
   * **What "true north" means here, honestly.** The pinned contract documents `heading` as degrees
   * from TRUE north. The web platform cannot actually guarantee that: iOS applies magnetic
   * declination when CoreLocation has a position fix (and falls back to magnetic north when it
   * doesn't), and Android's absolute orientation is generally magnetic-north referenced with no
   * declination applied — and neither exposes a flag saying which you got. So the value sent is
   * the platform's best compass bearing, which is true north where the platform managed it and
   * magnetic north otherwise; the difference is the local declination, a few degrees in most
   * populated places. This is not measurable from here, and no correction is applied for it.
   *
   * No screen-rotation compensation is applied either. The reported bearing is the platform's,
   * for the top edge of the device; whether a given browser has already accounted for
   * `screen.orientation.angle` has not been measured on this hardware, so applying a rotation
   * here would be a guess layered on an unknown.
   *
   * `pitch`/`roll` are the raw `beta`/`gamma` channels, passed through unmodified. They are
   * device-frame tilt angles, not a calibrated attitude, and they degenerate near beta ±90° the
   * way all Euler triples do.
   */
  private _ingestOrientation(event: Event, fromAbsoluteEvent: boolean): void {
    const e = event as DeviceOrientationEvent & {
      webkitCompassHeading?: number
      webkitCompassAccuracy?: number
    }
    const absolute = fromAbsoluteEvent || e.absolute === true
    if (absolute) this._absoluteSeen = true
    // Once the absolute stream is proven live, the relative one carries no information we want —
    // and reading its alpha would mean mixing two reference frames in one field.
    else if (this._absoluteSeen) return

    this._pitch = finiteOrNull(e.beta)
    this._roll = finiteOrNull(e.gamma)

    const compass = finiteOrNull(e.webkitCompassHeading)
    if (compass !== null) {
      const accuracy = finiteOrNull(e.webkitCompassAccuracy)
      if (accuracy !== null && accuracy < 0) {
        this._setNoHeading()
        return
      }
      this._heading = normalizeDeg(compass)
      this._headingAccuracyDeg = accuracy
      this._headingSource = 'ios-compass'
      return
    }

    const alpha = finiteOrNull(e.alpha)
    if (absolute && alpha !== null) {
      // Same conversion src/geo/geo-tracker.ts uses for this path: alpha counts counter-clockwise
      // from the reference direction, a compass bearing counts clockwise.
      this._heading = normalizeDeg(360 - alpha)
      // No accuracy channel exists on this path at all. Null means unknown, per the contract —
      // it does not mean "accurate".
      this._headingAccuracyDeg = null
      this._headingSource = 'absolute-alpha'
      return
    }

    this._setNoHeading()
  }

  private _setNoHeading(): void {
    this._heading = null
    this._headingAccuracyDeg = null
    this._headingSource = 'none'
  }

  private _snapshotGeo(): GeoFix | null {
    if (!this._geo) return null
    try {
      return this._geo.snapshot()
    } catch (err) {
      // The tracker is someone else's object; a throw here must cost one frame's position, not
      // the telemetry stream.
      console.warn('[phone-telemetry] geo snapshot failed', err)
      return null
    }
  }

  // ── Transport ──────────────────────────────────────────────────────────────────────────────

  private _tick(): void {
    const ws = this._ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return
    try {
      ws.send(JSON.stringify(this.sample()))
      this._framesSent++
    } catch (err) {
      // The socket can close between the readyState check above and this send. Logged and
      // dropped: 'close' schedules the reconnect, and a failed telemetry frame must never
      // interrupt a capture in progress.
      console.warn('[phone-telemetry] send failed', err)
    }
  }

  private _openSocket(): void {
    if (!this._running) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this._url)
    } catch (err) {
      // `new WebSocket()` throws SYNCHRONOUSLY on a malformed URL or a blocked scheme — notably
      // ws:// from an https:// page, which is exactly the mixed-content shape this app's Tailscale
      // HTTPS setup invites. Guarded for the same reason src/viewer/livefeed.ts guards it: this
      // runs inside a page that is doing something more important than telemetry.
      console.warn('[phone-telemetry] socket could not be opened', err)
      this._scheduleReconnect()
      return
    }
    this._ws = ws

    ws.addEventListener('open', () => {
      this._reconnectDelay = RECONNECT_BASE_MS
    })
    ws.addEventListener('error', () => {
      // Intentionally quiet: a WebSocket 'error' is always followed by 'close', and the reconnect
      // is handled exactly once, there.
    })
    ws.addEventListener('close', () => {
      if (this._ws === ws) this._ws = null
      this._scheduleReconnect()
    })
    // No 'message' listener on purpose: this is a one-way uplink. The control UI, not the phone,
    // is what consumes the relayed frames — a page that also wants to *read* /ws should keep its
    // own socket rather than have this one grow a second responsibility.
  }

  private _scheduleReconnect(): void {
    if (!this._running) return
    if (this._reconnectHandle !== null) return
    const delay = this._reconnectDelay
    this._reconnectHandle = setTimeout(() => {
      this._reconnectHandle = null
      this._openSocket()
    }, delay)
    // Backoff rather than a flat retry, same 1s→15s shape as the viewer's sockets: the common
    // cause of failure here is "the backend isn't running", and hammering it every second for the
    // length of a scan costs the phone's battery for nothing.
    this._reconnectDelay = Math.min(RECONNECT_MAX_MS, delay * 2)
  }
}
