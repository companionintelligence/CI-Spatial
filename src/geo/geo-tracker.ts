/**
 * GeoTracker — records GPS location, compass bearing, and resolves a mailing
 * address (via Nominatim reverse-geocoding) for the current scan session.
 *
 * Features:
 *   - Watches Geolocation API for continuous position updates
 *   - Samples DeviceOrientationEvent for compass heading (absolute or relative)
 *   - Caches the most-recent fix in memory and in sessionStorage
 *   - Reverse-geocodes via Nominatim (OSM) — no API key required
 *   - Exposes `snapshot()` for all consumers to grab the current geo context
 *
 * Usage:
 *   const geo = new GeoTracker()
 *   await geo.start()
 *   const fix = geo.snapshot()   // { lat, lng, accuracy, bearing, address, ... }
 */

export interface GeoFix {
  /** WGS-84 latitude */
  lat: number
  /** WGS-84 longitude */
  lng: number
  /** Horizontal accuracy in metres */
  accuracy: number
  /** Altitude in metres above sea level (null if unavailable) */
  altitudeM: number | null
  /** True-north compass bearing in degrees (0-360, null if unavailable) */
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

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse'
const SESSION_KEY   = 'ci-xr-geo-fix'

export class GeoTracker {
  private _fix: GeoFix | null = null
  private _bearing: number | null = null
  private _watchId: number | null = null
  private _orientationBound = false
  private _geocodeCache = new Map<string, GeoFix>()
  private _onUpdate: ((fix: GeoFix) => void) | null = null

  /** Callback invoked whenever the fix updates (position, bearing, or address) */
  set onUpdate(fn: (fix: GeoFix) => void) { this._onUpdate = fn }

  get fix(): GeoFix | null { return this._fix }

  /**
   * Start GPS watching and orientation listening.
   * Resolves with the first available fix (may take a few seconds outdoors).
   * If geolocation is unavailable, resolves immediately with null.
   */
  async start(): Promise<GeoFix | null> {
    // Try to restore from previous session
    try {
      const cached = sessionStorage.getItem(SESSION_KEY)
      if (cached) {
        this._fix = JSON.parse(cached) as GeoFix
      }
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
    return { ...this._fix, bearing: this._bearing ?? this._fix.bearing }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _applyPosition(pos: GeolocationPosition): GeoFix {
    const fix: GeoFix = {
      lat:               pos.coords.latitude,
      lng:               pos.coords.longitude,
      accuracy:          pos.coords.accuracy,
      altitudeM:         pos.coords.altitude,
      bearing:           this._bearing ?? null,
      fixedAt:           new Date(pos.timestamp).toISOString(),
      address:           this._fix?.address ?? null,
      displayAddress:    this._fix?.displayAddress ?? null,
      addressComponents: this._fix?.addressComponents ?? null,
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
      // `webkitCompassHeading` is iOS (degrees from true north, CW).
      // `alpha` with `absolute=true` is Android — needs negation/wrapping.
      const ios = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
      if (typeof ios === 'number') {
        this._bearing = ios
      } else if (e.absolute && typeof e.alpha === 'number') {
        this._bearing = (360 - e.alpha) % 360
      }
      if (this._fix) {
        this._fix.bearing = this._bearing
        this._onUpdate?.(this._fix)
      }
    }

    window.addEventListener('deviceorientationabsolute', handler as EventListener, { passive: true })
    window.addEventListener('deviceorientation', handler as EventListener, { passive: true })
  }

  private async _geocode(fix: GeoFix): Promise<void> {
    const key = `${fix.lat.toFixed(4)},${fix.lng.toFixed(4)}`
    if (this._geocodeCache.has(key)) {
      const cached = this._geocodeCache.get(key)!
      if (this._fix) {
        this._fix.address           = cached.address
        this._fix.displayAddress    = cached.displayAddress
        this._fix.addressComponents = cached.addressComponents
        this._onUpdate?.(this._fix)
      }
      return
    }

    try {
      const url = new URL(NOMINATIM_URL)
      url.searchParams.set('lat', fix.lat.toFixed(6))
      url.searchParams.set('lon', fix.lng.toFixed(6))
      url.searchParams.set('format', 'json')
      url.searchParams.set('addressdetails', '1')

      const resp = await fetch(url.toString(), {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'ci-xr-scan/1.0' },
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) return

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

      const update: Partial<GeoFix> = {
        address,
        displayAddress:    data.display_name,
        addressComponents: components,
      }
      Object.assign(fix, update)
      if (this._fix) {
        Object.assign(this._fix, update)
        this._geocodeCache.set(key, { ...this._fix })
        this._persist()
        this._onUpdate?.(this._fix)
      }
    } catch (e) {
      console.warn('[geo] Geocoding failed:', e)
    }
  }

  private _persist(): void {
    try {
      if (this._fix) sessionStorage.setItem(SESSION_KEY, JSON.stringify(this._fix))
    } catch { /* quota exceeded */ }
  }
}
