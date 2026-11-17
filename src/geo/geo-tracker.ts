/**
 * GeoTracker — records GPS location, compass bearing, and resolves a mailing
 * address (via Nominatim reverse-geocoding) for the current scan session.
 *
 * Features:
 *   - Watches Geolocation API for continuous position updates
 *   - Samples DeviceOrientationEvent for the compass bearing, from magnetic north: where the back camera
 *     points on Android, the platform's own heading on iOS (see ./compass-heading.ts)
 *   - Caches the most-recent fix in memory and in sessionStorage
 *   - Reverse-geocodes via Nominatim (OSM) — no API key required
 *   - Exposes `snapshot()` for all consumers to grab the current geo context
 *
 * Usage:
 *   const geo = new GeoTracker()
 *   await geo.start()
 *   const fix = geo.snapshot()   // { lat, lng, accuracy, bearing, address, ... }
 */
import { GEO_FIX_SESSION_KEY } from '../shared/storage-keys.ts'
import {
  compassReadingFromEvent,
  pairCompassWithPose,
  rawOrientationOf,
  type CompassReading,
  type CompassRule,
  type CompassSample,
  type PairedCompass,
} from './compass-heading.ts'
import type { Quat } from '../world/types.ts'

export interface GeoFix {
  /** WGS-84 latitude */
  lat: number
  /** WGS-84 longitude */
  lng: number
  /** Horizontal accuracy in metres */
  accuracy: number
  /**
   * Altitude in metres as the platform reports it (null if unavailable). The datum is not the same everywhere:
   * w3c/geolocation issue 210 records Safari returning height above mean sea level and Chrome on Android the
   * WGS-84 ellipsoid value, so no datum can be assumed.
   */
  altitudeM: number | null
  /**
   * Compass bearing in degrees (0-360), clockwise from MAGNETIC north: no declination is applied, so it is not
   * a bearing from true north. Null when this page has no valid reading: none yet, or the last one was flagged
   * invalid by the platform. On Android it is where the back camera points (the top edge of the phone when the
   * camera points more than 60 degrees up or down); which axis an iPhone's heading follows is not established.
   * `GeoTracker.compassReading` says which axis and which north, for every reading.
   */
  bearing: number | null
  /** ISO timestamp of the position fix */
  fixedAt: string
  /** Resolved mailing address (null until geocoding completes) */
  address: string | null
  /** Nominatim display_name (full address string) */
  displayAddress: string | null
  /** Component parts of the address */
  addressComponents: AddressComponents | null
}

export interface AddressComponents {
  houseNumber?: string
  road?: string
  suburb?: string
  city?: string
  state?: string
  postcode?: string
  country?: string
  countryCode?: string
}

/**
 * F117, what leaves the device. Each address lookup sends the fix's latitude and longitude, to six
 * decimal places (about 0.1 m), to nominatim.openstreetmap.org: OpenStreetMap's public reverse
 * geocoder, a third party and not the Scan server. The request also sets Accept-Language and
 * User-Agent ('ci-spatial/1.0') headers (see _geocode), and by default the browser sends the page's
 * origin as Referer. No account, token or Scan cookie goes with it. The four-decimal lookup
 * cell is never sent. Still open, each needing a product decision: a disclosure the user sees (no
 * copy exists yet), and a coarser request in place of six decimal places. The provider is unchanged.
 */
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse'
const SESSION_KEY   = GEO_FIX_SESSION_KEY
/** After a failed lookup a cell waits 5 s, then 10 s, 20 s and so on, up to five minutes. */
const LOOKUP_RETRY_BASE_MS = 5_000
const LOOKUP_RETRY_MAX_MS  = 5 * 60_000

/** The address fields a lookup supplies. They belong to one cell, so they travel together. */
type AddressFields = Pick<GeoFix, 'address' | 'displayAddress' | 'addressComponents'>

/** The lookup cell a position falls in: four decimal places, about 11 m of latitude. */
function cellKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

/**
 * What one orientation event says about the compass, as a bearing only: the heading of
 * {@link compassReadingFromEvent} in degrees (0-360, clockwise, from magnetic north), `null` when the event
 * says the compass cannot be trusted right now, or `undefined` when it says nothing about it (a
 * relative-alpha event, which counts from an arbitrary direction fixed at page load).
 *
 * How each platform's event becomes a heading, which axis of the phone it follows, and why none of it is a
 * bearing from true north, is written in ./compass-heading.ts. The compass spin test on a phone
 * (`?debug=pose`, see `compassSpinTerms()` in src/world/geo.ts) is where the heading is checked against the
 * AR session's own camera. `rule` is the one the page runs under (`?compass=alpha` selects the earlier
 * `360 - alpha`); the default is the camera's bearing.
 */
export function compassBearingFromEvent(e: DeviceOrientationEvent, rule?: CompassRule): number | null | undefined {
  const reading = compassReadingFromEvent(e, rule)
  return reading === undefined || reading === null ? reading : reading.headingDeg
}

export class GeoTracker {
  /** Which rule turns an Android event into a heading: the camera's bearing by default, `360 - alpha` under `?compass=alpha`. */
  private readonly _compassRule: CompassRule
  private _fix: GeoFix | null = null
  /** The reading the compass has now: null until one is taken, and again when the platform flags one invalid. */
  private _compass: CompassReading | null = null
  /** The last event that said anything about the compass, and what was made of it. */
  private _sample: CompassSample | null = null
  private _watchId: number | null = null
  private _orientationBound = false
  /** Address fields per cell, from lookups that answered. */
  private _geocodeCache = new Map<string, AddressFields>()
  /** Cells with a lookup on the wire. A cell never has two at once. */
  private _lookupsInFlight = new Set<string>()
  /** Cells whose last lookup failed: how many times in a row, and when the next try may start (on the performance.now() clock). */
  private _lookupFailures = new Map<string, { count: number, retryAt: number }>()
  private _onUpdate: ((fix: GeoFix) => void) | null = null

  constructor(options: { compassRule?: CompassRule } = {}) {
    this._compassRule = options.compassRule ?? 'attitude'
  }

  /** Callback invoked whenever the fix updates (position, bearing, or address) */
  set onUpdate(fn: (fix: GeoFix) => void) { this._onUpdate = fn }

  get fix(): GeoFix | null { return this._fix }

  /**
   * The compass bearing in degrees, or null when this page has no reading it can
   * trust: none yet, or the platform flagged its last one invalid.
   *
   * Independent of the GPS fix: a phone with a magnetometer and no fix has a
   * bearing, and the calibration needs one indoors, which is where fixes are
   * worst. `snapshot()` is null without a fix, so reading the bearing through it
   * lost the compass whenever GPS did.
   *
   * **No age limit.** A reading is not dropped for being old. Chromium sends an
   * orientation event only when an angle has moved 0.1° or more from the last one
   * it sent (`DeviceOrientationEventPump`, `kOrientationThreshold`), so a phone
   * resting on a surface or a tripod goes silent and its last reading is still the
   * right one: a 2 s limit made the compass vanish while the tester stood still,
   * which is how the spin test is run. The one stale source there was, the bearing
   * restored from an earlier page load, is dropped in `start()`. Hiding the page
   * is not a source: nothing reads the bearing while the page is hidden, and
   * Chromium stops the sensor with the page and sends its first reading again
   * when the page is shown (`PlatformEventController::PageVisibilityChanged`,
   * `DeviceOrientationEventPump::ShouldFireEvent`).
   *
   * A measurement of the compass itself (`?debug=probe`, src/capture/probe-log.ts) needs the sensor and not
   * the fix rule above, which is why this getter exists.
   *
   * Degrees clockwise from magnetic north. {@link compassReading} says which axis of the phone it is the
   * bearing of.
   */
  get compassBearing(): number | null { return this._compass?.headingDeg ?? null }

  /**
   * The reading behind {@link compassBearing}, or null when there is none: the heading with the north it
   * counts from (`northReference`, always `'magnetic'` today), the axis of the phone it follows, where it came
   * from and how uncertain it is (`sigmaDeg`: an iPhone's is never below 25 degrees until a device has been
   * measured). Same lifetime as the bearing: replaced by every event that says something about the compass,
   * and cleared by one that flags it invalid.
   */
  get compassReading(): CompassReading | null { return this._compass }

  /**
   * The last orientation event that said something about the compass, with what was made of it: the raw
   * `alpha`, `beta`, `gamma`, `absolute`, `webkitCompassHeading` and `webkitCompassAccuracy` as the browser
   * delivered them, and the reading taken from them (null when the sample was refused). Null until the first
   * such event. A relative-alpha event is not one, so on Android this is the last ABSOLUTE event and not
   * whichever of the two streams spoke last.
   *
   * The device test of the compass (`?debug=probe`, DX3 in docs/testing/DEVICE_TESTING.md) logs it at each tap,
   * so the candidates for an iPhone's axis can be worked out afterwards from the very values the heading came
   * from.
   */
  get lastCompassSample(): CompassSample | null { return this._sample }

  /**
   * The compass bearing in the form the calibration needs: the bearing the camera's forward direction has, to
   * which the camera's forward yaw in the AR session is added to give the bearing of the session's +Z axis.
   * `cameraRotation` is the AR camera's pose rotation (camera to session), read at the same instant. Null when
   * there is no compass reading, or when the reading is the top edge's and cannot be paired with this pose
   * (see `pairCompassWithPose` in ./compass-heading.ts: a camera that points within about 17 degrees of
   * straight up or down has no bearing to pair). Same lifetime as {@link compassBearing}, and as little
   * dependent on the GPS fix.
   *
   * On Android with the camera within 60 degrees of level this is {@link compassBearing}. Past that
   * `compassBearing` is the top edge's, which is no bearing of the camera, and this is the camera's, derived
   * from it. `via` says which.
   */
  pairedCompass(cameraRotation: Quat): PairedCompass | null { return pairCompassWithPose(this._sample, cameraRotation) }

  /**
   * Start GPS watching and orientation listening.
   * Resolves with the first available fix (may take a few seconds outdoors).
   * If geolocation is unavailable, resolves immediately with null.
   */
  async start(): Promise<GeoFix | null> {
    // Try to restore from previous session
    try {
      const cached = sessionStorage.getItem(SESSION_KEY)
      // The restored address stays on the fix. The first new fix decides whether it still belongs (see _applyPosition).
      // The restored bearing does not: it is what the compass read in an earlier page load, and only a sample taken
      // in this one says where the phone points now.
      const restored = cached ? JSON.parse(cached) as GeoFix | null : null
      if (restored) this._fix = { ...restored, bearing: null }
    } catch { /* ignore */ }

    this._startOrientation()

    return new Promise<GeoFix | null>((resolve) => {
      if (!('geolocation' in navigator)) {
        console.warn('[geo] Geolocation API not available')
        resolve(null)
        return
      }

      let resolved = false

      this._watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const fix = this._applyPosition(pos)
          if (!resolved) {
            resolved = true
            resolve(fix)
          }
          // Non-blocking address lookup
          void this._geocode(fix)
        },
        (err) => {
          console.warn('[geo] Geolocation error:', err.message)
          if (!resolved) { resolved = true; resolve(null) }
        },
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
      )

      // Timeout in case GPS never fires
      setTimeout(() => {
        if (!resolved) { resolved = true; resolve(this._fix) }
      }, 8_000)
    })
  }

  /** Stop watching GPS and orientation */
  stop(): void {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId)
      this._watchId = null
    }
  }

  /**
   * Return a snapshot of the current fix, or null if no fix yet.
   * Always returns the most-recently received value.
   */
  snapshot(): GeoFix | null {
    if (!this._fix) return null
    return { ...this._fix, bearing: this.compassBearing }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _applyPosition(pos: GeolocationPosition): GeoFix {
    const lat = pos.coords.latitude
    const lng = pos.coords.longitude
    // The previous address carries over only while the position stays in the cell it was looked up for.
    const prev = this._fix !== null && cellKey(this._fix.lat, this._fix.lng) === cellKey(lat, lng) ? this._fix : null
    const fix: GeoFix = {
      lat,
      lng,
      accuracy:          pos.coords.accuracy,
      altitudeM:         pos.coords.altitude,
      bearing:           this.compassBearing,
      fixedAt:           new Date(pos.timestamp).toISOString(),
      address:           prev?.address ?? null,
      displayAddress:    prev?.displayAddress ?? null,
      addressComponents: prev?.addressComponents ?? null,
    }
    this._fix = fix
    this._persist()
    this._onUpdate?.(fix)
    return fix
  }

  private _startOrientation(): void {
    if (this._orientationBound) return
    this._orientationBound = true

    const handler = (e: DeviceOrientationEvent) => {
      const reading = compassReadingFromEvent(e, this._compassRule)
      if (reading !== undefined) {
        this._compass = reading
        this._sample = { raw: rawOrientationOf(e), reading }
      }
      if (this._fix) {
        this._fix.bearing = this.compassBearing
        this._onUpdate?.(this._fix)
      }
    }

    window.addEventListener('deviceorientationabsolute', handler as EventListener, { passive: true })
    window.addEventListener('deviceorientation', handler as EventListener, { passive: true })
  }

  private async _geocode(fix: GeoFix): Promise<void> {
    const key = cellKey(fix.lat, fix.lng)
    const cached = this._geocodeCache.get(key)
    if (cached) {
      if (this._applyAddress(key, cached)) this._persist()
      return
    }
    // One request per cell at a time. A cell whose last try failed waits out its backoff first.
    if (this._lookupsInFlight.has(key)) return
    const failed = this._lookupFailures.get(key)
    if (failed && performance.now() < failed.retryAt) return

    this._lookupsInFlight.add(key)
    try {
      // What this request sends, and to whom, is recorded at NOMINATIM_URL (F117).
      const url = new URL(NOMINATIM_URL)
      url.searchParams.set('lat', fix.lat.toFixed(6))
      url.searchParams.set('lon', fix.lng.toFixed(6))
      url.searchParams.set('format', 'json')
      url.searchParams.set('addressdetails', '1')

      const resp = await fetch(url.toString(), {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'ci-spatial/1.0' },
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) throw new Error(`Nominatim answered ${resp.status}`)

      const data = await resp.json() as {
        display_name: string
        address: Record<string, string>
      }

      const a = data.address ?? {}
      const components: AddressComponents = {
        houseNumber: a['house_number'],
        road:        a['road'],
        suburb:      a['suburb'] ?? a['neighbourhood'],
        city:        a['city'] ?? a['town'] ?? a['village'],
        state:       a['state'],
        postcode:    a['postcode'],
        country:     a['country'],
        countryCode: a['country_code']?.toUpperCase(),
      }

      // Build a short mailing-style address: "123 Main St, Springfield, IL 62701"
      const parts = [
        components.houseNumber && components.road
          ? `${components.houseNumber} ${components.road}`
          : components.road,
        components.city,
        components.state && components.postcode
          ? `${components.state} ${components.postcode}`
          : components.state ?? components.postcode,
      ].filter(Boolean)
      const address = parts.join(', ') || data.display_name.split(',').slice(0, 3).join(',')

      const found: AddressFields = {
        address,
        displayAddress:    data.display_name,
        addressComponents: components,
      }
      // Kept even when the walk has moved on: the answer is still right for its own cell.
      this._geocodeCache.set(key, found)
      this._lookupFailures.delete(key)
      if (this._applyAddress(key, found)) this._persist()
    } catch (e) {
      const count = (this._lookupFailures.get(key)?.count ?? 0) + 1
      const wait = Math.min(LOOKUP_RETRY_MAX_MS, LOOKUP_RETRY_BASE_MS * 2 ** (count - 1))
      this._lookupFailures.set(key, { count, retryAt: performance.now() + wait })
      console.warn('[geo] Geocoding failed:', e)
    } finally {
      this._lookupsInFlight.delete(key)
    }
  }

  /**
   * Puts a lookup's address on the current fix, but only while that fix is still in the cell the
   * lookup was for. Returns whether it was applied.
   */
  private _applyAddress(key: string, address: AddressFields): boolean {
    if (!this._fix || cellKey(this._fix.lat, this._fix.lng) !== key) return false
    Object.assign(this._fix, address)
    this._onUpdate?.(this._fix)
    return true
  }

  private _persist(): void {
    try {
      if (this._fix) sessionStorage.setItem(SESSION_KEY, JSON.stringify(this._fix))
    } catch { /* quota exceeded */ }
  }
}
