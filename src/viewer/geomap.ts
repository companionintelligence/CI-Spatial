/**
 * GeoMap — Leaflet-based map drawer for the 3D viewer.
 *
 * Shows a map panel (slide-in drawer) with:
 *   - OpenStreetMap tile layer (no API key required)
 *   - A pin for every scan that has GPS metadata (from scan scene.userData)
 *   - Clicking a pin selects that scan in the sidebar list
 *   - Compass bearing indicator on each pin
 *
 * Leaflet is loaded from CDN to avoid bundling it.
 */

export interface ScanLocationEntry {
  filename: string
  lat: number
  lng: number
  bearing: number | null
  address: string | null
  capturedAt: string | null
  pointCount: number | null
  detectionCount: number | null
  scanName: string | null
}

export type ScanSelectCallback = (filename: string) => void

/** Dynamically load Leaflet CSS + JS from CDN */
async function loadLeaflet(): Promise<typeof import('leaflet')> {
  // Check if already loaded
  if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)['L']) {
    return (window as unknown as Record<string, unknown>)['L'] as typeof import('leaflet')
  }

  // Inject CSS
  if (!document.querySelector('link[data-leaflet]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
    link.dataset['leaflet'] = '1'
    document.head.appendChild(link)
  }

  // Inject JS
  await new Promise<void>((resolve, reject) => {
    if (document.querySelector('script[data-leaflet]')) { resolve(); return }
    const script = document.createElement('script')
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
    script.dataset['leaflet'] = '1'
    script.onload  = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Leaflet'))
    document.head.appendChild(script)
  })

  return (window as unknown as Record<string, unknown>)['L'] as typeof import('leaflet')
}

export class GeoMap {
  private _container: HTMLElement | null = null
  private _mapEl: HTMLElement | null = null
  private _map: unknown = null  // Leaflet map instance (typed loosely to avoid bundle)
  private _L: typeof import('leaflet') | null = null
  private _markers: unknown[] = []
  private _locations: ScanLocationEntry[] = []
  private _emptyEl: HTMLElement | null = null
  private _onSelect: ScanSelectCallback | null = null
  private _open = false

  set onScanSelect(fn: ScanSelectCallback) { this._onSelect = fn }

  /** Mount the drawer into the DOM (inserting before the given parent element) */
  mount(parentEl: HTMLElement): void {
    if (this._container) return
    this._container = this._buildDrawer()
    parentEl.appendChild(this._container)
  }

  toggle(): void {
    this._open ? this.close() : this.open()
  }

  open(): void {
    if (!this._container) return
    this._open = true
    this._container.style.display = 'flex'
    // Trigger CSS transition
    requestAnimationFrame(() => {
      if (this._container) this._container.classList.add('geomap-open')
    })
    setTimeout(() => this._refreshMapSize(), 80)
    setTimeout(() => this._refreshMapSize(), 360)
  }

  close(): void {
    if (!this._container) return
    this._open = false
    this._container.classList.remove('geomap-open')
    // Hide after transition
    setTimeout(() => {
      if (this._container && !this._open) this._container.style.display = 'none'
    }, 320)
  }

  /**
   * Populate the map with scan location pins.
   * Call this whenever the scan list or metadata changes.
   */
  async updatePins(locations: ScanLocationEntry[]): Promise<void> {
    if (!this._mapEl) return

    // Lazy-load Leaflet
    if (!this._L) {
      try {
        this._L = await loadLeaflet()
      } catch (e) {
        console.error('[geomap] Leaflet load failed:', e)
        this._setEmptyState(true, 'Map unavailable')
        return
      }
    }

    const L = this._L
    const validLocs = locations.filter(l => l.lat !== 0 || l.lng !== 0)
    this._locations = validLocs

    if (!this._map) {
      const center: [number, number] = validLocs.length > 0
        ? [validLocs[0]!.lat, validLocs[0]!.lng]
        : [51.505, -0.09]  // London fallback

      this._map = L.map(this._mapEl!, {
        center,
        zoom: validLocs.length > 0 ? 17 : 10,
        maxZoom: 19,
        zoomControl: true,
      })

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap © CARTO',
        subdomains: 'abcd',
        maxZoom: 19,
        maxNativeZoom: 19,
      }).addTo(this._map as import('leaflet').Map)
    }

    // Clear existing markers
    for (const m of this._markers) {
      (m as import('leaflet').Marker).remove()
    }
    this._markers = []

    const bounds: [number, number][] = []

    for (const loc of validLocs) {
      const bearingDeg = loc.bearing ?? 0
      const html = buildPinHtml(loc, bearingDeg)

      const icon = L.divIcon({
        html,
        className: 'geomap-pin-wrapper',
        iconSize: [36, 36],
        iconAnchor: [18, 36],
        popupAnchor: [0, -40],
      })

      const popupContent = buildPopupHtml(loc)

      const marker = L.marker([loc.lat, loc.lng], { icon })
        .bindPopup(popupContent, { maxWidth: 240, className: 'geomap-popup' })
        .addTo(this._map as import('leaflet').Map)

      marker.on('click', () => {
        this._onSelect?.(loc.filename)
      })

      this._markers.push(marker)
      bounds.push([loc.lat, loc.lng])
    }

    this._setEmptyState(bounds.length === 0)
    this._fitToPins()
    this._refreshMapSize()
  }

  // ── Private builders ────────────────────────────────────────────────────────

  private _refreshMapSize(): void {
    if (!this._map || !this._L) return
    const map = this._map as import('leaflet').Map
    map.invalidateSize()
    this._fitToPins()
  }

  private _fitToPins(): void {
    if (!this._map || this._locations.length === 0) return
    const map = this._map as import('leaflet').Map
    const bounds = this._locations.map(loc => [loc.lat, loc.lng] as [number, number])
    if (bounds.length === 1) {
      map.setView(bounds[0]!, 17)
    } else {
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 18 })
    }
  }

  private _setEmptyState(empty: boolean, message = 'No geotagged scans yet'): void {
    const countEl = document.getElementById('geomap-count')
    if (countEl) countEl.textContent = this._locations.length > 0 ? `${this._locations.length} mapped` : '0 mapped'
    if (!this._emptyEl) return
    this._emptyEl.style.display = empty ? 'flex' : 'none'
    const msg = this._emptyEl.querySelector<HTMLElement>('[data-empty-message]')
    if (msg) msg.textContent = message
  }

  private _buildDrawer(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'geomap-drawer'
    el.style.cssText = `
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 320px;
      background: #091818;
      border-top: 1px solid rgba(255,255,255,0.12);
      display: none;
      flex-direction: column;
      z-index: 100;
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
    `

    // Inject shared CSS once
    if (!document.getElementById('geomap-styles')) {
      const style = document.createElement('style')
      style.id = 'geomap-styles'
      style.textContent = `
        #geomap-drawer.geomap-open { transform: translateY(0) !important; }

        .geomap-pin-wrapper { background: transparent !important; border: none !important; }

        .geomap-pin {
          width: 28px; height: 28px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          border: 2px solid #fff;
          display: flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 700; color: #fff;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
          position: relative;
        }

        .geomap-bearing-arrow {
          position: absolute;
          top: -8px;
          left: 50%;
          transform: translateX(-50%);
          width: 0; height: 0;
          border-left: 4px solid transparent;
          border-right: 4px solid transparent;
          border-bottom: 8px solid rgba(128,255,225,0.9);
        }

        .geomap-popup .leaflet-popup-content-wrapper {
          background: rgba(9,24,24,0.97);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 10px;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 12px;
          padding: 0;
          box-shadow: 0 8px 32px rgba(0,0,0,0.7);
        }
        .geomap-popup .leaflet-popup-tip { background: rgba(9,24,24,0.97); }
        .geomap-popup .leaflet-popup-content { margin: 0; }
      `
      document.head.appendChild(style)
    }

    // Header bar
    const header = document.createElement('div')
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 14px; border-bottom: 1px solid rgba(255,255,255,0.07);
      background: rgba(0,0,0,0.4); flex-shrink: 0;
    `
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:14px;">🗺</span>
        <span style="font-size:12px;font-weight:700;color:#fff;letter-spacing:0.03em;">Scan Locations</span>
        <span id="geomap-count" style="font-size:10px;color:rgba(255,255,255,0.35);"></span>
      </div>
      <button id="geomap-close" style="background:transparent;border:none;color:rgba(255,255,255,0.4);font-size:16px;cursor:pointer;padding:2px 8px;border-radius:4px;">✕</button>
    `

    // Map container
    this._mapEl = document.createElement('div')
    this._mapEl.style.cssText = 'flex:1;min-height:0;'

    this._emptyEl = document.createElement('div')
    this._emptyEl.id = 'geomap-empty'
    this._emptyEl.style.cssText = `
      position:absolute;left:0;right:0;top:41px;bottom:0;
      display:flex;align-items:center;justify-content:center;flex-direction:column;
      gap:8px;text-align:center;color:rgba(239,240,240,0.62);
      background:linear-gradient(180deg, rgba(9,24,24,0.62), rgba(1,13,14,0.72));
      pointer-events:none;z-index:401;font-size:12px;padding:18px;
    `
    this._emptyEl.innerHTML = `
      <div style="width:42px;height:42px;border-radius:50%;border:1px solid rgba(128,255,225,0.36);display:flex;align-items:center;justify-content:center;color:#80ffe1;">Map</div>
      <div data-empty-message>No geotagged scans yet</div>
      <div style="font-size:10px;color:rgba(239,240,240,0.36);max-width:240px;line-height:1.5;">Capture with location enabled or import scans with GeoPose metadata.</div>
    `

    el.appendChild(header)
    el.appendChild(this._mapEl)
    el.appendChild(this._emptyEl)

    // Wire close button after appending to DOM
    setTimeout(() => {
      document.getElementById('geomap-close')?.addEventListener('click', () => this.close())
    }, 0)

    return el
  }
}

// ── HTML builders ──────────────────────────────────────────────────────────────

const PIN_COLORS = [
  '#80ffe1', '#81c784', '#ff8a65', '#ce93d8', '#ffcc80',
  '#80deea', '#c5e1a5', '#fff176', '#ef9a9a', '#90caf9',
]

let _pinColorIdx = 0
const _filenameColorCache = new Map<string, string>()

function pinColor(filename: string): string {
  if (!_filenameColorCache.has(filename)) {
    _filenameColorCache.set(filename, PIN_COLORS[_pinColorIdx++ % PIN_COLORS.length]!)
  }
  return _filenameColorCache.get(filename)!
}

function buildPinHtml(loc: ScanLocationEntry, bearingDeg: number): string {
  const color = pinColor(loc.filename)
  const label = (loc.scanName ?? loc.filename.replace(/^\d+_/, '').replace(/\.glb$/, '')).slice(0, 2).toUpperCase()
  const rotStyle = loc.bearing !== null
    ? `transform: rotate(${bearingDeg}deg); display: block;`
    : 'display: none;'
  return `
    <div class="geomap-pin" style="background:${color};">
      <div class="geomap-bearing-arrow" style="${rotStyle}"></div>
      <span style="transform:rotate(45deg);display:block;">${label}</span>
    </div>
  `
}

function buildPopupHtml(loc: ScanLocationEntry): string {
  const color = pinColor(loc.filename)
  const name = loc.scanName ?? loc.filename.replace(/^\d+_/, '').replace(/\.glb$/, '')
  const date = loc.capturedAt ? new Date(loc.capturedAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : null

  const mapUrl = `https://maps.google.com/maps?q=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`

  return `
    <div style="padding:12px 14px;min-width:180px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0;"></div>
        <div style="font-weight:700;font-size:13px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">${escHtml(name)}</div>
      </div>
      ${loc.address ? `<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:6px;line-height:1.4;">${escHtml(loc.address)}</div>` : ''}
      <div style="font-size:10px;color:rgba(255,255,255,0.35);line-height:1.7;font-family:monospace;">
        ${loc.lat.toFixed(5)}°, ${loc.lng.toFixed(5)}°<br>
        ${loc.bearing !== null ? `↗ ${Math.round(loc.bearing)}° bearing<br>` : ''}
        ${date ? `📅 ${date}<br>` : ''}
        ${loc.pointCount   ? `☁ ${loc.pointCount.toLocaleString()} pts<br>` : ''}
        ${loc.detectionCount ? `📍 ${loc.detectionCount} objects` : ''}
      </div>
      <a href="${mapUrl}" target="_blank" rel="noopener noreferrer"
         style="display:inline-block;margin-top:8px;font-size:10px;color:rgba(128,255,225,0.8);text-decoration:none;">
        View on maps ↗
      </a>
    </div>
  `
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
