/**
 * WP-06a: the unit of an 8th Wall session is fixed before the engine runs, and it is recorded.
 *
 * The engine's `scale` setting decides whether one unit is a metre (`absolute`) or a number that follows
 * the phone's height when AR started (`responsive`, the default). The app never set it, and nothing
 * recorded which one a scan was in. These tests pin:
 *
 *   - what `?scale=` and `?originY=` ask for, and that a page without them leaves the engine alone;
 *   - that `configure()` reaches the engine after the SLAM chunk loads and before the pipeline modules are
 *     built and `run()` is called, on every start, including the one after a stop;
 *   - that an engine without `configure()` (the scripted test engine) or one that throws still starts,
 *     and is then recorded as an absolute scale that was not applied: an arbitrary unit, never metres;
 *   - what each provider says its unit is worth, and that nothing depends on how high the phone started;
 *   - that a calibration with a point measured before absolute scale was ready is not stamped ready;
 *   - that the unit is stamped onto the calibration where it reaches the scanner, written into the
 *     upload sidecar and the GLB, and survives a legacy record.
 *
 * The Deno half, the manifest reader, is tests/unit/deno/calibration_scale.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/engine_config.test.ts
 */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EighthWallProvider } from '../../../src/ar/eighthwall.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'
import { WebXRProvider } from '../../../src/ar/webxr.ts'
import { NativeARProvider } from '../../../src/ar/native-provider.ts'
import {
  configureEngine,
  DEFAULT_ENGINE_SCALE,
  ENGINE_OWN_DEFAULT_SCALE,
  EngineScaleSession,
  ORIGIN_Y_MAX_M,
  ORIGIN_Y_MIN_M,
  parseEngineScale,
  planScale,
  resolveEngineScale,
  resolveOriginY,
  stampScale,
} from '../../../src/ar/engine-config.ts'
import type { ScaleEngine } from '../../../src/ar/engine-config.ts'
import { asScaleMode, scaleKindOfMode } from '../../../src/world/scale-mode.ts'
import { exportToGLB } from '../../../src/export/gltf.ts'
import type { ScanCalibration, ScanEntry } from '../../../src/world/types.ts'
import type { DetectionStore } from '../../../src/scene/store.ts'
import type { PointCloud } from '../../../src/scene/pointcloud.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// ─── Browser globals the 8th Wall provider and the exporter read ───────────

const fakeWindow = {
  location: { search: '' },
  innerWidth: 360,
  innerHeight: 640,
  devicePixelRatio: 1,
  addEventListener(): void {},
  removeEventListener(): void {},
  dispatchEvent: () => true,
}
;(globalThis as { window?: unknown }).window = fakeWindow
;(globalThis as { document?: unknown }).document = {
  visibilityState: 'visible',
  querySelector: () => null,
  addEventListener(): void {},
  removeEventListener(): void {},
}

/** Silences and records the console for one test; the providers log on every start. */
function captureConsole(t: TestContext): string[] {
  const lines: string[] = []
  for (const level of ['log', 'warn', 'error'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      lines.push(`${level}: ${args.map(String).join(' ')}`)
    })
  }
  return lines
}

// ─── A fake XR8, with a call log in call order ─────────────────────────────

interface PipelineModule {
  name: string
  onStart?: (args: { videoWidth?: number; videoHeight?: number }) => void
  onUpdate?: (args: { processCpuResult?: Record<string, unknown> }) => void
}

interface FakeEngineOptions {
  /** `'missing'` leaves `XrController.configure` out, as the scripted test engine does; `{ throws }` makes it throw. */
  configure?: 'records' | 'missing' | { throws: unknown }
  updateProjection?: 'records' | 'missing' | { throws: unknown }
  /** What a hit test finds: a point 2.1 m from a phone at y = 1.4 (the default), or nothing. */
  hit?: 'point' | 'none'
  /** An engine that delivers one frame with this tracking status from inside `run()`, before `run()` returns. */
  frameInRun?: string
}

interface FakeCamera {
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }
}

function fakeCamera(): FakeCamera {
  const position = {
    x: 9,
    y: 9,
    z: 9,
    set(x: number, y: number, z: number): void {
      position.x = x
      position.y = y
      position.z = z
    },
  }
  return { position }
}

/** Installs a fake `XR8` global and returns what it saw. */
function installFakeEngine(options: FakeEngineOptions = {}) {
  const calls: string[] = []
  const configureArgs: unknown[] = []
  const projectionArgs: unknown[] = []
  const modules: PipelineModule[] = []
  const batches: string[][] = []
  const camera = fakeCamera()
  const hitTypes: unknown[] = []
  const controller: Record<string, unknown> = {
    pipelineModule: () => {
      calls.push('XrController.pipelineModule')
      return { name: 'xr' }
    },
    hitTest: (_x: number, _y: number, types: unknown) => {
      hitTypes.push(types)
      return options.hit === 'none'
        ? []
        : [{ position: { x: 0.5, y: 0, z: -1.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, distance: 2.1 }]
    },
  }
  const configure = options.configure ?? 'records'
  if (configure !== 'missing') {
    controller['configure'] = (config: unknown) => {
      calls.push('configure')
      configureArgs.push(config)
      if (typeof configure === 'object') throw configure.throws
    }
  }
  const updateProjection = options.updateProjection ?? 'records'
  if (updateProjection !== 'missing') {
    controller['updateCameraProjectionMatrix'] = (args: unknown) => {
      calls.push('updateCameraProjectionMatrix')
      projectionArgs.push(args)
      if (typeof updateProjection === 'object') throw updateProjection.throws
    }
  }
  ;(globalThis as { XR8?: unknown }).XR8 = {
    loadChunk: async () => {
      calls.push('loadChunk')
    },
    addCameraPipelineModules(mods: PipelineModule[]): void {
      calls.push('addCameraPipelineModules')
      modules.push(...mods)
      batches.push(mods.map((m) => m.name))
    },
    run(): void {
      calls.push('run')
      if (options.frameInRun === undefined) return
      const capture = modules.filter((m) => m.name === 'ci-scan-capture').at(-1)
      capture?.onUpdate?.({ processCpuResult: realityFrame(options.frameInRun, 1.4) })
    },
    stop(): void {
      calls.push('stop')
    },
    GlTextureRenderer: { pipelineModule: () => ({ name: 'gl' }) },
    Threejs: {
      pipelineModule: () => {
        calls.push('Threejs.pipelineModule')
        return { name: 'three' }
      },
      xrScene: () => ({ scene: {}, camera, renderer: {} }),
    },
    XrController: controller,
    CameraPixelArray: { pipelineModule: () => ({ name: 'pixels' }) },
    XrConfig: { device: () => ({ ANY: 'any' }) },
  }
  return {
    calls,
    configureArgs,
    projectionArgs,
    hitTypes,
    camera,
    /** The names of the modules the most recent start installed, in the order it installed them. */
    moduleNames(): string[] {
      return batches.at(-1) ?? []
    },
    /** The capture module of the most recent start. */
    capture(): PipelineModule {
      const found = modules.filter((m) => m.name === 'ci-scan-capture').at(-1)
      assert.ok(found, 'start() did not register the capture module')
      return found
    },
  }
}

type FakeEngine = ReturnType<typeof installFakeEngine>

function canvasStub(): HTMLCanvasElement {
  return { width: 360, height: 640, style: { removeProperty(): void {} } } as unknown as HTMLCanvasElement
}

/** A provider started against a fake engine, with `search` as the page's query string. */
async function startedProvider(search: string, options: FakeEngineOptions = {}) {
  fakeWindow.location.search = search
  const engine = installFakeEngine(options)
  const provider = new EighthWallProvider()
  await provider.start(canvasStub())
  return { provider, engine }
}

/** What the engine's pipeline puts in `processCpuResult` for one frame. */
function realityFrame(status: string, y: number): Record<string, unknown> {
  return {
    reality: {
      position: { x: 0, y, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      trackingStatus: status,
    },
  }
}

/** One reality frame, as the engine's pipeline hands it to a module's onUpdate. */
function feed(engine: FakeEngine, status: string, y = 1.4): void {
  engine.capture().onUpdate?.({ processCpuResult: realityFrame(status, y) })
}

/** What the three scale methods of a provider say right now, as one comparable value. */
function scaleAnswers(provider: { scaleKind?(): unknown; scaleReady?(): unknown; scaleMode?(): unknown }) {
  return { kind: provider.scaleKind?.(), ready: provider.scaleReady?.(), mode: provider.scaleMode?.() }
}

const TWO_POINT: Extract<ScanCalibration, { method: 'two-point-ground' }> = {
  method: 'two-point-ground',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  separationM: 1.6,
  residualM: 0.02,
  toleranceM: 0.15,
  anchorBearingDeg: 81.5,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'verified',
}

const ONE_POINT: Extract<ScanCalibration, { method: 'ground-tap-compass' }> = {
  method: 'ground-tap-compass',
  sessionToProject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  anchorBearingDeg: 40,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'provisional',
}

const KNOWN_DISTANCE: Extract<ScanCalibration, { method: 'known-distance' }> = {
  method: 'known-distance',
  sessionToProject: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1],
  separationM: 3.2,
  residualM: 0.02,
  toleranceM: 0.15,
  gravityAligned: true,
  calibratedAt: '2026-11-01T10:00:00.000Z',
  status: 'provisional',
}

// ─── ?scale= and ?originY= ─────────────────────────────────────────────────

test('?scale=: a page that names none gets the build default, and the build default is responsive until DX1', () => {
  // Owner decision D3 is open, and the default must not change until device experiment DX1 has run.
  assert.equal(DEFAULT_ENGINE_SCALE, 'responsive')
  assert.equal(resolveEngineScale(''), 'responsive')
  assert.equal(resolveEngineScale('?debug=remote'), 'responsive')
  assert.equal(resolveEngineScale('?scale='), 'responsive')
})

test("?scale=: the engine's own default is responsive, which is a documented fact and not the build default", () => {
  assert.equal(ENGINE_OWN_DEFAULT_SCALE, 'responsive')
})

test('?scale=: exactly absolute or responsive, ignoring case and spaces; anything else is the default', () => {
  assert.equal(resolveEngineScale('?scale=absolute'), 'absolute')
  assert.equal(resolveEngineScale('?scale=responsive'), 'responsive')
  assert.equal(resolveEngineScale('?scale=ABSOLUTE'), 'absolute')
  assert.equal(resolveEngineScale('?scale=%20Absolute%20'), 'absolute')
  assert.equal(resolveEngineScale('?debug=remote,pose&scale=absolute&camerafit=cover'), 'absolute')
  for (const junk of ['metric', 'abs', 'absolutely', 'true', '1', 'metres', 'absolute,responsive']) {
    assert.equal(resolveEngineScale(`?scale=${junk}`), 'responsive', `?scale=${junk} must not select absolute`)
    assert.equal(parseEngineScale(junk), null)
  }
  assert.equal(parseEngineScale(null), null)
})

test('?scale= and ?originY=: a parameter that is repeated is read at its first occurrence, which the console line then shows', () => {
  assert.equal(resolveEngineScale('?scale=absolute&scale=responsive'), 'absolute')
  assert.equal(resolveEngineScale('?scale=responsive&scale=absolute'), 'responsive')
  assert.equal(resolveEngineScale('?scale=metres&scale=absolute'), 'responsive', 'a typo that comes first is not skipped')
  assert.equal(resolveOriginY('?originY=1.4&originY=2'), 1.4)
})

test('?scale=: both scales are recognised by name, so that naming the default is not the same as naming nothing', () => {
  // resolveEngineScale() answers 'responsive' for a typo as well, so only parseEngineScale() can tell
  // whether the page named it.
  assert.equal(parseEngineScale('responsive'), 'responsive')
  assert.equal(parseEngineScale('absolute'), 'absolute')
  assert.equal(parseEngineScale(' Responsive '), 'responsive')
  assert.equal(parseEngineScale('ABSOLUTE'), 'absolute')
  assert.equal(parseEngineScale(''), null)
})

test('?scale=: the engine is told only when the page names a scale or wants one that is not the engine default', () => {
  type Scale = 'responsive' | 'absolute'
  // [search, build default, scale wanted, is the engine told, the ?scale= text that was ignored]
  const cases: Array<[string, Scale, Scale, boolean, string | null]> = [
    ['', 'responsive', 'responsive', false, null],
    ['?debug=remote&originY=1.4', 'responsive', 'responsive', false, null],
    ['?scale=responsive', 'responsive', 'responsive', true, null],
    ['?scale=absolute', 'responsive', 'absolute', true, null],
    ['?scale=metres', 'responsive', 'responsive', false, 'metres'],
    ['?scale=', 'responsive', 'responsive', false, ''],
    // The day DX1 makes absolute the build default: a page that names none is sent absolute, and one
    // that names responsive is sent responsive.
    ['', 'absolute', 'absolute', true, null],
    ['?scale=metres', 'absolute', 'absolute', true, 'metres'],
    ['?scale=responsive', 'absolute', 'responsive', true, null],
    ['?scale=absolute', 'absolute', 'absolute', true, null],
  ]
  for (const [search, buildDefault, scale, configure, ignored] of cases) {
    assert.deepEqual(planScale(search, buildDefault), { scale, configure, ignored }, `${JSON.stringify(search)} with default ${buildDefault}`)
  }
  assert.deepEqual(planScale(''), planScale('', DEFAULT_ENGINE_SCALE), 'the build default is the default argument')
  assert.equal(planScale('').configure, false, 'with the build default as it ships, a page that names no scale leaves the engine alone')
})

test('?originY=: a camera height in metres inside the accepted window, rounded to the millimetre', () => {
  assert.equal(resolveOriginY(''), null)
  assert.equal(resolveOriginY('?scale=absolute'), null)
  assert.equal(resolveOriginY('?originY=1.4'), 1.4)
  assert.equal(resolveOriginY('?originY=2'), 2)
  assert.equal(resolveOriginY('?originY=1.2345'), 1.235)
  assert.equal(resolveOriginY(`?originY=${ORIGIN_Y_MIN_M}`), ORIGIN_Y_MIN_M)
  assert.equal(resolveOriginY(`?originY=${ORIGIN_Y_MAX_M}`), ORIGIN_Y_MAX_M)
  assert.equal(resolveOriginY('?x=1&originY=%201.5%20'), 1.5)
})

test('?originY=: the accepted window is 0.3 to 3 m, written out so that moving it is a deliberate edit', () => {
  // The constants are adopted, not measured (ADR 0005 rule 5). A test that only reads them back from the
  // module would pass whatever they were changed to.
  assert.equal(ORIGIN_Y_MIN_M, 0.3)
  assert.equal(ORIGIN_Y_MAX_M, 3)
  assert.equal(resolveOriginY('?originY=0.3'), 0.3)
  assert.equal(resolveOriginY('?originY=3'), 3)
  assert.equal(resolveOriginY('?originY=0.299'), null)
  assert.equal(resolveOriginY('?originY=3.001'), null)
})

test('?originY=: a typo, zero, a negative, a non-number or a height outside the window is ignored', () => {
  for (const junk of ['', '0', '-1', '14', '0.29', '3.01', 'abc', '1.4m', 'NaN', 'Infinity', '1,4', '0x10']) {
    assert.equal(resolveOriginY(`?originY=${junk}`), null, `?originY=${junk} must be ignored`)
  }
})

// ─── configureEngine ───────────────────────────────────────────────────────

test('configureEngine: hands the scale to XrController.configure and says it was applied', () => {
  const seen: unknown[] = []
  const engine: ScaleEngine = { XrController: { configure: (config) => void seen.push(config) } }
  assert.deepEqual(configureEngine(engine, { scale: 'absolute' }), { applied: true, scale: 'absolute' })
  assert.deepEqual(configureEngine(engine, { scale: 'responsive' }), { applied: true, scale: 'responsive' })
  assert.deepEqual(seen, [{ scale: 'absolute' }, { scale: 'responsive' }])
})

test('configureEngine: an engine with no configure, or no XrController, is not an error', () => {
  const missing = { applied: false, scale: 'absolute', reason: 'no-configure', detail: 'XrController.configure is not available' }
  assert.deepEqual(configureEngine({ XrController: {} }, { scale: 'absolute' }), missing)
  assert.deepEqual(configureEngine({}, { scale: 'absolute' }), missing)
})

test('configureEngine: a refusal made after the engine started is configure-too-late; any other throw is configure-failed', () => {
  const throwing = (thrown: unknown): ScaleEngine => ({
    XrController: {
      configure: () => {
        throw thrown
      },
    },
  })
  const late = configureEngine(throwing(new Error('scale can only be set before run')), { scale: 'absolute' })
  assert.equal(late.applied, false)
  assert.equal(late.applied === false && late.reason, 'configure-too-late')
  const lateRunning = configureEngine(throwing(new Error('cannot be changed while the engine is running')), { scale: 'absolute' })
  assert.equal(lateRunning.applied === false && lateRunning.reason, 'configure-too-late')

  const failed = configureEngine(throwing(new Error('boom')), { scale: 'absolute' })
  assert.equal(failed.applied === false && failed.reason, 'configure-failed')
  assert.equal(failed.applied === false && failed.detail, 'boom')

  // A thrown value that is not an Error is still reported, and still does not escape.
  const odd = configureEngine(throwing('plain string'), { scale: 'responsive' })
  assert.equal(odd.applied === false && odd.reason, 'configure-failed')
  assert.equal(odd.applied === false && odd.detail, 'plain string')
})

// ─── EngineScaleSession, without a provider ────────────────────────────────

test('session: before any start, and in the default scale, the unit is arbitrary and not ready', (t) => {
  captureConsole(t)
  const session = new EngineScaleSession()
  for (const status of ['', 'UNKNOWN', 'LIMITED', 'NORMAL']) {
    assert.equal(session.mode(status), 'responsive-unconfigured', status)
    assert.equal(session.kind(status), 'arbitrary', status)
    assert.equal(session.ready(status), false, status)
  }
  session.configure({ XrController: { configure() {} } }, '')
  for (const status of ['', 'UNKNOWN', 'LIMITED', 'NORMAL']) {
    assert.equal(session.mode(status), 'responsive-unconfigured', status)
    assert.equal(session.kind(status), 'arbitrary', status)
    assert.equal(session.ready(status), false, status)
  }
})

test('session: absolute scale is estimated-metric and ready only while tracking is NORMAL', (t) => {
  captureConsole(t)
  const session = new EngineScaleSession()
  const result = session.configure({ XrController: { configure() {} } }, '?scale=absolute')
  assert.equal(result.applied, true)
  for (const status of ['', 'UNKNOWN', 'INITIALIZING', 'LIMITED', 'NOT_AVAILABLE']) {
    assert.equal(session.mode(status), 'absolute-notready', status)
    assert.equal(session.kind(status), 'arbitrary', `${status}: before the estimate the unit is not metres`)
    assert.equal(session.ready(status), false, status)
  }
  assert.equal(session.mode('NORMAL'), 'absolute-ready')
  assert.equal(session.kind('NORMAL'), 'estimated-metric')
  assert.equal(session.ready('NORMAL'), true)
})

test('session: absolute scale the engine did not take is its own mode, arbitrary, even when tracking is NORMAL', (t) => {
  const lines = captureConsole(t)
  const refusals: Array<[ScaleEngine, string]> = [
    [{}, 'no-configure'],
    [{ XrController: {} }, 'no-configure'],
    [{ XrController: { configure: () => { throw new Error('boom') } } }, 'configure-failed'],
    [{ XrController: { configure: () => { throw new Error('scale can only be changed before run') } } }, 'configure-too-late'],
  ]
  for (const [engine, reason] of refusals) {
    lines.length = 0
    const session = new EngineScaleSession()
    const result = session.configure(engine, '?scale=absolute')
    assert.equal(result.applied, false)
    assert.equal(!result.applied && result.reason, reason)
    for (const status of ['', 'LIMITED', 'NORMAL']) {
      assert.equal(session.mode(status), 'absolute-notapplied', `${reason} at ${status}`)
      assert.equal(session.kind(status), 'arbitrary', `${reason} at ${status}`)
      assert.equal(session.ready(status), false, `${reason} at ${status}`)
    }
    assert.ok(lines.some((l) => l.startsWith('warn:') && /absolute scale was not applied/.test(l)), lines.join('\n'))
  }
})

test('session: an absolute run the engine refused is told apart from the default arm by what is stored, not by a console line', (t) => {
  captureConsole(t)
  // Device experiment DX1 compares the arms through what is stored with each scan.
  const refused = new EngineScaleSession()
  refused.configure({ XrController: {} }, '?scale=absolute')
  const defaultArm = new EngineScaleSession()
  defaultArm.configure({ XrController: {} }, '')
  assert.notEqual(refused.mode('NORMAL'), defaultArm.mode('NORMAL'))
  assert.equal(refused.kind('NORMAL'), defaultArm.kind('NORMAL'), 'both are arbitrary: neither is metres')
})

test('session: a page that names no scale does not call the engine, finds nothing missing, and does not warn', (t) => {
  const lines = captureConsole(t)
  const seen: unknown[] = []
  const recording: ScaleEngine = { XrController: { configure: (c) => void seen.push(c) } }
  for (const engine of [recording, { XrController: {} }, {}]) {
    const session = new EngineScaleSession()
    const result = session.configure(engine, '')
    assert.deepEqual(result, {
      applied: false,
      scale: 'responsive',
      reason: 'engine-default',
      detail: 'the page asks for the engine default',
    })
    assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  }
  assert.deepEqual(seen, [], 'the engine was configured by a page that asked for nothing')
  assert.deepEqual(lines.filter((l) => l.startsWith('warn:')), [])
})

test('session: an explicit ?scale=responsive is sent to the engine, and is still the default unit', (t) => {
  const lines = captureConsole(t)
  const seen: unknown[] = []
  const session = new EngineScaleSession()
  const result = session.configure({ XrController: { configure: (c) => void seen.push(c) } }, '?scale=responsive')
  assert.deepEqual(result, { applied: true, scale: 'responsive' })
  assert.deepEqual(seen, [{ scale: 'responsive' }])
  assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  assert.equal(session.kind('NORMAL'), 'arbitrary')
  // An engine that refuses it is running as it always did: nothing to warn about, and nothing changed.
  lines.length = 0
  const refused = new EngineScaleSession()
  refused.configure({ XrController: {} }, '?scale=responsive')
  assert.equal(refused.mode('NORMAL'), 'responsive-unconfigured')
  assert.deepEqual(lines.filter((l) => l.startsWith('warn:')), [])
})

test('session: a valid ?scale= draws no warning, in any case or spacing', (t) => {
  const lines = captureConsole(t)
  for (const value of ['absolute', 'responsive', 'ABSOLUTE', 'Responsive', '%20absolute%20']) {
    new EngineScaleSession().configure({ XrController: { configure() {} } }, `?scale=${value}`)
  }
  assert.deepEqual(lines.filter((l) => l.startsWith('warn:')), [])
})

test('session: an unrecognised ?scale= warns and leaves the engine alone, as a page that names none does', (t) => {
  const lines = captureConsole(t)
  const session = new EngineScaleSession()
  const seen: unknown[] = []
  session.configure({ XrController: { configure: (c) => void seen.push(c) } }, '?scale=metres')
  assert.deepEqual(seen, [])
  assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('?scale=metres')), lines.join('\n'))
})

test('session: a new configure forgets the last start', (t) => {
  captureConsole(t)
  const engine: ScaleEngine = { XrController: { configure() {}, updateCameraProjectionMatrix() {} } }
  const session = new EngineScaleSession()
  session.configure(engine, '?scale=absolute')
  assert.equal(session.mode('NORMAL'), 'absolute-ready')
  session.configure(engine, '?originY=1.4')
  assert.equal(session.mode('NORMAL'), 'responsive-unconfigured', 'the origin is not applied until onStart')
  assert.equal(session.applyOrigin(engine, null), true)
  assert.equal(session.mode('NORMAL'), 'responsive-originY:1.4')
  session.configure(engine, '')
  assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  assert.equal(session.applyOrigin(engine, null), false)
})

test('session: reset forgets everything, so a stopped session reports no unit', (t) => {
  captureConsole(t)
  const engine: ScaleEngine = { XrController: { configure() {}, updateCameraProjectionMatrix() {} } }
  const session = new EngineScaleSession()
  session.configure(engine, '?scale=absolute')
  session.reset()
  assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  session.configure(engine, '?originY=1.4')
  session.applyOrigin(engine, null)
  session.reset()
  assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  assert.equal(session.applyOrigin(engine, null), false)
})

test('session: a position measured while absolute scale was not ready makes the mode not ready for a flow that began before it', (t) => {
  captureConsole(t)
  let now = 1000
  const engine: ScaleEngine = { XrController: { configure() {} } }
  const session = new EngineScaleSession(() => now)
  session.configure(engine, '?scale=absolute')

  // A point measured before the flow began is not part of it.
  session.noteMeasurement('LIMITED')
  now = 2000
  const since = now
  assert.equal(session.mode('NORMAL', since), 'absolute-ready')
  session.noteMeasurement('NORMAL')
  assert.equal(session.mode('NORMAL', since), 'absolute-ready', 'a point measured while ready does not count against it')

  // A point measured while it was not ready, during the flow, does.
  now = 2500
  session.noteMeasurement('LIMITED')
  assert.equal(session.mode('NORMAL', since), 'absolute-notready')
  assert.equal(session.kind('NORMAL', since), 'arbitrary')
  assert.equal(session.mode('NORMAL', 2500), 'absolute-notready', 'a point measured at the very instant the flow began counts')
  assert.equal(session.mode('NORMAL', 2501), 'absolute-ready', 'a flow that began after it is not affected')

  // Tracking that is not NORMAL now is not ready, whatever was measured, and without `since` only now counts.
  assert.equal(session.mode('LIMITED', 3000), 'absolute-notready')
  assert.equal(session.mode('NORMAL'), 'absolute-ready', 'without a flow start the mode is the unit at this instant')
  assert.equal(session.kind('NORMAL'), 'estimated-metric')
  assert.equal(session.ready('NORMAL'), true, 'scaleReady() is the instant too')
})

test('session: a measurement means nothing outside absolute scale the engine took', (t) => {
  captureConsole(t)
  const engine: ScaleEngine = { XrController: { configure() {}, updateCameraProjectionMatrix() {} } }
  for (const [search, expected] of [
    ['', 'responsive-unconfigured'],
    ['?scale=responsive', 'responsive-unconfigured'],
    ['?originY=1.4', 'responsive-originY:1.4'],
  ] as const) {
    const session = new EngineScaleSession(() => 5)
    session.configure(engine, search)
    session.applyOrigin(engine, null)
    session.noteMeasurement('LIMITED')
    assert.equal(session.mode('LIMITED', 0), expected, search)
    assert.equal(session.mode('NORMAL', 0), expected, search)
  }
  const refused = new EngineScaleSession(() => 5)
  refused.configure({ XrController: {} }, '?scale=absolute')
  refused.noteMeasurement('LIMITED')
  assert.equal(refused.mode('NORMAL', 0), 'absolute-notapplied')
  const idle = new EngineScaleSession(() => 5)
  idle.noteMeasurement('LIMITED')
  assert.equal(idle.mode('NORMAL', 0), 'responsive-unconfigured', 'a session that was never started has no unit to doubt')
})

test('session: the measurements of the last start are forgotten by the next start and by reset', (t) => {
  captureConsole(t)
  const engine: ScaleEngine = { XrController: { configure() {} } }
  const session = new EngineScaleSession(() => 10)
  session.configure(engine, '?scale=absolute')
  session.noteMeasurement('LIMITED')
  assert.equal(session.mode('NORMAL', 0), 'absolute-notready')
  session.configure(engine, '?scale=absolute')
  assert.equal(session.mode('NORMAL', 0), 'absolute-ready', 'a new start has measured nothing yet')
  session.noteMeasurement('LIMITED')
  session.reset()
  session.configure(engine, '?scale=absolute')
  assert.equal(session.mode('NORMAL', 0), 'absolute-ready', 'reset forgets them too')
})

test('session: without a clock of its own the session reads performance.now()', (t) => {
  captureConsole(t)
  let now = 4000
  t.mock.method(performance, 'now', () => now)
  const session = new EngineScaleSession()
  session.configure({ XrController: { configure() {} } }, '?scale=absolute')
  session.noteMeasurement('LIMITED')
  now = 4001
  assert.equal(session.mode('NORMAL', 4000), 'absolute-notready')
  assert.equal(session.mode('NORMAL', 4001), 'absolute-ready')
})

test('originY arm: sets the engine origin and the scene camera, and is recorded with the height', (t) => {
  captureConsole(t)
  const projection: unknown[] = []
  const engine: ScaleEngine = {
    XrController: { configure() {}, updateCameraProjectionMatrix: (args) => void projection.push(args) },
  }
  const camera = fakeCamera()
  const session = new EngineScaleSession()
  session.configure(engine, '?originY=1.4')
  assert.equal(session.applyOrigin(engine, camera), true)
  assert.deepEqual(projection, [{ origin: { x: 0, y: 1.4, z: 0 }, facing: { w: 1, x: 0, y: 0, z: 0 } }])
  assert.deepEqual([camera.position.x, camera.position.y, camera.position.z], [0, 1.4, 0])
  assert.equal(session.mode('NORMAL'), 'responsive-originY:1.4')
  assert.equal(session.kind('NORMAL'), 'arbitrary', 'a typed height does not make the unit a metre')
  assert.equal(session.ready('NORMAL'), false)
})

test('originY arm: not applied in absolute scale, outside the window, or without ?originY=', (t) => {
  const lines = captureConsole(t)
  const projection: unknown[] = []
  const engine: ScaleEngine = {
    XrController: { configure() {}, updateCameraProjectionMatrix: (args) => void projection.push(args) },
  }
  const cases: Array<[string, string]> = [
    ['?scale=absolute&originY=1.4', 'absolute-ready'],
    ['?originY=14', 'responsive-unconfigured'],
    ['?originY=abc', 'responsive-unconfigured'],
    ['', 'responsive-unconfigured'],
    ['?scale=responsive', 'responsive-unconfigured'],
  ]
  for (const [search, modeAtNormal] of cases) {
    const session = new EngineScaleSession()
    session.configure(engine, search)
    assert.equal(session.applyOrigin(engine, fakeCamera()), false, search)
    assert.equal(session.mode('NORMAL'), modeAtNormal, search)
  }
  assert.deepEqual(projection, [], 'the engine origin must stay at its default unless the arm is on')
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('?originY=14')), 'a rejected height says so')
})

test('originY arm: an engine without updateCameraProjectionMatrix, or one that throws, leaves the unit unrecorded as set', (t) => {
  const lines = captureConsole(t)
  const without: ScaleEngine = { XrController: { configure() {} } }
  const throwing: ScaleEngine = {
    XrController: {
      configure() {},
      updateCameraProjectionMatrix() {
        throw new Error('no origin for you')
      },
    },
  }
  for (const engine of [without, throwing, {}]) {
    const session = new EngineScaleSession()
    session.configure(engine, '?originY=1.4')
    assert.equal(session.applyOrigin(engine, fakeCamera()), false)
    assert.equal(session.mode('NORMAL'), 'responsive-unconfigured')
  }
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('no origin for you')))
})

test('originY arm: a scene camera that is not there, or has no set(), does not stop the origin being applied', (t) => {
  captureConsole(t)
  const engine: ScaleEngine = { XrController: { configure() {}, updateCameraProjectionMatrix() {} } }
  for (const camera of [null, undefined, {}, { position: {} }]) {
    const session = new EngineScaleSession()
    session.configure(engine, '?originY=1.4')
    assert.equal(session.applyOrigin(engine, camera), true)
    assert.equal(session.mode('NORMAL'), 'responsive-originY:1.4')
  }
})

// ─── The provider: configure() runs before run(), on every start ───────────

test('start: configure runs after loadChunk and before the pipeline modules are built and run() is called', async (t) => {
  captureConsole(t)
  const { engine } = await startedProvider('?scale=absolute')
  assert.deepEqual(engine.configureArgs, [{ scale: 'absolute' }])
  const at = (call: string) => engine.calls.indexOf(call)
  assert.ok(at('loadChunk') >= 0 && at('configure') > at('loadChunk'), `configure must follow loadChunk: ${engine.calls.join(' > ')}`)
  assert.ok(
    at('configure') < at('XrController.pipelineModule'),
    `configure must come before XrController.pipelineModule() is called: ${engine.calls.join(' > ')}`,
  )
  assert.ok(at('configure') < at('addCameraPipelineModules'), engine.calls.join(' > '))
  assert.ok(at('configure') < at('run'), engine.calls.join(' > '))
})

test('start: configure is applied again on the start after a stop, before that start runs the engine', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=absolute')
  provider.stop()
  await provider.start(canvasStub())
  assert.deepEqual(engine.configureArgs, [{ scale: 'absolute' }, { scale: 'absolute' }])
  const configures = engine.calls.flatMap((c, i) => (c === 'configure' ? [i] : []))
  const runs = engine.calls.flatMap((c, i) => (c === 'run' ? [i] : []))
  const stops = engine.calls.flatMap((c, i) => (c === 'stop' ? [i] : []))
  assert.equal(configures.length, 2, engine.calls.join(' > '))
  assert.equal(runs.length, 2, engine.calls.join(' > '))
  assert.ok(configures[0] < runs[0] && runs[0] < stops[0] && stops[0] < configures[1] && configures[1] < runs[1], engine.calls.join(' > '))
})

test('start: the status of the last session is cleared before the engine runs, not after it', async (t) => {
  captureConsole(t)
  // An engine that delivers a frame from inside run(). A start that cleared the status after run() would
  // erase that frame's status, and the session would read as having none.
  const { provider } = await startedProvider('?scale=absolute', { frameInRun: 'NORMAL' })
  assert.equal(provider.trackingStatus(), 'NORMAL')
  assert.equal(provider.scaleReady(), true)
})

test('start: a page without ?scale= leaves the engine alone on every start, and runs in the default unit', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('')
  provider.stop()
  await provider.start(canvasStub())
  assert.deepEqual(engine.configureArgs, [], 'a default page must make no engine call it never made before')
  assert.ok(!engine.calls.includes('configure'), engine.calls.join(' > '))
  assert.equal(engine.calls.filter((c) => c === 'run').length, 2, engine.calls.join(' > '))
  assert.equal(provider.scaleKind(), 'arbitrary')
  assert.equal(provider.scaleMode(), 'responsive-unconfigured')
})

test('start: a typo in ?scale= leaves the engine alone too', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=metres')
  assert.deepEqual(engine.configureArgs, [])
  assert.equal(provider.scaleMode(), 'responsive-unconfigured')
})

test('start: ?scale=responsive is sent to the engine on every start, and is still the default unit', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=responsive')
  provider.stop()
  await provider.start(canvasStub())
  assert.deepEqual(engine.configureArgs, [{ scale: 'responsive' }, { scale: 'responsive' }])
  assert.equal(provider.scaleKind(), 'arbitrary')
  assert.equal(provider.scaleMode(), 'responsive-unconfigured')
})

test('start: the capture module is installed after the Threejs module, whose scene its onStart reads', async (t) => {
  captureConsole(t)
  const { engine } = await startedProvider('?originY=1.4')
  const names = engine.moduleNames()
  assert.ok(names.includes('three') && names.includes('ci-scan-capture'), names.join(' > '))
  // The engine runs the modules' onStart hooks in this order, and xrScene() is only there once the
  // Threejs module's has run (https://8thwall.org/docs/api/engine/camerapipelinemodule/onstart).
  assert.ok(names.indexOf('three') < names.indexOf('ci-scan-capture'), names.join(' > '))
})

test('start: an engine without configure() starts, runs, and reports the arbitrary unit', async (t) => {
  captureConsole(t)
  for (const [search, mode] of [
    ['', 'responsive-unconfigured'],
    ['?scale=responsive', 'responsive-unconfigured'],
    ['?scale=absolute', 'absolute-notapplied'],
  ] as const) {
    const { provider, engine } = await startedProvider(search, { configure: 'missing' })
    assert.ok(engine.calls.includes('run'), `${search}: start() did not reach run(): ${engine.calls.join(' > ')}`)
    assert.ok(!engine.calls.includes('configure'))
    feed(engine, 'NORMAL')
    assert.deepEqual(scaleAnswers(provider), { kind: 'arbitrary', ready: false, mode }, search)
  }
})

test('start: a configure() that throws does not stop the start, and the unit is recorded as arbitrary', async (t) => {
  const lines = captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=absolute', {
    configure: { throws: new Error('scale can only be set before the engine runs') },
  })
  assert.ok(engine.calls.includes('run'), engine.calls.join(' > '))
  feed(engine, 'NORMAL')
  assert.deepEqual(scaleAnswers(provider), { kind: 'arbitrary', ready: false, mode: 'absolute-notapplied' })
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('configure-too-late')), lines.join('\n'))
})

test('8th Wall provider: before start() and in the default scale the unit is arbitrary', async (t) => {
  captureConsole(t)
  fakeWindow.location.search = ''
  const idle = new EighthWallProvider()
  assert.deepEqual(scaleAnswers(idle), { kind: 'arbitrary', ready: false, mode: 'responsive-unconfigured' })
  const { provider, engine } = await startedProvider('')
  feed(engine, 'NORMAL')
  assert.deepEqual(scaleAnswers(provider), { kind: 'arbitrary', ready: false, mode: 'responsive-unconfigured' })
})

test('8th Wall provider: absolute scale becomes estimated-metric when tracking is NORMAL, and not before', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=absolute')
  assert.deepEqual(scaleAnswers(provider), { kind: 'arbitrary', ready: false, mode: 'absolute-notready' }, 'before the first frame')
  feed(engine, 'LIMITED')
  assert.deepEqual(scaleAnswers(provider), { kind: 'arbitrary', ready: false, mode: 'absolute-notready' }, 'while LIMITED')
  feed(engine, 'NORMAL')
  assert.deepEqual(scaleAnswers(provider), { kind: 'estimated-metric', ready: true, mode: 'absolute-ready' })
  feed(engine, 'LIMITED')
  assert.deepEqual(scaleAnswers(provider), { kind: 'arbitrary', ready: false, mode: 'absolute-notready' }, 'tracking degraded again')
})

test('8th Wall provider: a NORMAL left over from the last session is not a ready scale after a restart', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=absolute')
  feed(engine, 'NORMAL')
  assert.equal(provider.scaleReady(), true)
  provider.stop()
  assert.equal(provider.scaleReady(), false, 'a stopped session has no unit')
  await provider.start(canvasStub())
  assert.equal(provider.scaleReady(), false, 'the new session has had no frame yet')
  assert.equal(provider.scaleKind(), 'arbitrary')
  assert.equal(provider.trackingStatus(), 'UNKNOWN')
  feed(engine, 'NORMAL')
  assert.equal(provider.scaleReady(), true)
})

test('8th Wall provider: a point its hit test measures while absolute scale is not ready keeps the stamp from saying ready', async (t) => {
  captureConsole(t)
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const { provider, engine } = await startedProvider('?scale=absolute')
  feed(engine, 'LIMITED')
  const flowStartedAt = performance.now()
  now = 1500
  assert.ok(provider.hitTest(0.5, 0.5), 'the fake engine found a point')
  now = 2000
  feed(engine, 'NORMAL')
  // Tracking is NORMAL by the time the flow ends, which is all the instant says.
  assert.deepEqual(scaleAnswers(provider), { kind: 'estimated-metric', ready: true, mode: 'absolute-ready' })
  assert.equal(provider.scaleMode(flowStartedAt), 'absolute-notready')
  assert.equal(provider.scaleKind(flowStartedAt), 'arbitrary')
  const stamped = stampScale(TWO_POINT, provider, flowStartedAt)
  assert.equal(stamped.scaleMode, 'absolute-notready')
  assert.equal(stamped.scaleKind, 'arbitrary')
  assert.equal(stampScale(TWO_POINT, provider).scaleMode, 'absolute-ready', 'stamped without the flow start it is the instant')
})

test('8th Wall provider: points measured while tracking is NORMAL leave the stamp ready', async (t) => {
  captureConsole(t)
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const { provider, engine } = await startedProvider('?scale=absolute')
  // Measured before the flow began, while the scale was not ready: not part of this flow.
  feed(engine, 'LIMITED')
  assert.ok(provider.hitTest(0.5, 0.5))
  now = 1200
  const flowStartedAt = performance.now()
  now = 1300
  feed(engine, 'NORMAL')
  assert.ok(provider.hitTest(0.4, 0.5))
  assert.ok(provider.hitTest(0.6, 0.5))
  assert.equal(provider.scaleMode(flowStartedAt), 'absolute-ready')
  assert.equal(provider.scaleKind(flowStartedAt), 'estimated-metric')
  const stamped = stampScale(TWO_POINT, provider, flowStartedAt)
  assert.deepEqual([stamped.scaleMode, stamped.scaleKind], ['absolute-ready', 'estimated-metric'])
})

test('8th Wall provider: a hit test that finds nothing measures nothing', async (t) => {
  captureConsole(t)
  let now = 1000
  t.mock.method(performance, 'now', () => now)
  const { provider, engine } = await startedProvider('?scale=absolute', { hit: 'none' })
  feed(engine, 'LIMITED')
  const flowStartedAt = performance.now()
  now = 1500
  assert.equal(provider.hitTest(0.5, 0.5), null)
  now = 2000
  feed(engine, 'NORMAL')
  assert.equal(provider.scaleMode(flowStartedAt), 'absolute-ready', 'a tap that found no surface produced no position')
})

test('8th Wall provider: a flow start changes nothing in the default scale, and the hit test still asks only for feature points', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('')
  feed(engine, 'LIMITED')
  assert.ok(provider.hitTest(0.5, 0.5))
  assert.equal(provider.scaleMode(0), 'responsive-unconfigured')
  assert.equal(provider.scaleKind(0), 'arbitrary')
  assert.deepEqual(engine.hitTypes, [['FEATURE_POINT']])
})

test('8th Wall provider: the ?originY= arm is applied in the capture module onStart, which runs after the Threejs module', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?originY=1.4')
  assert.deepEqual(engine.projectionArgs, [], 'the origin is set when the engine starts, not before')
  assert.equal(provider.scaleMode(), 'responsive-unconfigured')
  engine.capture().onStart?.({ videoWidth: 640, videoHeight: 480 })
  assert.deepEqual(engine.projectionArgs, [{ origin: { x: 0, y: 1.4, z: 0 }, facing: { w: 1, x: 0, y: 0, z: 0 } }])
  assert.equal(engine.camera.position.y, 1.4)
  assert.deepEqual(scaleAnswers(provider), { kind: 'arbitrary', ready: false, mode: 'responsive-originY:1.4' })
  provider.stop()
  assert.equal(provider.scaleMode(), 'responsive-unconfigured')
})

test('8th Wall provider: without ?originY= the engine origin is never touched', async (t) => {
  captureConsole(t)
  for (const search of ['', '?scale=absolute', '?scale=absolute&originY=1.4']) {
    const { engine } = await startedProvider(search)
    engine.capture().onStart?.({ videoWidth: 640, videoHeight: 480 })
    assert.deepEqual(engine.projectionArgs, [], search)
  }
})

test('8th Wall provider: nothing depends on how high the phone started (y = 1.4 and y = 0 answer alike)', async (t) => {
  captureConsole(t)
  let now = 100
  t.mock.method(performance, 'now', () => now)
  for (const search of ['', '?scale=absolute', '?originY=1.4']) {
    const answers: unknown[] = []
    const stamps: unknown[] = []
    const flowStamps: unknown[] = []
    for (const startY of [1.4, 0]) {
      const { provider, engine } = await startedProvider(search)
      engine.capture().onStart?.({ videoWidth: 640, videoHeight: 480 })
      // A flow that measures a point while tracking is still LIMITED, then settles.
      feed(engine, 'LIMITED', startY)
      now += 10
      const flowStartedAt = now
      now += 10
      assert.ok(provider.hitTest(0.5, 0.5), 'the fake engine found a point')
      now += 10
      feed(engine, 'NORMAL', startY)
      feed(engine, 'NORMAL', startY + 0.02)
      assert.equal(provider.getPose().position.y, startY + 0.02, 'the two sessions really did start at different heights')
      answers.push(scaleAnswers(provider))
      stamps.push(stampScale(TWO_POINT, provider))
      flowStamps.push(stampScale(TWO_POINT, provider, flowStartedAt))
    }
    assert.deepEqual(answers[0], answers[1], `${search || 'default'}: the unit answers depend on the start height`)
    assert.deepEqual(stamps[0], stamps[1], `${search || 'default'}: the stamp depends on the start height`)
    assert.deepEqual(flowStamps[0], flowStamps[1], `${search || 'default'}: the stamp of a flow depends on the start height`)
  }
})

test('WebXR provider: metric by contract from the first frame, with nothing to wait for', () => {
  const provider = new WebXRProvider()
  assert.deepEqual(scaleAnswers(provider), { kind: 'metric', ready: true, mode: 'webxr-metric' })
  const asProvider: ARProvider = provider
  assert.equal(asProvider.scaleMode?.(0), 'webxr-metric', 'a flow start changes nothing for a unit that does not depend on tracking')
  assert.equal(asProvider.scaleKind?.(0), 'metric')
})

test('native provider: metric on the platform SDKs contract, with nothing to wait for', () => {
  const provider = new NativeARProvider(() => undefined)
  assert.deepEqual(scaleAnswers(provider), { kind: 'metric', ready: true, mode: 'native-metric' })
  const asProvider: ARProvider = provider
  assert.equal(asProvider.scaleMode?.(0), 'native-metric')
  assert.equal(asProvider.scaleKind?.(0), 'metric')
})

test('every provider derives its kind from its mode, so the two it stamps never disagree', async (t) => {
  captureConsole(t)
  const states: Array<{ scaleKind(): unknown; scaleMode(): unknown }> = [new WebXRProvider(), new NativeARProvider(() => undefined)]
  for (const search of ['', '?scale=responsive', '?scale=absolute', '?originY=1.4']) {
    for (const configure of ['records', 'missing'] as const) {
      for (const status of ['LIMITED', 'NORMAL']) {
        const { provider, engine } = await startedProvider(search, { configure })
        engine.capture().onStart?.({})
        feed(engine, status)
        states.push(provider)
      }
    }
  }
  const seen = new Set<unknown>()
  for (const provider of states) {
    const mode = asScaleMode(provider.scaleMode())
    assert.ok(mode, `${String(provider.scaleMode())} is not a mode the readers accept`)
    assert.equal(provider.scaleKind(), scaleKindOfMode(mode))
    seen.add(mode)
  }
  for (const mode of ['absolute-notapplied', 'absolute-notready', 'absolute-ready', 'responsive-originY:1.4', 'responsive-unconfigured', 'webxr-metric', 'native-metric']) {
    assert.ok(seen.has(mode), `${mode} was never reached, so this test did not check it`)
  }
})

// ─── stampScale ────────────────────────────────────────────────────────────

test('stampScale: writes the unit the provider reports onto a two-point and a one-point calibration', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=absolute')
  feed(engine, 'NORMAL')
  assert.deepEqual(stampScale(TWO_POINT, provider), { ...TWO_POINT, scaleMode: 'absolute-ready', scaleKind: 'estimated-metric' })
  assert.deepEqual(stampScale(ONE_POINT, provider), { ...ONE_POINT, scaleMode: 'absolute-ready', scaleKind: 'estimated-metric' })
  assert.deepEqual(stampScale(TWO_POINT, new WebXRProvider()), { ...TWO_POINT, scaleMode: 'webxr-metric', scaleKind: 'metric' })
})

test('stampScale: is taken when it is called, not when the session started', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=absolute')
  const before = stampScale(TWO_POINT, provider)
  feed(engine, 'NORMAL')
  const after = stampScale(TWO_POINT, provider)
  assert.equal(before.scaleMode, 'absolute-notready')
  assert.equal(before.scaleKind, 'arbitrary')
  assert.equal(after.scaleMode, 'absolute-ready')
  assert.equal(after.scaleKind, 'estimated-metric')
})

test('stampScale: hands the start of the calibration flow to the provider, for both the mode and the kind', () => {
  const asked: Array<[string, number | undefined]> = []
  const reporter = {
    scaleMode: (since?: number) => {
      asked.push(['mode', since])
      return since === 5 ? ('absolute-notready' as const) : ('absolute-ready' as const)
    },
    scaleKind: (since?: number) => {
      asked.push(['kind', since])
      return since === 5 ? ('arbitrary' as const) : ('estimated-metric' as const)
    },
  }
  assert.deepEqual(stampScale(TWO_POINT, reporter, 5), { ...TWO_POINT, scaleMode: 'absolute-notready', scaleKind: 'arbitrary' })
  assert.deepEqual(stampScale(TWO_POINT, reporter), { ...TWO_POINT, scaleMode: 'absolute-ready', scaleKind: 'estimated-metric' })
  assert.deepEqual(asked, [['mode', 5], ['kind', 5], ['mode', undefined], ['kind', undefined]])
  // The server's tier is not stamped, so the provider is not asked about it.
  asked.length = 0
  assert.equal(stampScale(KNOWN_DISTANCE, reporter, 5), KNOWN_DISTANCE)
  assert.deepEqual(asked, [])
})

test('stampScale: copies, so the calibration it was given is not changed', async (t) => {
  captureConsole(t)
  const { provider } = await startedProvider('')
  const input = structuredClone(TWO_POINT)
  const out = stampScale(input, provider)
  assert.notEqual(out, input)
  assert.deepEqual(input, TWO_POINT, 'the argument was mutated')
  assert.ok(!('scaleMode' in input) && !('scaleKind' in input))
  assert.equal(out.scaleMode, 'responsive-unconfigured')
  assert.equal(out.scaleKind, 'arbitrary')
})

test("stampScale: leaves the server's known-distance tier alone: its metre stick is a tape, not a runtime", () => {
  const out = stampScale(KNOWN_DISTANCE, new WebXRProvider())
  assert.equal(out, KNOWN_DISTANCE)
  assert.ok(!('scaleMode' in out) && !('scaleKind' in out))
})

test('stampScale: a provider that reports nothing leaves the calibration as it was, and one that reports half stamps half', () => {
  assert.equal(stampScale(TWO_POINT, {}), TWO_POINT)
  assert.deepEqual(stampScale(TWO_POINT, { scaleKind: () => 'arbitrary' }), { ...TWO_POINT, scaleKind: 'arbitrary' })
  assert.deepEqual(stampScale(TWO_POINT, { scaleMode: () => 'webxr-metric' }), { ...TWO_POINT, scaleMode: 'webxr-metric' })
})

test('stampScale: what it writes survives JSON, and is what the server readers accept', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?originY=1.4')
  engine.capture().onStart?.({})
  const stamped = stampScale(TWO_POINT, provider)
  const stored = JSON.parse(JSON.stringify(stamped)) as ScanCalibration
  assert.deepEqual(stored, stamped)
  assert.equal(asScaleMode(stored.scaleMode), 'responsive-originY:1.4')
})

test('stampScale: a record stored by the previous build, which has no unit, is read and stamped without trouble', async (t) => {
  captureConsole(t)
  // What IndexedDB held before this change: no scaleMode and no scaleKind, as JSON.
  const legacy = JSON.parse(JSON.stringify(TWO_POINT)) as ScanCalibration
  assert.ok(!('scaleMode' in legacy) && !('scaleKind' in legacy))
  const { provider } = await startedProvider('')
  const { scaleMode, scaleKind, ...rest } = stampScale(legacy, provider)
  assert.deepEqual(rest, legacy, 'stamping changed more than the two unit fields')
  assert.equal(scaleMode, 'responsive-unconfigured')
  assert.equal(scaleKind, 'arbitrary')
})

// ─── The scripted test engine ──────────────────────────────────────────────

/** Runs public/test-fixtures/xr8-mock.js, a classic script, against a stub page and returns its `XR8`. */
function loadMockEngine(search: string) {
  // The same window object the provider assigns THREE onto, which the mock's xrScene() reads.
  const context = vm.createContext({
    window: fakeWindow,
    document: { createElement: () => ({ getContext: () => null }) },
    location: { search },
    CustomEvent: class {
      type: string
      constructor(type: string) {
        this.type = type
      }
    },
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 1,
    clearInterval: () => undefined,
    URLSearchParams,
  })
  vm.runInContext(read('public/test-fixtures/xr8-mock.js'), context, { filename: 'xr8-mock.js' })
  return (fakeWindow as unknown as Record<string, unknown>)['XR8'] as MockEngine
}

interface MockEngine {
  configureCalls: Array<{ config: unknown; afterRun: boolean }>
  projectionCalls: Array<{ args: unknown; afterRun: boolean }>
  run(opts: { canvas: unknown }): void
  stop(): void
  XrController: { configure(config: unknown): void; updateCameraProjectionMatrix(args: unknown): void }
}

/**
 * What the mock recorded, copied into this realm. The script runs in its own vm context, so its arrays
 * are not instances of this realm's Array, and deepEqual compares prototypes.
 */
function recorded(xr8: MockEngine) {
  return {
    configure: JSON.parse(JSON.stringify(xr8.configureCalls)) as MockEngine['configureCalls'],
    projection: JSON.parse(JSON.stringify(xr8.projectionCalls)) as MockEngine['projectionCalls'],
  }
}

test('mock engine: has configure and updateCameraProjectionMatrix, which only record the calls', () => {
  const xr8 = loadMockEngine('')
  assert.equal(typeof xr8.XrController.configure, 'function')
  assert.equal(typeof xr8.XrController.updateCameraProjectionMatrix, 'function')
  assert.deepEqual(recorded(xr8), { configure: [], projection: [] })
  xr8.XrController.configure({ scale: 'absolute' })
  xr8.XrController.updateCameraProjectionMatrix({ origin: { x: 0, y: 1.4, z: 0 } })
  assert.deepEqual(recorded(xr8), {
    configure: [{ config: { scale: 'absolute' }, afterRun: false }],
    projection: [{ args: { origin: { x: 0, y: 1.4, z: 0 } }, afterRun: false }],
  })
})

test('mock engine: says whether a configure call came after run(), and forgets that on stop()', () => {
  const xr8 = loadMockEngine('')
  xr8.run({ canvas: {} })
  xr8.XrController.configure({ scale: 'absolute' })
  xr8.stop()
  xr8.XrController.configure({ scale: 'absolute' })
  assert.deepEqual(recorded(xr8).configure.map((c) => c.afterRun), [true, false])
})

test('mock engine: the provider configures it before it runs, on both starts, and the origin arm reaches it', async (t) => {
  captureConsole(t)
  fakeWindow.location.search = '?scale=absolute'
  const xr8 = loadMockEngine('?scale=absolute')
  ;(globalThis as { XR8?: unknown }).XR8 = xr8
  const provider = new EighthWallProvider()
  await provider.start(canvasStub())
  provider.stop()
  await provider.start(canvasStub())
  assert.deepEqual(recorded(xr8).configure, [
    { config: { scale: 'absolute' }, afterRun: false },
    { config: { scale: 'absolute' }, afterRun: false },
  ])
  assert.deepEqual(recorded(xr8).projection, [], 'no ?originY= was given')
  provider.stop()

  fakeWindow.location.search = '?originY=1.5'
  const second = loadMockEngine('?originY=1.5')
  ;(globalThis as { XR8?: unknown }).XR8 = second
  const arm = new EighthWallProvider()
  await arm.start(canvasStub())
  const projection = recorded(second).projection
  assert.equal(projection.length, 1)
  assert.deepEqual((projection[0].args as { origin: unknown }).origin, { x: 0, y: 1.5, z: 0 })
  assert.equal(arm.scaleMode(), 'responsive-originY:1.5')
  assert.deepEqual(recorded(second).configure, [], 'the origin arm is the default scale, which is not sent to the engine')
  arm.stop()
})

test('mock engine: a default page makes no configure or origin call, so the scripted engine is driven as it always was', async (t) => {
  captureConsole(t)
  fakeWindow.location.search = ''
  const xr8 = loadMockEngine('')
  ;(globalThis as { XR8?: unknown }).XR8 = xr8
  const provider = new EighthWallProvider()
  await provider.start(canvasStub())
  provider.stop()
  await provider.start(canvasStub())
  assert.deepEqual(recorded(xr8), { configure: [], projection: [] })
  assert.equal(provider.scaleMode(), 'responsive-unconfigured')
  provider.stop()
})

// ─── Where the unit is written: main.ts, the sidecar, the GLB ──────────────

test('source shape: main.ts stamps the calibration result with the provider unit where it reaches the scanner', () => {
  const main = read('src/main.ts')
  assert.match(main, /import \{ stampScale \} from '\.\/ar\/engine-config'/)
  assert.match(
    main,
    /sessionCalibration = stampScale\(calibration\.calibration, provider, calibrationStartedAt\)/,
    'main.ts no longer stamps the unit onto the calibration result',
  )
  assert.doesNotMatch(main, /sessionCalibration = calibration\.calibration\b/, 'the unstamped assignment is back')
  // `sessionCalibration = undefined` clears it for a new session; any other assignment would have to stamp too.
  assert.equal(main.match(/sessionCalibration = (?!undefined)/g)?.length, 1, 'a second assignment to sessionCalibration may skip the stamp')
})

test('source shape: the stamp is made for every calibration the flow returns, not only when the Place frame changed', () => {
  const main = read('src/main.ts')
  const flow = main.indexOf('const calibration = await runProjectCalibration(')
  const gate = main.indexOf('if (calibration) {', flow)
  const frameChanged = main.indexOf('if (calibration.spatialFrame) {', gate)
  const stamp = main.indexOf('sessionCalibration = stampScale(', gate)
  assert.ok(flow > 0 && gate > flow && frameChanged > gate && stamp > gate, 'main.ts no longer has the shape this test reads')
  // A return visit that only verified a stored frame returns a calibration and no `spatialFrame`. If the stamp
  // moved under that condition, or under any other block, those scans would carry no unit.
  assert.ok(stamp < frameChanged, 'the stamp comes after the check on the Place frame')
  assert.doesNotMatch(main.slice(gate + 'if (calibration) {'.length, stamp), /[{}]/, 'the stamp is nested inside another block')
})

test('source shape: the flow start is read once, after the scanner starts and before the calibration flow runs', () => {
  const main = read('src/main.ts')
  const reading = 'const calibrationStartedAt = performance.now()'
  assert.equal(main.split(reading).length, 2, 'the flow start must be read exactly once')
  const started = main.indexOf("console.log('[main] Room scanner started')")
  const flow = main.indexOf('const calibration = await runProjectCalibration(')
  assert.ok(started > 0 && main.indexOf(reading) > started && main.indexOf(reading) < flow, 'the flow start is read outside the span before the flow')
})

test('source shape: eighthwall.ts configures through engine-config.ts and never calls the engine scale API directly', () => {
  const source = read('src/ar/eighthwall.ts')
  assert.match(source, /this\._engineScale\.configure\(XR8, window\.location\.search\)/)
  assert.doesNotMatch(source, /XrController\.configure\(/, 'the engine is configured only through engine-config.ts')
})

test('source shape: nothing in the 8th Wall provider or engine-config calls recenter() or asks a hit test for a type other than FEATURE_POINT', () => {
  for (const path of ['src/ar/eighthwall.ts', 'src/ar/engine-config.ts']) {
    const source = read(path)
    assert.doesNotMatch(source, /\.recenter\(/, `${path}: recenter() moves the origin of a running session`)
    // The ?hittypes= opt-in (the DX5 experiment arm) is the one place the surface types are named: its list of
    // names the engine knows and its documentation. Everything else stays on FEATURE_POINT.
    const outsideOptIn = source
      .split('\n')
      .filter((line) => !line.includes('ENGINE_HIT_TYPES: readonly string[]') && !line.includes('?hittypes='))
      .join('\n')
    assert.doesNotMatch(outsideOptIn, /ESTIMATED_SURFACE|DETECTED_SURFACE/, `${path}: hit tests stay on FEATURE_POINT`)
  }
})

// ─── The sidecar and the GLB ───────────────────────────────────────────────

class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null
  onerror: ((err: unknown) => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = buf
        this.onloadend?.()
      },
      (err) => this.onerror?.(err),
    )
  }
}
;(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader

let lastGlb: Uint8Array | null = null
let lastMetadata: Record<string, unknown> | null = null
;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init?: RequestInit) => {
  const body = init?.body as FormData | undefined
  const file = body?.get('file')
  if (file instanceof Blob) lastGlb = new Uint8Array(await file.arrayBuffer())
  const metadata = body?.get('metadata')
  if (typeof metadata === 'string') lastMetadata = JSON.parse(metadata) as Record<string, unknown>
  return new Response(JSON.stringify({ filename: 'stored.glb' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pointCloudStub(): PointCloud {
  const positions = new Float32Array([0, 0, 0, 0.1, 0.05, -0.1])
  return {
    count: 2,
    toFloat32Array: () => positions,
    boundingBox: () => ({ min: { x: 0, y: 0, z: -0.1 }, max: { x: 0.1, y: 0.05, z: 0 } }),
    estimateFloorY: () => 0,
  } as unknown as PointCloud
}

/** Exports one scan carrying `calibration`, and returns what the upload and the GLB said about it. */
async function exportWith(calibration: ScanCalibration | undefined) {
  const scanEntry: ScanEntry = {
    scanId: 'scan-1',
    projectId: 'place-1',
    sessionId: 'sess-wp06',
    name: 'wp06 scan',
    status: 'draft',
    capturedAt: Date.now(),
    calibration,
  }
  const store = { sessionId: 'sess-wp06', detections: new Map(), currentRunDetections: () => new Map(), serverSessionOfThisRun: null } as unknown as DetectionStore
  lastGlb = null
  lastMetadata = null
  await exportToGLB(
    { store, pointCloud: pointCloudStub(), poseHistory: [], scanEntry },
    { download: false, upload: true },
  )
  const glb = lastGlb as Uint8Array | null
  const metadata = lastMetadata as Record<string, unknown> | null
  assert.ok(glb && metadata, 'the export did not reach the upload path')
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true)))) as {
    scenes?: Array<{ extras?: Record<string, unknown> }>
  }
  return { metadata, sceneExtras: json.scenes?.[0]?.extras ?? {} }
}

test('sidecar: the unit is written flat beside the tier, and the whole record carries it too', async () => {
  const calibration: ScanCalibration = { ...TWO_POINT, scaleMode: 'absolute-ready', scaleKind: 'estimated-metric' }
  const { metadata } = await exportWith(calibration)
  assert.equal(metadata['scaleMode'], 'absolute-ready')
  assert.equal(metadata['scaleKind'], 'estimated-metric')
  assert.equal(metadata['calibrationMethod'], 'two-point-ground', 'the existing flat keys are unchanged')
  assert.equal(metadata['calibrationStatus'], 'verified')
  assert.deepEqual(metadata['calibration'], calibration)
})

test('sidecar: the GLB scene extras carry the unit inside the calibration record', async () => {
  const calibration: ScanCalibration = { ...ONE_POINT, scaleMode: 'responsive-originY:1.4', scaleKind: 'arbitrary' }
  const { sceneExtras } = await exportWith(calibration)
  assert.deepEqual(sceneExtras['calibration'], calibration)
})

test('sidecar: a record from the previous build, with no unit, writes null keys and an unchanged record', async () => {
  const { metadata, sceneExtras } = await exportWith(TWO_POINT)
  assert.equal(metadata['scaleMode'], null)
  assert.equal(metadata['scaleKind'], null)
  assert.deepEqual(metadata['calibration'], TWO_POINT, 'the writer must not invent a unit for a record that has none')
  assert.ok(!('scaleMode' in (metadata['calibration'] as object)))
  assert.deepEqual(sceneExtras['calibration'], TWO_POINT)
})

test('sidecar: a scan that never calibrated has no unit, and still says it is uncalibrated', async () => {
  const { metadata } = await exportWith(undefined)
  assert.equal(metadata['scaleMode'], null)
  assert.equal(metadata['scaleKind'], null)
  assert.equal(metadata['calibration'], null)
  assert.equal(metadata['calibrationStatus'], 'uncalibrated')
})

test('sidecar: a calibration the scanner stamped is the one that is uploaded', async (t) => {
  captureConsole(t)
  const { provider, engine } = await startedProvider('?scale=absolute')
  feed(engine, 'NORMAL')
  const { metadata } = await exportWith(stampScale(TWO_POINT, provider))
  assert.equal(metadata['scaleMode'], 'absolute-ready')
  assert.equal(metadata['scaleKind'], 'estimated-metric')
})
