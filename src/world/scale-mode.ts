/**
 * What the unit of an AR session is worth, and where that unit came from.
 *
 * Every metre constant in the app (the 1.0 m baseline, the 0.15 m tolerance, the 12 m point cap) and
 * every comparison between two scans assumes that one unit of session space is one metre. A runtime
 * may only be taken at its word on that if it is metric:
 *
 * - WebXR is. It defines positions in metres (https://immersive-web.github.io/webxr/, the
 *   XRRigidTransform section), and ARCore documents its `Pose` translation in metres too
 *   (https://developers.google.com/ar/reference/java/com/google/ar/core/Pose).
 * - The 8th Wall engine is not by default. Its `scale` setting is `responsive` unless it is told
 *   otherwise: the camera on frame 1 is placed at an origin whose height is a configured number (2 unless
 *   set). By that description one unit is the phone's real height at the start divided by that number,
 *   so it differs between visits (an inference from the docs, not a measurement). `absolute` returns
 *   metres once the engine has estimated them (https://8thwall.org/docs/api/engine/xrcontroller/configure).
 *
 * Nothing in the stored data used to say which of these a scan was in. These types are what
 * `src/ar/engine-config.ts` stamps onto a calibration, `src/export/gltf.ts` writes into the upload
 * sidecar, and `server/calibration_fields.ts` reads back onto the `ScanManifest`.
 *
 * Kept in `src/world` with no Deno references (ADR 0002): the scanner, the Node tests and the Deno
 * server all import it.
 */

/**
 * What one unit of a session's coordinates is worth.
 *
 * - `'metric'`: the runtime's contract is metres (WebXR, and ARCore or ARKit behind the native
 *   plugin). That is the runtime's claim. This app has not measured it.
 * - `'estimated-metric'`: the runtime estimates metres (8th Wall in absolute scale, while tracking is
 *   NORMAL). Close to metres if the estimate converged, and not measured here either: device
 *   experiment DX1 is what measures it against a tape.
 * - `'arbitrary'`: the unit is whatever the runtime's configuration made it (8th Wall in responsive
 *   scale, in absolute scale before the estimate exists, or when absolute scale was asked for and the
 *   engine did not take it). A length in it is not a length in metres, and two sessions of one room
 *   can differ.
 */
export type ScaleKind = 'metric' | 'estimated-metric' | 'arbitrary'

/**
 * The camera origin height an 8th Wall responsive session was started with, in metres. Spelled
 * `responsive-originY:1.4`: the number is written the way `String(n)` writes it, to the millimetre.
 */
export type OriginYMode = `responsive-originY:${number}`

/**
 * Which configuration produced the unit. Provenance, for a log or a sidecar. What the unit is worth is
 * `ScaleKind`, which `scaleKindOfMode` derives from this.
 *
 * - `'responsive-unconfigured'`: 8th Wall, responsive scale, the engine's default origin height. What a
 *   page that names no scale gets, with the engine left as it is; also an explicit `?scale=responsive`.
 * - `` `responsive-originY:${n}` ``: 8th Wall, responsive scale, with the origin height set to `n`
 *   metres by `?originY=` (experiment arm R1 of DX1).
 * - `'absolute-ready'` and `'absolute-notready'`: 8th Wall, absolute scale, which the engine took. Ready
 *   means the tracking status was NORMAL when the mode was read and, for a calibration, at every point the
 *   flow measured (see `ARProvider.scaleMode`); anything else is not ready.
 * - `'absolute-notapplied'`: absolute scale was asked for (`?scale=absolute`, or a build default of
 *   absolute) and the engine did not take the setting: it has no `configure`, or it threw. Nothing then
 *   says the engine is in absolute scale, so the unit is arbitrary. It is its own string so that a scan
 *   from a failed absolute run cannot be counted as one from the default arm of device experiment DX1.
 * - `'webxr-metric'` and `'native-metric'`: runtimes whose unit is the metre by contract.
 */
export type ScaleMode =
  | 'responsive-unconfigured'
  | OriginYMode
  | 'absolute-ready'
  | 'absolute-notready'
  | 'absolute-notapplied'
  | 'webxr-metric'
  | 'native-metric'

/** Every mode that is one fixed string. */
export type FixedScaleMode = Exclude<ScaleMode, OriginYMode>

/**
 * What each fixed mode is worth. One table for both questions, "is this string a mode" and "what is
 * it worth", so a mode added to the union is a compile error here until it has a kind.
 */
const FIXED_MODE_KIND: Record<FixedScaleMode, ScaleKind> = {
  'responsive-unconfigured': 'arbitrary',
  'absolute-notapplied': 'arbitrary',
  'absolute-notready': 'arbitrary',
  'absolute-ready': 'estimated-metric',
  'webxr-metric': 'metric',
  'native-metric': 'metric',
}

/** Same reason: a kind added to the union is a compile error until it is listed. */
const EVERY_KIND: Record<ScaleKind, true> = { metric: true, 'estimated-metric': true, arbitrary: true }

/**
 * Membership is asked of a Set and not of the tables above, so a stored string such as `'constructor'` or
 * `'__proto__'` is not mistaken for a key the table inherits.
 */
const KINDS: ReadonlySet<string> = new Set(Object.keys(EVERY_KIND))
const FIXED_MODES: ReadonlySet<string> = new Set(Object.keys(FIXED_MODE_KIND))

const ORIGIN_Y_PREFIX = 'responsive-originY:'

/** Whether `value` is exactly what the writer produces for an origin height: a positive, finite `String(n)`. */
function isOriginYMode(value: string): value is OriginYMode {
  if (!value.startsWith(ORIGIN_Y_PREFIX)) return false
  const text = value.slice(ORIGIN_Y_PREFIX.length)
  const metres = Number(text)
  return Number.isFinite(metres) && metres > 0 && String(metres) === text
}

/** The kind a stored value names, or undefined for anything that is not one (a missing key, null, a typo). */
export function asScaleKind(value: unknown): ScaleKind | undefined {
  return typeof value === 'string' && KINDS.has(value) ? (value as ScaleKind) : undefined
}

/** The mode a stored value names, or undefined for anything that is not one. */
export function asScaleMode(value: unknown): ScaleMode | undefined {
  if (typeof value !== 'string') return undefined
  if (FIXED_MODES.has(value) || isOriginYMode(value)) return value as ScaleMode
  return undefined
}

/**
 * What a mode is worth. Only `'absolute-ready'` is an estimate of metres, and only the two runtimes
 * that are metric by contract are `'metric'`: every other 8th Wall mode is `'arbitrary'`, including an
 * origin height set to a number that looks like a phone's, because a typed number does not make the
 * phone be that high.
 */
export function scaleKindOfMode(mode: ScaleMode): ScaleKind {
  return isOriginYMode(mode) ? 'arbitrary' : FIXED_MODE_KIND[mode as FixedScaleMode]
}
