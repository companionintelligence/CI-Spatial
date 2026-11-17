/**
 * The 8th Wall settings that fix the unit of a session, applied before the engine runs, and the record
 * of what was applied.
 *
 * ## Why
 *
 * The engine has two scale modes, and this app never chose one
 * (https://8thwall.org/docs/api/engine/xrcontroller/configure). It ran the default, `responsive`, in
 * which the camera on frame 1 sits at an origin whose height defaults to 2
 * (https://8thwall.org/docs/api/engine/xrcontroller/updatecameraprojectionmatrix). So the camera's
 * height above the ground becomes that number on frame 1, and one unit is the phone's real height
 * divided by it (an inference from the docs, not a measurement). That is not a metre, and it differs
 * between visits. `absolute` returns metres once the engine has estimated them: the person moves the
 * phone back and forth, and the engine sets its virtual camera height to the phone's real one
 * (https://info.nianticspatial.com/blog/introducing-absolute-scale).
 *
 * Meanwhile the frame transform is rigid (scale 1), the separation check compares two measurements
 * taken by the same runtime, and every constant is in metres. A unit that differs between two visits of
 * one room moves the far wall with no tap error at all, and nothing recorded which unit a scan was in.
 *
 * ## What this file does
 *
 * - `EngineScaleSession.configure()` runs on every start, after the SLAM chunk has loaded and before the
 *   pipeline modules are built and `XR8.run()` is called. The configure page says the world-tracking
 *   switch must be set before both `pipelineModule()` and `run()` and cannot change while the engine
 *   runs. It does not say that of `scale`, and it does not say whether a setting survives `XR8.stop()`.
 *   So scale is held to the same rule and applied again on every start.
 * - `?scale=absolute|responsive` picks the scale. A page that names none gets `DEFAULT_ENGINE_SCALE`.
 *   While that is the engine's own default, such a page leaves the engine alone: it makes no engine call
 *   it never made before, and nothing in a default session depends on the engine's handling of the call.
 * - `?originY=<metres>` (experiment arm R1 of device test DX1) sets the camera origin height in
 *   responsive scale, with the call the docs show for a module's `onStart`
 *   (https://8thwall.org/docs/api/engine/camerapipelinemodule/onstart). It changes the unit of every new
 *   responsive scan: with the phone held at that height when AR starts, one unit would be about a metre.
 * - The engine has no getter for the scale it is in. The effective mode is kept here, in
 *   `EngineScaleSession`, and `stampScale` writes it onto the calibration where it reaches the scanner.
 *
 * Nothing here reads or depends on how high the phone was when AR started. Absolute scale changes what
 * the first pose's height means (near the phone's height, with the floor near zero), and no default is
 * changed to suit it.
 */
import { scaleKindOfMode, type ScaleKind, type ScaleMode } from '../world/scale-mode.ts'
import type { ScanCalibration } from '../world/types.ts'

export type EngineScale = 'responsive' | 'absolute'

/**
 * The scale the engine runs in when nothing configures it: `responsive`
 * (https://8thwall.org/docs/api/engine/xrcontroller/configure). A fact about the engine, documented, and
 * not a choice of this app. It is what lets a page that wants the same scale skip the call.
 */
export const ENGINE_OWN_DEFAULT_SCALE: EngineScale = 'responsive'

/**
 * The scale a start asks for when the URL names none.
 *
 * **Adopted, not measured** (ADR 0005 rule 5; owner decision D3 is open). It stays `'responsive'` so
 * that a page without `?scale=` behaves as it did before this file existed, until device experiment DX1
 * (a taped 3.000 m, three start heights, both scales) shows whether `'absolute'` should be the default.
 * A test pins this value, so changing it is a deliberate edit. In this file, changing it to `'absolute'`
 * is the only edit that makes a page without `?scale=` run in absolute scale: a default that is not the
 * engine's own is sent to the engine. What else that default asks of the calibration flow (absolute
 * scale puts the first pose near the phone's height) is for DX1 to show.
 */
export const DEFAULT_ENGINE_SCALE: EngineScale = 'responsive'

/**
 * The camera origin heights `?originY=` accepts, in metres.
 *
 * **Adopted, not measured** (ADR 0005 rule 5). They are not tolerances on how high a phone is held. They
 * only reject a typo such as `?originY=14`, or a height no phone is held at. A value outside them is
 * ignored, and the session is recorded as it would be without the parameter.
 */
export const ORIGIN_Y_MIN_M = 0.3
export const ORIGIN_Y_MAX_M = 3

/**
 * The part of the `XR8` global this file calls. Both methods are in the engine's documented API, and
 * both are optional here: the scripted mock in `public/test-fixtures/xr8-mock.js` had neither before
 * this change, and a start must not fail because an engine build lacks one.
 */
export interface ScaleEngine {
  XrController?: {
    configure?(config: { scale: EngineScale }): void
    updateCameraProjectionMatrix?(args: {
      origin: { x: number; y: number; z: number }
      facing: { w: number; x: number; y: number; z: number }
    }): void
  }
}

/** The part of a three.js camera `applyOrigin` touches, so a fake camera works. */
export interface OriginCamera {
  position?: { set?(x: number, y: number, z: number): unknown }
}

function readParam(search: string, name: string): string | null {
  try {
    return new URLSearchParams(search).get(name)
  } catch {
    return null
  }
}

/** `'absolute'` or `'responsive'`, ignoring case and spaces. Anything else, including nothing, is null. */
export function parseEngineScale(raw: string | null): EngineScale | null {
  const value = raw?.trim().toLowerCase()
  return value === 'absolute' || value === 'responsive' ? value : null
}

/** What a page's URL asks of the engine's scale. */
export interface ScalePlan {
  /** The scale the session wants: `?scale=` when it names one, otherwise the build default. */
  scale: EngineScale
  /** `?scale=` as written, when it was there and was neither scale (a typo, or empty). Null otherwise. */
  ignored: string | null
  /**
   * Whether the engine has to be told. It does when the page named a scale, and when the scale wanted is
   * not the engine's own default; it does not for a page that names none while the build default is the
   * engine's own, which would only repeat what the engine does anyway.
   */
  configure: boolean
}

/** Read `?scale=` from a query string. `buildDefault` is a parameter so the effect of changing it can be tested. */
export function planScale(search: string, buildDefault: EngineScale = DEFAULT_ENGINE_SCALE): ScalePlan {
  const asked = readParam(search, 'scale')
  const named = parseEngineScale(asked)
  const scale = named ?? buildDefault
  return {
    scale,
    ignored: asked !== null && named === null ? asked : null,
    configure: named !== null || scale !== ENGINE_OWN_DEFAULT_SCALE,
  }
}

/** The scale this page asks for: `?scale=` when it names one, otherwise `DEFAULT_ENGINE_SCALE`. */
export function resolveEngineScale(search: string): EngineScale {
  return planScale(search).scale
}

/**
 * The camera origin height `?originY=` asks for, in metres rounded to the millimetre, or null when it
 * is absent, not a number, or outside `ORIGIN_Y_MIN_M`..`ORIGIN_Y_MAX_M`.
 */
export function resolveOriginY(search: string): number | null {
  const text = readParam(search, 'originY')?.trim()
  if (!text) return null
  const metres = Number(text)
  if (!Number.isFinite(metres) || metres < ORIGIN_Y_MIN_M || metres > ORIGIN_Y_MAX_M) return null
  return Math.round(metres * 1000) / 1000
}

/** Why a configure call did not take. */
export type ConfigureFailure = 'no-configure' | 'configure-too-late' | 'configure-failed'

export type ConfigureResult =
  | { applied: true; scale: EngineScale }
  | { applied: false; scale: EngineScale; reason: ConfigureFailure; detail: string }

/**
 * What a start did about the scale: `configureEngine`'s result, or that it did not call the engine
 * because the page wanted the engine's own default.
 */
export type ScaleStartResult =
  | ConfigureResult
  | { applied: false; scale: EngineScale; reason: 'engine-default'; detail: string }

/**
 * Words that say a setting was refused for being made after the engine started. The engine's own wording
 * is not documented, so this only decides which of the two failure labels the log uses. Both mean the same
 * to the session: the scale was not applied.
 */
const TOO_LATE = /\b(?:before|after|while)\b.*\brun/i

/**
 * Tell the engine which scale to use. Returns what happened and never throws: a start must go on without
 * the setting rather than fail because of it, and the session then records the unit as arbitrary.
 *
 * Call it after the SLAM chunk has loaded and before `XrController.pipelineModule()` and `XR8.run()`.
 */
export function configureEngine(engine: ScaleEngine, { scale }: { scale: EngineScale }): ConfigureResult {
  const controller = engine.XrController
  if (typeof controller?.configure !== 'function') {
    return { applied: false, scale, reason: 'no-configure', detail: 'XrController.configure is not available' }
  }
  try {
    controller.configure({ scale })
    return { applied: true, scale }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { applied: false, scale, reason: TOO_LATE.test(detail) ? 'configure-too-late' : 'configure-failed', detail }
  }
}

/**
 * The unit of one 8th Wall session, from the start that fixed it to the tracking status that says
 * whether an estimate exists. One per provider. Not a getter on the engine: the engine has none.
 */
export class EngineScaleSession {
  /** The scale this start wanted, or null before a start and after a stop. */
  private wanted: EngineScale | null = null
  /** Whether the engine took `wanted`: it was told, and did not refuse. False when it was not told. */
  private applied = false
  /** The origin height `?originY=` asked for, responsive scale only. */
  private wantedOriginY: number | null = null
  /** The origin height the engine was actually given. */
  private appliedOriginY: number | null = null
  /**
   * When a position was last measured while absolute scale was not ready, on the clock `now` reads, or
   * null when none has been since the start. See `noteMeasurement`.
   */
  private unreadyMeasuredAt: number | null = null
  private readonly now: () => number

  /** `now` is the clock `noteMeasurement` stamps with, and `since` arguments are read on. Default: `performance.now()`. */
  constructor(now?: () => number) {
    this.now = now ?? (() => performance.now())
  }

  /**
   * Fix the scale for the start that is about to run `XR8.run()`. Reads `?scale=` and `?originY=` from
   * `search`, calls the engine unless the page wants its own default, and forgets whatever the last start
   * set.
   */
  configure(engine: ScaleEngine, search: string): ScaleStartResult {
    this.reset()
    const plan = planScale(search)
    if (plan.ignored !== null) {
      console.warn(`[8thwall] ?scale=${plan.ignored} is not absolute or responsive, so ${plan.scale} is used`)
    }
    this.wanted = plan.scale

    let result: ScaleStartResult
    if (plan.configure) {
      result = configureEngine(engine, { scale: plan.scale })
      this.applied = result.applied
      if (!result.applied && plan.scale === 'absolute') {
        // Only absolute changes what the scan means, so only absolute is worth a warning. A responsive
        // scale that did not apply is the engine running as it always did.
        console.warn(`[8thwall] absolute scale was not applied (${result.reason}: ${result.detail}), so this session's unit is recorded as arbitrary`)
      }
    } else {
      result = { applied: false, scale: plan.scale, reason: 'engine-default', detail: 'the page asks for the engine default' }
    }

    const askedOriginY = readParam(search, 'originY')
    if (plan.scale === 'responsive') {
      this.wantedOriginY = resolveOriginY(search)
      if (askedOriginY !== null && this.wantedOriginY === null) {
        console.warn(`[8thwall] ?originY=${askedOriginY} is not a height from ${ORIGIN_Y_MIN_M} to ${ORIGIN_Y_MAX_M} m, so it is ignored`)
      }
    } else if (askedOriginY !== null) {
      console.log('[8thwall] ?originY= is ignored in absolute scale: the engine takes the height from the phone')
    }

    const outcome = result.applied ? 'applied' : result.reason
    console.log('[8thwall] engine scale', JSON.stringify({ scale: plan.scale, outcome, originY: this.wantedOriginY }))
    return result
  }

  /**
   * Experiment arm R1: put the camera origin at `?originY=` metres. Call it from a pipeline module's
   * `onStart`, in a module installed after the Threejs one, which is the placement the docs show
   * (https://8thwall.org/docs/api/engine/camerapipelinemodule/onstart). The scene camera is moved to the
   * same point so it and the engine start together, as that example does. A no-op, returning false,
   * unless `?originY=` was given in responsive scale and the engine took it.
   */
  applyOrigin(engine: ScaleEngine, camera?: OriginCamera | null): boolean {
    const y = this.wantedOriginY
    if (y === null) return false
    const controller = engine.XrController
    if (typeof controller?.updateCameraProjectionMatrix !== 'function') {
      console.warn('[8thwall] ?originY= was not applied: the engine has no updateCameraProjectionMatrix')
      return false
    }
    try {
      camera?.position?.set?.(0, y, 0)
      controller.updateCameraProjectionMatrix({ origin: { x: 0, y, z: 0 }, facing: { w: 1, x: 0, y: 0, z: 0 } })
    } catch (err) {
      console.warn('[8thwall] ?originY= was not applied:', err instanceof Error ? err.message : String(err))
      return false
    }
    this.appliedOriginY = y
    console.log(`[8thwall] camera origin height set to ${y} m (?originY=)`)
    return true
  }

  /**
   * Note that a position was just measured (a hit test that found a point), given the tracking status
   * the engine reports now. In absolute scale, a position measured while that status is not NORMAL was
   * measured before the estimate is known to have settled; `mode(status, since)` holds it against a
   * calibration made from positions like it. A no-op in every other mode.
   */
  noteMeasurement(status: string): void {
    if (this.wanted === 'absolute' && this.applied && status !== 'NORMAL') this.unreadyMeasuredAt = this.now()
  }

  /** Forget the last start. A session that is not running has no unit to report. */
  reset(): void {
    this.wanted = null
    this.applied = false
    this.wantedOriginY = null
    this.appliedOriginY = null
    this.unreadyMeasuredAt = null
  }

  /**
   * Which configuration produced the unit, given the tracking status the engine reports now. Absolute
   * scale the engine took is `'absolute-ready'` only while that status is NORMAL, which is the nearest
   * thing to a "scale is ready" signal the engine documents (see `ARProvider.scaleReady`). That NORMAL
   * means the estimate has settled is adopted, not measured (ADR 0005 rule 5).
   *
   * `since` is a reading of the clock this session was given, taken before a calibration flow began.
   * When it is given, absolute scale is `'absolute-ready'` only if, besides the status being NORMAL now,
   * no position was measured since then while it was not. A calibration made from a point measured
   * before the estimate settled is not stamped as one made after.
   */
  mode(status: string, since?: number): ScaleMode {
    if (this.wanted === 'absolute') {
      if (!this.applied) return 'absolute-notapplied'
      const measuredUnready = since !== undefined && this.unreadyMeasuredAt !== null && this.unreadyMeasuredAt >= since
      return status === 'NORMAL' && !measuredUnready ? 'absolute-ready' : 'absolute-notready'
    }
    if (this.appliedOriginY !== null) return `responsive-originY:${this.appliedOriginY}`
    return 'responsive-unconfigured'
  }

  /** What the unit is worth. Always `scaleKindOfMode(this.mode(status, since))`, so the two cannot disagree. */
  kind(status: string, since?: number): ScaleKind {
    return scaleKindOfMode(this.mode(status, since))
  }

  /** True only in absolute scale the engine took, with tracking NORMAL. */
  ready(status: string): boolean {
    return this.mode(status) === 'absolute-ready'
  }
}

/** What `stampScale` reads from a provider: the two optional members of `ARProvider` that describe its unit. */
export interface ScaleReporter {
  scaleKind?(since?: number): ScaleKind
  scaleMode?(since?: number): ScaleMode
}

/**
 * The calibration with the unit its session ran in written onto it. Call it where the calibration result
 * reaches the scanner, once, so that every scan, sidecar and manifest made from it carries the unit.
 *
 * It copies: the argument is not changed. It leaves a calibration alone, returning the same object, when
 * the provider reports nothing (the fields stay absent, which means "not recorded") and when the
 * calibration is the server's `'known-distance'` tier, whose metre stick is a tape and not a runtime.
 *
 * The stamp is taken when this is called. `since` is a `performance.now()` reading taken before the
 * calibration flow began: with it, a provider that watches its own measurements (`ARProvider.scaleMode`)
 * says `'absolute-notready'` for a flow that measured a point before the scale was ready, even when
 * tracking is NORMAL by the time the flow ends. Without it the stamp is the unit at this instant.
 */
export function stampScale<C extends ScanCalibration>(calibration: C, provider: ScaleReporter, since?: number): C {
  if (calibration.method === 'known-distance') return calibration
  const scaleMode = provider.scaleMode?.(since)
  const scaleKind = provider.scaleKind?.(since)
  if (scaleMode === undefined && scaleKind === undefined) return calibration
  return {
    ...calibration,
    ...(scaleMode === undefined ? {} : { scaleMode }),
    ...(scaleKind === undefined ? {} : { scaleKind }),
  }
}
