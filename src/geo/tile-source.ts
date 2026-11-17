/**
 * Where the map tiles come from, and whether what came back is a map.
 *
 * One module for both maps (the scanner drawer in src/main.ts and the editor's GeoMap in
 * src/viewer/geomap.ts), and for the server, which reads the setting from its environment.
 * It holds the pure part: the setting and its checks, tile addresses, the classifier that tells
 * a provider's notice from a map, and the words the maps show. The DOM and Leaflet part is
 * src/geo/basemap-layer.ts. ADR 0002: the server imports this file, and so does the browser,
 * so it holds no server-runtime reference and no DOM reference.
 *
 * ## Why this exists
 *
 * The maps used to name one provider in code. That provider no longer serves keyless raster
 * tiles: its own FAQ says a request without a key gets a tile that reads "API KEY REQUIRED" in
 * place of a map. An <img> draws that tile as it draws any other, so the map looked fine to the
 * code and was useless to the person. OpenStreetMap's servers answer a client they block with a
 * tile image that reads "Access blocked" (the OSM wiki's "Blocked tiles" page). A dead basemap
 * fails silently, so the source is now a setting, the default is no source at all, and a tile
 * is looked at before a map is drawn from it.
 *
 * ## The setting (ADR 0001: one existing route, one new variable)
 *
 * `GET /capabilities` carries it, as `basemap`, next to the machine report it already serves.
 * The server reads one optional variable, MAP_TILE_SOURCE: a JSON object, on one line,
 * `{ "urlTemplate": "https://host/{z}/{x}/{y}.png", "attribution": [{ "text", "href" }],
 * "maxZoom": 19 }`. Unset, which is the default, means no basemap: the maps draw their pins on
 * a blank canvas and make no request to any tile host. No provider is named in this repo, as a
 * default or otherwise; the owner picks one (an open decision: provider, licence and privacy).
 * `kind` may be `raster` (the default) or `vector`; a vector source is reported as not
 * supported in this build, because drawing one needs a vector renderer this app does not carry.
 *
 * Attribution is required, not defaulted: a credit the code invented could be wrong, and a
 * missing one breaks every provider's terms. A setting without a credit link is refused, so no
 * tile is shown without one.
 *
 * ## What a tile request sends, and to whom
 *
 * The check and then each tile the map draws go to the tile host as a plain GET: the tile's
 * address (its zoom, column and row, which say roughly where the map is looking), the
 * visitor's IP address, the browser's User-Agent and, per TILE_REFERRER_POLICY, the page's
 * origin as Referer. No cookie and no Scan token goes to a third-party host with either. The
 * check is a `fetch` with `credentials: 'same-origin'`, and the layer asks for its tile images
 * in CORS mode with the same credentials (`crossOrigin: 'anonymous'`): an image the browser
 * fetches without that carries the host's cookies, which is how a tile host could follow a
 * visitor from tile to tile. Both send the page's cookies to the page's own origin and to no
 * other host, and the shell's token wrapper adds a token only to requests for the Scan server.
 * The two are not quite the same request: a `fetch` accepts any content type where an image asks
 * for a list of image types, so a host that answers by content type could answer them
 * differently, which the check cannot see. A key in the address is visible to every browser that
 * loads the page, as it is with any browser map. Because the host learns all this, a host that
 * is not this app's own origin is asked about once per device (src/geo/basemap-layer.ts) before
 * the first request.
 *
 * ## Referrer-Policy
 *
 * Nothing in this app sets one today: no header from server/main.ts or vite.config.ts and no
 * `<meta name="referrer">` in index.html or viewer.html, so the browser's default applies and
 * the page's origin reaches the tile host. OpenStreetMap's tile policy requires the Referer
 * and lists `no-referrer` and `same-origin` as policies that break it; CARTO's key
 * restriction by site needs it too. Audit finding F87 asks for a restrictive policy on every
 * page. So the tile requests carry their own policy, TILE_REFERRER_POLICY, as the layer's
 * `referrerPolicy` option and on the check's fetch: whatever the page sets, the Referer
 * reaches the configured tile host and no other host gets it from this code. A page policy is
 * never loosened to do it. A future Content-Security-Policy must name the tile host in both
 * `img-src` and `connect-src`: the layer loads tiles as images, and the check reads one.
 *
 * ## Caching and prefetching
 *
 * The app stores no tile of a third-party host and asks for none ahead of the view: the check
 * reads the tile under the map's centre and its right-hand neighbour, which at the size of
 * these maps the first view usually draws anyway. The browser's HTTP cache honours the
 * provider's Cache-Control, and the check uses the default cache mode, so it never bypasses it
 * (OpenStreetMap asks that caches be honoured and forbids offline and prefetch use of its
 * standard tiles). A third-party host's requests never reach the service worker's cache, which
 * ignores every cross-origin request. A tile host that is the page's own origin is another
 * case: its tiles are ordinary same-origin GETs, and public/sw.js keeps every 2xx answer to one
 * in its cache, as it does for any same-origin file, with no limit on how many until the
 * cache version changes. Nothing here changes that.
 *
 * ## What the classifier knows (ADR 0005 rules 3 and 5)
 *
 * It reports a provider problem for four kinds of evidence, and `ok: true` only means that
 * none of them was found, which is not a claim that the picture is a map. The check reads two
 * tiles, and each one is judged on its own for 1 to 3.
 *  1. A tile whose SHA-256 and size are on KNOWN_FAILURE_TILES. That list holds one entry, the
 *     key-required tile from CARTO, taken from a real file: the one the WP-12 brief ships
 *     (carto_tile_test.png), which the alignment investigation's critic reported receiving
 *     from a keyless request. Its size (2,513 bytes), its dimensions (256 by 256) and its
 *     SHA-256 were measured from that file, and its picture was read: "API KEY REQUIRED" over
 *     carto.com/basemaps/apikey. Only that one variant is known. A light style, a retina tile
 *     or a later redraw is not on the list.
 *  2. An HTTP status that is a refusal: 401, 403 and 451 (refused), 429 (rate limited), or any
 *     other non-2xx status (unavailable). CARTO documents a 403 for a key used from a site it
 *     is not restricted to. OpenStreetMap's wiki describes its blocks as images and does not
 *     give their status, so for them this is the less certain evidence. A neighbour that is
 *     merely missing (404, a server error, no answer) is not held against the map: a tile at
 *     the edge of a provider's coverage can be absent, and the tile under the centre is the
 *     one that decides.
 *  3. A 2xx answer that is not an image: a captive portal or a proxy's error page.
 *  4. The same picture for two different tiles (`notice`), unless that picture is one flat
 *     colour. A notice tile is one image served for every address, and a real map is not. This
 *     is the evidence that does not need to know the notice: it is what can catch
 *     OpenStreetMap's "Access blocked" tiles, which this file has no bytes for (the build
 *     sandbox had no network, and requesting one would itself be a tile request). It is also
 *     what covers the CARTO variants above. When a real OpenStreetMap tile is captured, its
 *     hash goes on KNOWN_FAILURE_TILES. The OSM wiki's "Blocked tiles" page shows three, as
 *     files named 403_tile.png, 403r_tile.png and 451_Attribution_Tile.png: hash those.
 *     The one picture a map really does repeat is a flat fill (open sea, a forest, an empty
 *     part of an extract), and it cannot carry words, so a PNG is read for that (isFlatPng).
 *     A tile that is not a PNG, or one this file cannot read, falls back to a size floor
 *     (NOTICE_MIN_BYTES), which tells a flat WebP from a notice but not a flat JPEG.
 *
 * The limits of 4 are named where they are set. A single unknown notice tile, with nothing to
 * compare it with, passes.
 */

// ── The setting ───────────────────────────────────────────────────────────────

/** The one environment variable the server reads for the basemap. Documented in .env.example. */
export const BASEMAP_ENV_VAR = 'MAP_TILE_SOURCE'

/** `none` is the default: no tiles and no request. `vector` is reported, not drawn. */
export type BasemapKind = 'none' | 'raster' | 'vector'

/** One credit, shown as a link. Both fields are required, and the link must be https. */
export interface AttributionLink {
  text: string
  href: string
}

/**
 * Why a value that was set could not be used. Short codes: they travel to the page, and no value
 * does. The page checks a code it receives against this list, so a server cannot make it show
 * anything else.
 */
export const BASEMAP_CONFIG_PROBLEMS = [
  'invalid',
  'not-json',
  'unknown-kind',
  'no-url',
  'bad-url',
  'bad-template',
  'no-attribution',
  'bad-attribution',
  'bad-zoom',
] as const

export type BasemapConfigProblem = (typeof BASEMAP_CONFIG_PROBLEMS)[number]

/**
 * The basemap as `GET /capabilities` reports it. `kind` is `none` whenever there is nothing
 * usable to draw, and `problem` then says why when something was set but could not be used.
 */
export interface BasemapConfig {
  kind: BasemapKind
  /** An https address with {z}, {x} and {y}, and {r} for a retina suffix. Empty unless `kind` is `raster`. */
  urlTemplate: string
  /** At least one link when `kind` is `raster`. */
  attribution: AttributionLink[]
  /** The deepest zoom the provider serves; the map draws deeper zooms from it, enlarged. */
  maxZoom: number
  /** True when the address carries an access key, or the setting says so. Used for the words only. */
  requiresKey: boolean
  problem?: BasemapConfigProblem
}

/**
 * The deepest zoom assumed when a setting names none. Leaflet's own default, and the deepest
 * zoom the maps fit pins to. Adopted, not measured (ADR 0005 rule 5).
 */
export const DEFAULT_MAX_ZOOM = 18

/** The deepest zoom a setting may name: web-mercator providers stop here. Adopted, not measured (ADR 0005 rule 5). */
const ZOOM_LIMIT = 22

/** Longest tile address and credit link accepted. Adopted, not measured (ADR 0005 rule 5). */
const MAX_URL_LENGTH = 2048
/** Most credit links, and the longest credit text. Adopted, not measured (ADR 0005 rule 5). */
const MAX_CREDITS = 4
const MAX_CREDIT_TEXT = 80

/**
 * Query parameter names that carry an access key in the addresses providers document, such as
 * `?key=`, `?api_key=` and `?access_token=`. A hit sets `requiresKey` when the setting does not.
 * Adopted, not measured (ADR 0005 rule 5): a key in the path is not seen, and the setting can say so.
 */
const KEY_PARAMETER = /[?&](?:key|api[_-]?key|apikey|access[_-]?token|token)=/i

const PLACEHOLDERS = /\{(z|x|y|r)\}/g

/** No basemap: the default, and what every refused setting becomes. */
export function noBasemap(problem?: BasemapConfigProblem): BasemapConfig {
  const config: BasemapConfig = { kind: 'none', urlTemplate: '', attribution: [], maxZoom: DEFAULT_MAX_ZOOM, requiresKey: false }
  if (problem) config.problem = problem
  return config
}

/** The tile address with its placeholders filled in, for reading its host. Null when it is not an address. */
function probeUrl(template: string): URL | null {
  try {
    return new URL(template.replace(PLACEHOLDERS, '0'))
  } catch {
    return null
  }
}

/**
 * The part of an address between its scheme and its path: user name, host and port, as the URL
 * parser reads it. For a web address it ends at the first `/`, `\`, `?` or `#`, and it ignores
 * any number of slashes after `https:`.
 */
function authorityOf(template: string): string {
  const afterScheme = template.replace(/^[a-z][a-z0-9+.-]*:[/\\]*/i, '')
  return afterScheme.split(/[/\\?#]/, 1)[0] ?? ''
}

function templateProblem(template: string): BasemapConfigProblem | null {
  if (template === '') return 'no-url'
  if (template.length > MAX_URL_LENGTH) return 'bad-url'
  // Any brace left after the four known placeholders is one this app cannot fill, such as {s}.
  if (/[{}]/.test(template.replace(PLACEHOLDERS, '0'))) return 'bad-template'
  // A placeholder in the host or the port would send the requests to a host other than the one that
  // is read from the filled-in address below, which is the host the person is asked about.
  if (/[{}]/.test(authorityOf(template))) return 'bad-template'
  const url = probeUrl(template)
  if (!url || url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return 'bad-url'
  return ['{z}', '{x}', '{y}'].every((placeholder) => template.includes(placeholder)) ? null : 'bad-template'
}

function creditsOrProblem(raw: unknown): AttributionLink[] | BasemapConfigProblem {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  if (list.length === 0) return 'no-attribution'
  if (list.length > MAX_CREDITS) return 'bad-attribution'
  const credits: AttributionLink[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return 'bad-attribution'
    const { text, href } = entry as { text?: unknown; href?: unknown }
    if (typeof text !== 'string' || typeof href !== 'string') return 'bad-attribution'
    const shown = text.trim()
    let url: URL
    try {
      url = new URL(href.trim())
    } catch {
      return 'bad-attribution'
    }
    if (shown === '' || shown.length > MAX_CREDIT_TEXT || href.length > MAX_URL_LENGTH) return 'bad-attribution'
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return 'bad-attribution'
    credits.push({ text: shown, href: url.href })
  }
  return credits
}

/**
 * Validates a basemap setting, whether it came from the environment or from the server's
 * answer, so both ends hold one set of rules. Nothing set, or `null`, is no basemap without a
 * problem: an older server has no such block. Anything set that cannot be used is no basemap
 * with a problem code. The result is the same shape whatever came in, and validating it again
 * gives it back: that includes the problem code, which a server's answer carries when it could
 * not use its setting, so the map can say why it has no basemap.
 */
export function normalizeBasemap(raw: unknown): BasemapConfig {
  if (raw === undefined || raw === null) return noBasemap()
  if (typeof raw !== 'object' || Array.isArray(raw)) return noBasemap('invalid')
  const source = raw as Record<string, unknown>
  const kind = source.kind === undefined ? 'raster' : source.kind
  if (kind === 'none') return noBasemap(BASEMAP_CONFIG_PROBLEMS.find((code) => code === source.problem))
  if (kind === 'vector') return { ...noBasemap(), kind: 'vector' }
  if (kind !== 'raster') return noBasemap('unknown-kind')

  const template = typeof source.urlTemplate === 'string' ? source.urlTemplate.trim() : ''
  const urlProblem = templateProblem(template)
  if (urlProblem) return noBasemap(urlProblem)
  const credits = creditsOrProblem(source.attribution)
  if (!Array.isArray(credits)) return noBasemap(credits)

  const zoom = source.maxZoom === undefined ? DEFAULT_MAX_ZOOM : source.maxZoom
  if (typeof zoom !== 'number' || !Number.isInteger(zoom) || zoom < 0 || zoom > ZOOM_LIMIT) return noBasemap('bad-zoom')
  if (source.requiresKey !== undefined && typeof source.requiresKey !== 'boolean') return noBasemap('invalid')

  return {
    kind: 'raster',
    urlTemplate: template,
    attribution: credits,
    maxZoom: zoom,
    requiresKey: typeof source.requiresKey === 'boolean' ? source.requiresKey : KEY_PARAMETER.test(template),
  }
}

/** A value wrapped in one pair of quotes loses them: Docker's --env-file keeps the quotes a shell would strip. */
function unwrapQuotes(value: string): string {
  const first = value[0]
  return value.length >= 2 && (first === "'" || first === '"') && value.endsWith(first) ? value.slice(1, -1) : value
}

/**
 * The basemap the environment asks for, as the server reports it. `env` is a getter over the
 * server's environment, the shape memory_push.ts's `configFromEnv` already takes, so this file
 * stays free of the server runtime. Unset or blank is no basemap.
 */
export function basemapFromEnv(env: (name: string) => string | undefined): BasemapConfig {
  const raw = (env(BASEMAP_ENV_VAR) ?? '').trim()
  if (raw === '') return noBasemap()
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrapQuotes(raw))
  } catch {
    return noBasemap('not-json')
  }
  // A set value that is not an object (`null`, a number) is a mistake, not an absent setting.
  if (typeof parsed !== 'object' || parsed === null) return noBasemap('invalid')
  return normalizeBasemap(parsed)
}

/** One sentence per problem code, for the boot log and the map. Plain words, no value from the setting. */
export function basemapProblemText(problem: BasemapConfigProblem): string {
  switch (problem) {
    case 'not-json': return 'The setting is not valid JSON.'
    case 'unknown-kind': return 'The kind must be raster or vector.'
    case 'no-url': return 'The setting has no tile address.'
    case 'bad-url': return 'The tile address must be https, with no user name or password.'
    case 'bad-template': return 'The tile address needs {z}, {x} and {y} after the host, and no other placeholder but {r}.'
    case 'no-attribution': return 'The setting has no credit link.'
    case 'bad-attribution': return 'A credit needs text and an https link, and there can be four at most.'
    case 'bad-zoom': return 'The deepest zoom must be a whole number from 0 to 22.'
    case 'invalid': return 'The setting is not in the expected form.'
  }
}

// ── Addresses ─────────────────────────────────────────────────────────────────

/** The highest latitude web-mercator tiles cover. */
const MAX_MERCATOR_LATITUDE = 85.0511287798

/** The tile that holds a point at `zoom`, in the standard web-mercator scheme. Longitude wraps; latitude is clamped. */
export function tileXY(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const tiles = 2 ** zoom
  const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, lat))
  const column = Math.floor(((lng + 180) / 360) * tiles)
  const row = Math.floor(((1 - Math.asinh(Math.tan((clamped * Math.PI) / 180)) / Math.PI) / 2) * tiles)
  return { x: ((column % tiles) + tiles) % tiles, y: Math.max(0, Math.min(tiles - 1, row)) }
}

/** The tile address for `tile`. `{r}` is `@2x` on a retina display, as Leaflet fills it, so a check reads what the map will. */
export function tileUrl(template: string, tile: { z: number; x: number; y: number }, retina: boolean): string {
  return template.replace(PLACEHOLDERS, (_match, key: 'z' | 'x' | 'y' | 'r') => (key === 'r' ? (retina ? '@2x' : '') : String(tile[key])))
}

/** `host` or `host:port` of the tile address, or null when it is not an address. */
export function tileHost(template: string): string | null {
  return probeUrl(template)?.host ?? null
}

/** The tile host's origin, for telling this app's own tiles from a third party's. */
export function tileOrigin(template: string): string | null {
  return probeUrl(template)?.origin ?? null
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * The credits as markup for Leaflet's attribution control, which takes HTML: each one a real
 * link that opens outside the app. Text and address are escaped, and the address was checked
 * to be https, so a setting cannot put markup in the page.
 */
export function attributionHtml(credits: readonly AttributionLink[]): string {
  return credits
    .map((credit) => `<a href="${escapeHtml(credit.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(credit.text)}</a>`)
    .join(' · ')
}

/**
 * The Referer policy the tile requests carry: the browser's own default, written down on the
 * requests so a stricter page policy cannot reach them. It sends the page's origin, and
 * nothing at all on a downgrade to http. OpenStreetMap's Referer page lists it, with
 * `no-referrer-when-downgrade`, `origin`, `origin-when-cross-origin` and `strict-origin`, as
 * policies that keep the required Referer; `no-referrer` and `same-origin` break it. Adopted
 * from that documentation, not measured (ADR 0005 rule 5): no tile server was asked.
 */
export const TILE_REFERRER_POLICY = 'strict-origin-when-cross-origin'

// ── Telling a notice from a map ───────────────────────────────────────────────

/** What a failed or refused tile request means, as far as the evidence says. */
export type ProviderProblem =
  | 'key-required'
  | 'refused'
  | 'rate-limited'
  | 'notice'
  | 'not-an-image'
  | 'unavailable'
  | 'stalled'

/**
 * How many tile images in a row may fail to load, with none loading in between, before the map
 * says its tiles stopped loading. One or two are ordinary (a tile a provider does not have, at
 * the edge of its coverage); three in a row are not. Adopted, not measured (ADR 0005 rule 5).
 */
export const TILE_ERROR_RUN = 3

/** What the check learned from one tile request. `null` stands in for a request that got no answer. */
export interface TileSample {
  status: number
  contentType: string | null
  byteLength: number
  /** Lower-case hex SHA-256 of the body, or null when it could not be computed or the body was too large. */
  sha256: string | null
  format: 'png' | 'jpeg' | 'webp' | null
  /**
   * Whether every pixel is the same colour: true for one flat fill, false when anything differs,
   * null when the picture could not be read (not a PNG, or one `isFlatPng` cannot read).
   */
  flat: boolean | null
}

export type TileVerdict =
  | { ok: true; checked: boolean }
  | { ok: false; problem: ProviderProblem; httpStatus?: number }

/** A tile a provider sends in place of a map, identified by its bytes. */
export interface KnownFailureTile {
  problem: ProviderProblem
  /** Where the bytes came from, for whoever reads the list. */
  source: string
  byteLength: number
  sha256: string
}

/**
 * The failure tiles this build can name from their bytes. One entry: the CARTO key-required
 * tile, the file `carto_tile_test.png` of the WP-12 brief (a 256 by 256, 4-bit palette PNG
 * showing "API KEY REQUIRED" over carto.com/basemaps/apikey), which
 * tests/fixtures/basemap/carto-key-required.png keeps. OpenStreetMap's "Access blocked" tiles
 * are not here: no real one was available. Add the SHA-256 of one when it has been captured.
 */
export const KNOWN_FAILURE_TILES: readonly KnownFailureTile[] = [
  {
    problem: 'key-required',
    source: 'CARTO key-required raster tile, 256 px, from carto_tile_test.png in the WP-12 brief',
    byteLength: 2513,
    sha256: 'cc3f31364a735d9a8179af36b3db7617cdff8bdb0248654ebcc3df91607abedc',
  },
]

/**
 * The smallest size at which the same bytes for two different tiles are called a notice when
 * the tile's pixels could not be read (`TileSample.flat` is null): a JPEG, a WebP, or a PNG that
 * `isFlatPng` cannot read. A size is only a stand-in for what the picture holds, and a poor one:
 * a flat 512 by 512 RGBA PNG is more than this, and a notice drawn as two-colour lettering on a
 * flat colour is less. So a PNG that was read is never judged by its size.
 * Adopted, not measured (ADR 0005 rule 5): no provider's blank tile was sampled. What was
 * measured is Pillow 12.1.1's output with its default settings, on the build machine, and it says
 * the floor works for WebP and not for JPEG. A flat 256 by 256 WebP is 44 bytes lossless and 192
 * lossy (54 and 542 at 512 by 512), and the CARTO notice as a WebP is 1,384 to 1,830 bytes. A flat
 * 256 by 256 JPEG is 1,652 bytes, header tables included (4,724 at 512 by 512), and the notice as
 * a JPEG is 2,829 to 4,352. So for a JPEG the floor means that the same picture in two places is a
 * notice, and a map whose flat JPEG tiles repeat would be called one, which `Check again` would
 * not help. The same goes for an interlaced PNG over this size.
 */
export const NOTICE_MIN_BYTES = 1024

/** What kind of image the bytes are, from their first bytes. Null for anything else. */
export function imageFormat(bytes: Uint8Array): TileSample['format'] {
  const startsWith = (...magic: number[]) => magic.every((byte, index) => bytes[index] === byte)
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'jpeg'
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  return null
}

/** Lower-case hex SHA-256, or null where Web Crypto is not there (a page that is not a secure context). */
export async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// ── Whether a tile is one flat colour ─────────────────────────────────────────

/** The longest side whose pixels are read: a map tile is 256 or 512 pixels, so a bigger picture is not one. Adopted, not measured (ADR 0005 rule 5). */
const FLAT_MAX_SIDE = 1024
/** The most inflated pixel data read for one tile, in bytes: 1024 by 1024 at four 8-bit channels is 4 MiB. Adopted, not measured (ADR 0005 rule 5). */
const FLAT_MAX_RAW_BYTES = 8 * 1024 * 1024

/** Channels per pixel for each PNG colour type, and the bit depths each one allows (PNG specification, section 11.2.2). */
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
/** A byte of packed pixels that holds one value in every slot: 0xff at 1 bit a pixel, 0x55 at 2, 0x11 at 4. */
const PACKED_REPEAT: Readonly<Record<number, number>> = { 1: 0xff, 2: 0x55, 4: 0x11 }

interface PngPicture {
  width: number
  height: number
  depth: number
  colourType: number
  /** The zlib stream the picture's IDAT chunks hold, joined. */
  compressed: Uint8Array
}

/** The header and pixel data of a PNG, or null for one that is cut short, interlaced, or not the plain deflate kind. */
function readPng(bytes: Uint8Array): PngPicture | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let header: Omit<PngPicture, 'compressed'> | null = null
  const parts: Uint8Array[] = []
  let at = 8
  while (at + 12 <= bytes.byteLength) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const start = at + 8
    if (start + length + 4 > bytes.byteLength) return null
    if (at === 8 && type !== 'IHDR') return null
    if (type === 'IHDR') {
      // The last three bytes are the compression, filter and interlace methods: only 0, 0 and 0 are read.
      if (header !== null || length !== 13 || bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] !== 0) return null
      header = { width: view.getUint32(start), height: view.getUint32(start + 4), depth: bytes[start + 8]!, colourType: bytes[start + 9]! }
    } else if (type === 'IDAT') {
      parts.push(bytes.subarray(start, start + length))
    } else if (type === 'IEND') {
      break
    }
    at = start + length + 4
  }
  if (header === null || parts.length === 0) return null
  const compressed = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let filled = 0
  for (const part of parts) {
    compressed.set(part, filled)
    filled += part.byteLength
  }
  return { ...header, compressed }
}

/** The first `size` bytes of a zlib stream, inflated, or null when it holds fewer, is corrupt, or this runtime cannot inflate. */
async function inflateExactly(compressed: Uint8Array, size: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined') return null
  try {
    const reader = new Blob([new Uint8Array(compressed)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
    const raw = new Uint8Array(size)
    let filled = 0
    while (filled < size) {
      const { done, value } = await reader.read()
      if (done) break
      const taken = Math.min(value.byteLength, size - filled)
      raw.set(value.subarray(0, taken), filled)
      filled += taken
    }
    // A stream that holds more than the picture does is not read any further.
    void reader.cancel().catch(() => undefined)
    return filled === size ? raw : null
  } catch {
    return null
  }
}

/** Undoes the PNG row filters of `raw` (each row a filter byte, then `rowBytes`): `height` rows of `rowBytes`, one after the other. Null for a filter that does not exist. */
function unfilter(raw: Uint8Array, height: number, rowBytes: number, bitsPerPixel: number): Uint8Array | null {
  // The filters work on the byte `step` back, which is the previous pixel when a pixel is a whole number of bytes.
  const step = Math.max(1, bitsPerPixel >> 3)
  const pixels = new Uint8Array(height * rowBytes)
  for (let y = 0; y < height; y++) {
    const from = y * (rowBytes + 1)
    const at = y * rowBytes
    const filter = raw[from]!
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= step ? pixels[at + i - step]! : 0
      const up = y > 0 ? pixels[at - rowBytes + i]! : 0
      const upLeft = y > 0 && i >= step ? pixels[at - rowBytes + i - step]! : 0
      let predicted: number
      switch (filter) {
        case 0: predicted = 0; break
        case 1: predicted = left; break
        case 2: predicted = up; break
        case 3: predicted = (left + up) >> 1; break
        case 4: {
          const estimate = left + up - upLeft
          const toLeft = Math.abs(estimate - left)
          const toUp = Math.abs(estimate - up)
          const toUpLeft = Math.abs(estimate - upLeft)
          predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
          break
        }
        default: return null
      }
      pixels[at + i] = (raw[from + 1 + i]! + predicted) & 0xff
    }
  }
  return pixels
}

/** A PNG's pixels as stored, with every row filter undone. A pixel of 8 bits or more is its channels in order, 16-bit ones high byte first; 1, 2 and 4 bit pixels are packed, the first in the high bits. */
export interface PngPixels {
  width: number
  height: number
  depth: number
  colourType: number
  /** Bytes in a row of `pixels`. */
  rowBytes: number
  /** `height` rows of `rowBytes`, one after the other. */
  pixels: Uint8Array
}

/**
 * The pixels of a PNG, or null when it cannot be read here: anything that is not a PNG, one that is
 * interlaced, cut short, larger than a map tile, laid out in a way the specification does not allow, or
 * a runtime without `DecompressionStream`. Nothing is drawn, and nothing is read past what the header
 * says the picture holds, so a PNG that inflates to more than that cannot use more memory than that.
 * Exported so a test can hold it to every colour type, bit depth and row filter it claims to read.
 */
export async function readPngPixels(bytes: Uint8Array): Promise<PngPixels | null> {
  if (imageFormat(bytes) !== 'png') return null
  const picture = readPng(bytes)
  if (picture === null) return null
  const { width, height, depth, colourType } = picture
  const channels = PNG_CHANNELS[colourType]
  if (channels === undefined || !PNG_DEPTHS[colourType]!.includes(depth)) return null
  if (width < 1 || height < 1 || width > FLAT_MAX_SIDE || height > FLAT_MAX_SIDE) return null
  const bitsPerPixel = channels * depth
  // A packed row that does not end on a byte ends in padding bits, and those are not pixels.
  if (depth < 8 && (width * bitsPerPixel) % 8 !== 0) return null
  const rowBytes = (width * bitsPerPixel) / 8
  const size = height * (rowBytes + 1)
  if (size > FLAT_MAX_RAW_BYTES) return null
  const raw = await inflateExactly(picture.compressed, size)
  if (raw === null) return null
  const pixels = unfilter(raw, height, rowBytes, bitsPerPixel)
  return pixels === null ? null : { width, height, depth, colourType, rowBytes, pixels }
}

/**
 * Whether every pixel of a PNG is the same colour: true for one flat fill, which is the one
 * picture a map repeats from place to place (open sea, a forest, an empty part of an extract)
 * and cannot carry words; false when any pixel differs, so a notice with lettering is not
 * flat however few colours it has; null when the picture could not be read (`readPngPixels`).
 */
export async function isFlatPng(bytes: Uint8Array): Promise<boolean | null> {
  const picture = await readPngPixels(bytes)
  if (picture === null) return null
  const { pixels, depth, colourType } = picture
  const pixelBytes = depth >= 8 ? (PNG_CHANNELS[colourType]! * depth) >> 3 : 1
  const first = pixels.subarray(0, pixelBytes)
  // Packed pixels: a byte whose slots differ already holds more than one colour.
  if (depth < 8 && first[0] !== (first[0]! >> (8 - depth)) * PACKED_REPEAT[depth]!) return false
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== first[i % pixelBytes]) return false
  return true
}

/**
 * What the check needs to know about a tile whose bytes are in hand: its size, its kind, its
 * SHA-256 and whether it is one flat colour, with the status and content type it arrived with.
 * `classifyTile` takes the result.
 */
export async function tileSampleFromBytes(bytes: Uint8Array, response: { status: number; contentType: string | null }): Promise<TileSample> {
  const format = imageFormat(bytes)
  return {
    status: response.status,
    contentType: response.contentType,
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    format,
    flat: format === 'png' ? await isFlatPng(bytes) : null,
  }
}

function isImage(sample: TileSample): boolean {
  return sample.format !== null || (sample.contentType?.toLowerCase().startsWith('image/') ?? false)
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

/**
 * Judges one tile. Its bytes are compared with KNOWN_FAILURE_TILES first, whatever the status,
 * because a named failure says more than the status that carried it. `ok: true` means no known
 * failure was found; `checked: false` means the body could not be compared at all.
 */
export function classifyTile(sample: TileSample | null): TileVerdict {
  if (sample === null) return { ok: false, problem: 'unavailable' }
  const known = sample.sha256 === null
    ? undefined
    : KNOWN_FAILURE_TILES.find((tile) => tile.sha256 === sample.sha256 && tile.byteLength === sample.byteLength)
  if (known) return { ok: false, problem: known.problem }
  const { status } = sample
  if (status === 401 || status === 403 || status === 451) return { ok: false, problem: 'refused', httpStatus: status }
  if (status === 429) return { ok: false, problem: 'rate-limited', httpStatus: status }
  if (!isSuccess(status)) return { ok: false, problem: 'unavailable', httpStatus: status }
  if (!isImage(sample)) return { ok: false, problem: 'not-an-image' }
  return { ok: true, checked: sample.sha256 !== null }
}

/** Whether one picture shown for two places is a notice: anything that is not one flat colour, and, where the pixels could not be read, anything over the size floor. */
function pictureCanBeNotice(sample: TileSample): boolean {
  return sample.flat === null ? sample.byteLength >= NOTICE_MIN_BYTES : !sample.flat
}

/**
 * Judges the check: the tile under the map's centre and a different tile beside it. Each is
 * judged alone first, so a neighbour that is refused, limited, not an image or a known notice
 * is reported as it would be under the centre; a neighbour that is merely missing is not held
 * against the map. When both came back as the same bytes, and that picture can be a notice
 * (it is not one flat colour), the provider sent one picture for two places: a notice, not a map.
 */
export function judgeTiles(first: TileSample | null, second: TileSample | null): TileVerdict {
  const verdict = classifyTile(first)
  if (!verdict.ok || first === null || second === null) return verdict
  const beside = classifyTile(second)
  if (!beside.ok && beside.problem !== 'unavailable') return beside
  if (!verdict.checked) return verdict
  const same = second.sha256 === first.sha256 && second.byteLength === first.byteLength && isSuccess(second.status)
  return same && pictureCanBeNotice(first) ? { ok: false, problem: 'notice' } : verdict
}

// ── What the map says ─────────────────────────────────────────────────────────

/** Where the basemap stands. `ready` is the only state that draws tiles. */
export type BasemapStatus =
  | { state: 'checking'; host?: string }
  | { state: 'none' }
  | { state: 'unavailable' }
  | { state: 'misconfigured'; problem: BasemapConfigProblem }
  | { state: 'unsupported' }
  | { state: 'needs-consent'; host: string }
  | { state: 'declined'; host: string }
  | { state: 'ready'; host: string; checked: boolean }
  | { state: 'provider-problem'; host: string; problem: ProviderProblem; httpStatus?: number; requiresKey: boolean }

const BLANK_MAP = 'Pins show on a blank map.'

function providerProblemText(status: Extract<BasemapStatus, { state: 'provider-problem' }>): { headline: string; detail: string } {
  const code = status.httpStatus === undefined ? '' : ` (HTTP ${status.httpStatus})`
  switch (status.problem) {
    case 'key-required':
      return { headline: 'The tile provider wants an API key', detail: 'No map shown.' }
    case 'refused':
      return { headline: `The tile provider refused the request${code}`, detail: status.requiresKey ? 'No map shown. Check the key on the Scan server.' : 'No map shown.' }
    case 'rate-limited':
      return { headline: `The tile provider is limiting requests${code}`, detail: 'No map shown.' }
    case 'notice':
      return { headline: 'The tile provider sent a notice, not a map', detail: 'It sent the same picture for two different places. No map shown.' }
    case 'not-an-image':
      return { headline: 'The tile host did not send a map image', detail: 'No map shown.' }
    case 'unavailable':
      return status.httpStatus === undefined
        ? { headline: 'The tile host did not answer the check', detail: 'It may not allow this page to read its tiles. No map shown.' }
        : { headline: `The tile host answered HTTP ${status.httpStatus}`, detail: 'No map shown.' }
    case 'stalled':
      return { headline: 'Map tiles stopped loading', detail: `${TILE_ERROR_RUN} tiles in a row did not load, so parts of the map may be missing.` }
  }
}

/**
 * The words for a basemap state: a headline and a line under it. Short, and only what the code
 * found out. It never says a map was verified, because the check only looks for known failures.
 */
export function basemapStatusText(status: BasemapStatus): { headline: string; detail: string } {
  switch (status.state) {
    case 'checking':
      return { headline: 'Checking the map tiles…', detail: status.host ? `Asking ${status.host} for a tile.` : '' }
    case 'none':
      return { headline: 'No basemap configured', detail: BLANK_MAP }
    case 'unavailable':
      return { headline: 'Basemap settings unavailable', detail: `The Scan server did not send them. ${BLANK_MAP}` }
    case 'misconfigured':
      return { headline: 'Basemap setting is not valid', detail: `${basemapProblemText(status.problem)} ${BLANK_MAP}` }
    case 'unsupported':
      return { headline: 'Vector tiles are not supported in this build', detail: BLANK_MAP }
    case 'needs-consent':
      return { headline: `Show map tiles from ${status.host}?`, detail: "That host sees where the map is looking, your IP address and this app's address. Say no and pins show on a blank map." }
    case 'declined':
      return { headline: 'Map tiles are off on this device', detail: `They would come from ${status.host}.` }
    case 'ready':
      return { headline: `Map tiles from ${status.host}`, detail: status.checked ? '' : 'These tiles could not be checked on this page.' }
    case 'provider-problem':
      return providerProblemText(status)
  }
}
