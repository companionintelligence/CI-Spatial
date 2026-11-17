/**
 * The basemap on a Leaflet map: the part of src/geo/tile-source.ts that touches the page.
 *
 * Both maps call `attachBasemap` once the map exists and is on screen: the scanner drawer in
 * src/main.ts, and the editor's GeoMap in src/viewer/geomap.ts when its drawer is first opened.
 * Until then nothing is asked of any tile host. It reads the setting from the Scan server, and
 * then either draws tiles or says why not, in one small status box on the map:
 *
 *   no setting, or one that cannot be used   pins on a blank canvas, and a line saying so
 *   a host that is not this app's own        one question per device, before any request
 *   an answer of yes                         one tile under the centre and one beside it are
 *                                            read and judged (judgeTiles); a notice is
 *                                            reported and no tile layer is made
 *   a tile that is not a known failure       the tile layer is added, with its credit as a
 *                                            link in Leaflet's attribution control
 *   tiles that stop loading afterwards       three failures in a row, with no tile loading
 *                                            between, are reported (TILE_ERROR_RUN); the next
 *                                            tile that loads clears the report
 *
 * The question is asked once for a host and kept in localStorage (BASEMAP_CONSENT_KEY), as one
 * answer for one host, so the scanner and the editor, one origin, share it. A tile host that is
 * the page's own origin or the Scan server's is this app's own, and is not asked about. "Turn
 * off" in the status box withdraws a yes, whether the tiles are drawing or the host has refused
 * or stopped answering. A server that later names another host asks again.
 *
 * Nothing here throws into the map: a failure is a status.
 */
import { apiBase, apiCredentials, apiUrl } from '../shared/api-base.ts'
import { BASEMAP_CONSENT_KEY } from '../shared/storage-keys.ts'
import {
  attributionHtml,
  basemapStatusText,
  judgeTiles,
  noBasemap,
  normalizeBasemap,
  TILE_ERROR_RUN,
  TILE_REFERRER_POLICY,
  tileHost,
  tileOrigin,
  tileSampleFromBytes,
  tileUrl,
  tileXY,
  type BasemapConfig,
  type BasemapStatus,
  type TileSample,
} from './tile-source.ts'

type LeafletModule = typeof import('leaflet')
type LeafletMap = import('leaflet').Map
type LeafletTileLayer = import('leaflet').TileLayer

/**
 * Where the Scan server's answer comes from: the capability report it already serves, which
 * carries the basemap. `versions=0` is that route's cheap mode, no subprocess.
 */
export const BASEMAP_SETTINGS_PATH = '/capabilities?versions=0'

/** How long the Scan server has to send its settings. As long as the drawer allows /scan-locations; adopted, not measured (ADR 0005 rule 5). */
const SETTINGS_TIMEOUT_MS = 5_000
/** How long a tile host has to answer the check. Adopted, not measured (ADR 0005 rule 5). */
const CHECK_TIMEOUT_MS = 8_000
/** The largest body the check reads: a tile is tens of kilobytes, so a body this big is not one. Adopted, not measured (ADR 0005 rule 5). */
const CHECK_MAX_BYTES = 1 << 20

// ── The per-device answer ─────────────────────────────────────────────────────

/** What the answer needs of localStorage. */
export interface ConsentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A device's answer to "show map tiles from this host?". */
export interface ConsentAnswer {
  host: string
  allowed: boolean
}

/** The saved answer, or null when there is none, it is unreadable, or storage is blocked. */
export function readAnswer(storage: ConsentStorage | null): ConsentAnswer | null {
  try {
    const raw = storage?.getItem(BASEMAP_CONSENT_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as { host?: unknown; allowed?: unknown } | null
    return typeof saved?.host === 'string' && typeof saved.allowed === 'boolean' ? { host: saved.host, allowed: saved.allowed } : null
  } catch {
    return null
  }
}

/** Saves the answer. Blocked storage (a private window) loses it: the page keeps it until it closes. */
export function writeAnswer(storage: ConsentStorage | null, answer: ConsentAnswer): void {
  try {
    storage?.setItem(BASEMAP_CONSENT_KEY, JSON.stringify(answer))
  } catch { /* blocked or full */ }
}

// ── What the page supplies ────────────────────────────────────────────────────

/** Everything `attachBasemap` takes from the page, so a test can supply its own. */
export interface BasemapDeps {
  /** The Scan server's capability report. Rejects when it cannot be read. */
  loadSettings: () => Promise<unknown>
  /** Reads one tile for the check. Null when the host gave no answer. */
  fetchTile: (url: string) => Promise<TileSample | null>
  storage: ConsentStorage | null
  /** The origins that are this app's own: the page, and the Scan server. Their tiles are not asked about. */
  ownOrigins: () => string[]
  retina: () => boolean
  document: Document
}

/**
 * Reads one tile for the check, close to the way the map will: the same address, in CORS mode
 * with the credentials of an `anonymous` image (cookies for the page's own origin and for no other
 * host), and the page's origin as Referer under TILE_REFERRER_POLICY. The default cache mode, so
 * the browser's HTTP cache and the provider's Cache-Control apply and the map can reuse the answer.
 * It is a `fetch`, so it does not send the image Accept list an image element does. Null when the
 * host cannot be reached in time or does not allow the page to read the answer (CORS), which the
 * page cannot tell apart.
 */
export async function fetchTileSample(url: string): Promise<TileSample | null> {
  try {
    const response = await fetch(url, {
      // What `crossOrigin: 'anonymous'` means for the layer's images: no cookie goes to a third-party
      // host. A tile route on the page's own origin gets the page's cookies, as the map's images give it.
      credentials: 'same-origin',
      referrerPolicy: TILE_REFERRER_POLICY,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    const contentType = response.headers.get('content-type')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > CHECK_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined)
      return { status: response.status, contentType, byteLength: declared, sha256: null, format: null, flat: null }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > CHECK_MAX_BYTES) {
      return { status: response.status, contentType, byteLength: bytes.byteLength, sha256: null, format: null, flat: null }
    }
    return await tileSampleFromBytes(bytes, { status: response.status, contentType })
  } catch {
    return null
  }
}

function browserStorage(): ConsentStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function defaultDeps(): BasemapDeps {
  return {
    loadSettings: async () => {
      const response = await fetch(apiUrl(BASEMAP_SETTINGS_PATH), {
        credentials: apiCredentials(),
        // The route says max-age=30. A person who pressed "Check again" after fixing the server
        // must not be told the old answer. This is the Scan server, not a tile host: its cache is ours to skip.
        cache: 'no-cache',
        signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    },
    fetchTile: fetchTileSample,
    storage: browserStorage(),
    ownOrigins: () => {
      const origins = [globalThis.location?.origin ?? '']
      try {
        const server = apiBase()
        if (server) origins.push(new URL(server).origin)
      } catch { /* an unreadable server address names no origin */ }
      return origins.filter(Boolean)
    },
    retina: () => (globalThis.devicePixelRatio ?? 1) > 1,
    document: globalThis.document,
  }
}

// ── The status box ────────────────────────────────────────────────────────────

interface Actions {
  allow(): void
  decline(): void
  retry(): void
}

// Top right: the corner both maps leave free. Leaflet's credit is bottom right, the drawer's own label is
// top left, and the editor's zoom buttons are top left. z-index 900 is above Leaflet's panes (200 to 700)
// and under its controls (1000).
const FONT = 'font:11px/1.45 -apple-system,BlinkMacSystemFont,sans-serif'
const PILL = `position:absolute;right:8px;top:8px;z-index:900;max-width:70%;box-sizing:border-box;padding:5px 9px;border-radius:6px;${FONT};color:rgba(239,240,240,0.88);background:rgba(8,28,38,0.88);border:1px solid rgba(255,255,255,0.14);`
const CARD = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:900;width:min(300px,calc(100% - 20px));box-sizing:border-box;padding:10px 12px;border-radius:10px;${FONT};color:#fff;background:rgba(8,28,38,0.96);border:1px solid rgba(114,221,212,0.4);`
const BUTTON = 'margin:6px 8px 0 0;min-height:36px;padding:0 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.08);color:#fff;font:inherit;font-weight:700;cursor:pointer;'

/**
 * The buttons a state offers. "Turn off" appears only where a yes was asked for, and then in every
 * state that follows it: the tiles drawing, or the host refusing, limiting or not answering, where
 * "Check again" alone would only send it more requests.
 */
function buttonsFor(status: BasemapStatus, actions: Actions, revocable: boolean): Array<{ label: string; run: () => void }> {
  const turnOff = revocable ? [{ label: 'Turn off', run: actions.decline }] : []
  switch (status.state) {
    case 'needs-consent': return [{ label: 'Show map', run: actions.allow }, { label: 'Keep blank', run: actions.decline }]
    case 'declined': return [{ label: 'Show map', run: actions.allow }]
    case 'unavailable': return [{ label: 'Check again', run: actions.retry }]
    case 'provider-problem': return [{ label: 'Check again', run: actions.retry }, ...turnOff]
    case 'ready': return turnOff
    default: return []
  }
}

function createStatusBox(map: LeafletMap, L: LeafletModule, doc: Document) {
  const box = doc.createElement('div')
  box.className = 'cs-basemap-status'
  box.setAttribute('role', 'status')
  box.setAttribute('aria-live', 'polite')
  box.style.cssText = 'display:none;'
  // Without this a press on the box is also a press on the map under it, and pans it.
  L.DomEvent?.disableClickPropagation(box)
  // That call stops presses, and marks the box so Leaflet skips a click on it, but Leaflet finds the mark
  // by walking up from the element clicked. A button that redraws the box has been removed by then, and
  // its click would reach the map. So the click is stopped here, on the box, which is still in place.
  box.addEventListener('click', (event) => event.stopPropagation())
  map.getContainer().appendChild(box)

  return {
    render(status: BasemapStatus, actions: Actions, revocable: boolean): void {
      const { headline, detail } = basemapStatusText(status)
      const lines: HTMLElement[] = []
      const title = doc.createElement('div')
      title.textContent = headline
      title.style.cssText = 'font-weight:700;'
      lines.push(title)
      if (detail) {
        const more = doc.createElement('div')
        more.textContent = detail
        more.style.cssText = 'opacity:0.82;'
        lines.push(more)
      }
      const buttons = buttonsFor(status, actions, revocable)
      if (buttons.length > 0) {
        const row = doc.createElement('div')
        for (const { label, run } of buttons) {
          const button = doc.createElement('button')
          button.type = 'button'
          button.textContent = label
          button.style.cssText = BUTTON
          button.addEventListener('click', run)
          row.appendChild(button)
        }
        lines.push(row)
      }
      box.style.cssText = status.state === 'needs-consent' ? CARD : PILL
      box.replaceChildren(...lines)
    },
    remove(): void {
      box.remove()
    },
  }
}

// ── The basemap ───────────────────────────────────────────────────────────────

export interface BasemapHandle {
  /** Where the basemap stands now. */
  status(): BasemapStatus
  /** Resolves with the state the latest run came to rest in: one that waits for no answer and no tile. */
  settled(): Promise<BasemapStatus>
  /** Removes the status box and the tile layer. */
  dispose(): void
}

/**
 * Puts the basemap on `map`, or says why it is not there. Call it once the map has a view and
 * is on screen. `overrides` replace what the page supplies, for tests.
 */
export function attachBasemap(host: { L: LeafletModule; map: LeafletMap }, overrides: Partial<BasemapDeps> = {}): BasemapHandle {
  const { L, map } = host
  const deps: BasemapDeps = { ...defaultDeps(), ...overrides }
  const box = createStatusBox(map, L, deps.document)

  let config: BasemapConfig = noBasemap()
  let layer: LeafletTileLayer | null = null
  let status: BasemapStatus = { state: 'checking' }
  let remembered: ConsentAnswer | null = null
  let revocable = false
  let generation = 0
  let disposed = false

  const show = (next: BasemapStatus): BasemapStatus => {
    if (!disposed) {
      status = next
      box.render(next, actions, revocable)
    }
    return status
  }
  const hostOf = (): string => ('host' in status && status.host ? status.host : '')
  const removeLayer = (): void => {
    layer?.remove()
    layer = null
  }
  const answerFor = (tileHostName: string): ConsentAnswer | null =>
    [remembered, readAnswer(deps.storage)].find((answer) => answer?.host === tileHostName) ?? null
  const remember = (tileHostName: string, allowed: boolean): void => {
    remembered = { host: tileHostName, allowed }
    writeAnswer(deps.storage, remembered)
  }

  const addLayer = (tileHostName: string, checked: boolean): void => {
    // The credit is shown in Leaflet's attribution control. A map made without one gets one,
    // so no tile is ever drawn without its credit link on screen.
    if (!map.attributionControl) L.control.attribution({ prefix: false }).addTo(map)
    const added = L.tileLayer(config.urlTemplate, {
      attribution: attributionHtml(config.attribution),
      // The map may zoom deeper than the provider serves; the layer then enlarges its deepest tiles.
      maxZoom: Math.max(config.maxZoom, map.options.maxZoom ?? 0),
      maxNativeZoom: config.maxZoom,
      referrerPolicy: TILE_REFERRER_POLICY,
      // Tile images are asked for in CORS mode with same-origin credentials, as the check is. Left
      // unset, the browser sends a third-party tile host its cookies with every tile; a host that
      // passed the check allows CORS reads.
      crossOrigin: 'anonymous',
    }).addTo(map)
    layer = added

    // The check looked at two tiles once. This looks at every tile the map asks for afterwards, so a
    // provider that starts refusing, or a network that drops, is reported and not left as gaps.
    let failedInARow = 0
    added.on('tileload', () => {
      failedInARow = 0
      if (layer === added && status.state === 'provider-problem' && status.problem === 'stalled') {
        show({ state: 'ready', host: tileHostName, checked })
      }
    })
    added.on('tileerror', () => {
      if (layer !== added || status.state !== 'ready') return
      failedInARow += 1
      if (failedInARow >= TILE_ERROR_RUN) {
        show({ state: 'provider-problem', host: tileHostName, problem: 'stalled', requiresKey: config.requiresKey })
      }
    })
  }

  const actions: Actions = {
    allow: () => {
      remember(hostOf(), true)
      run = guarded()
    },
    decline: () => {
      const declined = hostOf()
      remember(declined, false)
      removeLayer()
      show({ state: 'declined', host: declined })
    },
    retry: () => {
      show({ state: 'checking' })
      run = guarded()
    },
  }

  /** Reads the tile under the centre and the one to its right, and judges them. */
  async function check(tileHostName: string, mine: number): Promise<BasemapStatus> {
    show({ state: 'checking', host: tileHostName })
    await new Promise<void>((resolve) => map.whenReady(() => resolve()))
    if (mine !== generation || disposed) return status
    const zoom = Math.max(1, Math.min(Math.round(map.getZoom()), config.maxZoom))
    const centre = map.getCenter()
    const { x, y } = tileXY(centre.lat, centre.lng, zoom)
    const beside = (x + 1) % 2 ** zoom
    const retina = deps.retina()
    const [first, second] = await Promise.all([
      deps.fetchTile(tileUrl(config.urlTemplate, { z: zoom, x, y }, retina)),
      beside === x ? Promise.resolve(null) : deps.fetchTile(tileUrl(config.urlTemplate, { z: zoom, x: beside, y }, retina)),
    ])
    if (mine !== generation || disposed) return status
    const verdict = judgeTiles(first, second)
    if (!verdict.ok) {
      return show({ state: 'provider-problem', host: tileHostName, problem: verdict.problem, httpStatus: verdict.httpStatus, requiresKey: config.requiresKey })
    }
    addLayer(tileHostName, verdict.checked)
    return show({ state: 'ready', host: tileHostName, checked: verdict.checked })
  }

  async function start(): Promise<BasemapStatus> {
    const mine = ++generation
    removeLayer()
    revocable = false
    let settings: unknown
    try {
      settings = await deps.loadSettings()
    } catch {
      return mine === generation ? show({ state: 'unavailable' }) : status
    }
    if (mine !== generation || disposed) return status
    if (typeof settings !== 'object' || settings === null) return show({ state: 'unavailable' })

    config = normalizeBasemap((settings as { basemap?: unknown }).basemap)
    if (config.problem) return show({ state: 'misconfigured', problem: config.problem })
    if (config.kind === 'none') return show({ state: 'none' })
    if (config.kind === 'vector') return show({ state: 'unsupported' })

    const tileHostName = tileHost(config.urlTemplate) ?? ''
    const origin = tileOrigin(config.urlTemplate)
    if (origin === null || !deps.ownOrigins().includes(origin)) {
      revocable = true
      const answer = answerFor(tileHostName)
      if (answer === null) return show({ state: 'needs-consent', host: tileHostName })
      if (!answer.allowed) return show({ state: 'declined', host: tileHostName })
    }
    return await check(tileHostName, mine)
  }

  /** `start`, with an unexpected failure shown as a status and not thrown into the map. */
  function guarded(): Promise<BasemapStatus> {
    return start().catch(() => show({ state: 'unavailable' }))
  }

  let run: Promise<BasemapStatus> = guarded()
  return {
    status: () => status,
    settled: () => run,
    dispose: () => {
      disposed = true
      generation++
      removeLayer()
      box.remove()
    },
  }
}
