/**
 * A rig for the re-anchor flow (WP-09b): a fake AR provider that moves through frame epochs, the real epoch log over it,
 * the real flow, and a view and a host that record what was done to them.
 *
 * The host's `beginScan` and `calibrate` do what src/main.ts's wiring does to the epoch log (reset it, forget the old
 * calibration, note the new one), because the flow reads its state back from there; tests/unit/node/wp-09b-wiring.test.ts
 * holds main.ts to doing those things, and tests/unit/node/wp-09b-reanchor-host.test.ts runs them against the real store.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import { ScanFrameEpochLog, type FrameDiscontinuity, type FrameDiscontinuityCause } from '../../../../src/ar/frame-epoch.ts'
import {
  ReanchorFlow,
  type FinishOutcome,
  type Prompt,
  type ReanchorHost,
  type ReanchorOptions,
  type ReanchorView,
} from '../../../../src/ar/reanchor-flow.ts'
import type { TapResult } from '../../../../src/ar/tap-sampling.ts'
import { twoPointToProjectTransform } from '../../../../src/world/geo.ts'
import type { ProjectSpatialFrame, ScanCalibration, Vec3 } from '../../../../src/world/types.ts'

/** A provider that has an epoch and tells the app when it goes up, and nothing else. */
export class FakeProvider {
  epoch = 0
  private listeners = new Set<(event: FrameDiscontinuity) => void>()
  private clockMs = 1_000
  getFrameEpoch(): number {
    return this.epoch
  }
  onFrameDiscontinuity(cb: (event: FrameDiscontinuity) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  /** The runtime moves to its next epoch, and says so. */
  discontinuity(cause: FrameDiscontinuityCause = 'jump', extra: Partial<FrameDiscontinuity> = {}): FrameDiscontinuity {
    this.epoch++
    this.clockMs += 2_000
    const event: FrameDiscontinuity = { epoch: this.epoch, cause, atMs: this.clockMs, ...extra }
    for (const cb of [...this.listeners]) cb(event)
    return event
  }
  /** The runtime reports the epoch it is already in again, with more in it (a reset after a resume). */
  amend(extra: Partial<FrameDiscontinuity> = {}): void {
    const event: FrameDiscontinuity = { epoch: this.epoch, cause: 'reset', atMs: this.clockMs, ...extra }
    for (const cb of [...this.listeners]) cb(event)
  }
  get listenerCount(): number {
    return this.listeners.size
  }
}

export interface PromptAt {
  prompt: Prompt
  /** What the check button was when it was shown. */
  checkVisible: boolean
}

/** A view that keeps every prompt it was asked to show and can press their buttons. */
export class FakeView implements ReanchorView {
  shown: Prompt[] = []
  current: Prompt | null = null
  hides = 0
  checkVisible = false
  handlers: { check(): void; tap(x: number, y: number): void } | null = null
  showPrompt(prompt: Prompt): void {
    this.shown.push(prompt)
    this.current = prompt
  }
  hidePrompt(): void {
    this.current = null
    this.hides++
  }
  setCheckButton(state: { visible: boolean }): void {
    this.checkVisible = state.visible
  }
  bind(handlers: { check(): void; tap(x: number, y: number): void }): void {
    this.handlers = handlers
  }
  /** The labels of the buttons on the prompt now showing, in order. */
  get labels(): string[] {
    return this.current?.actions.map((action) => action.label) ?? []
  }
  get kind(): string | null {
    return this.current?.kind ?? null
  }
  press(id: string): void {
    const action = this.current?.actions.find((candidate) => candidate.id === id)
    if (!action) throw new Error(`no button "${id}" on ${JSON.stringify(this.current)}`)
    action.run()
  }
}

/** The calibration a scan carries after a two-point flow with the landmark at the origin and the marker on +Z. */
export function twoPointCalibration(over: Partial<Extract<ScanCalibration, { method: 'two-point-ground' }>> = {}): ScanCalibration {
  const separationM = over.separationM ?? 3
  return {
    method: 'two-point-ground',
    sessionToProject: twoPointToProjectTransform({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: separationM }),
    separationM,
    residualM: 0,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    calibratedAt: '2026-11-17T09:00:00.000Z',
    status: 'provisional',
    ...over,
  } as ScanCalibration
}

export function onePointCalibration(): ScanCalibration {
  return {
    method: 'ground-tap-compass',
    sessionToProject: twoPointToProjectTransform({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    anchorBearingDeg: 12,
    bearingConvention: 2,
    calibratedAt: '2026-11-17T09:00:00.000Z',
    status: 'provisional',
  }
}

export function twoPointFrame(over: Record<string, unknown> = {}): ProjectSpatialFrame {
  // The heading marker sits `separationM` from the landmark unless a test says otherwise, as it does in every record the
  // calibration writes: the saved points and the saved length are one fact, and the copy reads the points.
  const length = typeof over.separationM === 'number' && Number.isFinite(over.separationM) && over.separationM > 0 ? over.separationM : 3
  return {
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    method: 'two-point-ground',
    landmark: { x: 0, y: 0, z: 0 },
    headingMarker: { x: 0, y: 0, z: length },
    separationM: 3,
    toleranceM: 0.15,
    anchorBearingDeg: null,
    ...over,
  } as ProjectSpatialFrame
}

export function onePointFrame(): ProjectSpatialFrame {
  return { version: 1, createdAt: '2026-11-01T00:00:00.000Z', method: 'ground-tap-compass', anchorBearingDeg: 12 }
}

/** A tap that passed, where `sampleTap` would put it. */
export function tapAt(position: Vec3, over: Partial<Extract<TapResult, { ok: true }>> = {}): TapResult {
  return { ok: true, position, rangeM: 2.4, spreadM: 0.012, n: 9, rejected: 1, source: 'burst', ...over }
}

export interface HostState {
  frame: ProjectSpatialFrame | null
  calibration: ScanCalibration | undefined
  poses: Array<{ position: Vec3 }>
  /** What finishScan answers, in order; the last one repeats. */
  finishes: Array<FinishOutcome | 'throw'>
  /** What calibrate makes: a calibration, or null for a flow the person skipped; the last repeats. */
  calibrations: Array<ScanCalibration | null | 'throw'>
  /** What each tap read answers, in order. */
  taps: TapResult[]
  beginThrows: boolean
  said: string[]
  /** Every call the host got, in order, with its arguments where they matter. */
  calls: string[]
  readTaps: Array<[number, number]>
  runIds: Array<string | undefined>
  /** Whether recording was held at each step of the sequence. */
  heldAt: Record<string, boolean>
  /** The kind of prompt on screen as each step of the sequence began, or null for none. */
  shownAt: Record<string, string | null>
  /** How many interruptions the flow was holding back from the verdict as each step began. */
  heldShiftsAt: Record<string, number>
}

export interface Rig {
  provider: FakeProvider
  log: ScanFrameEpochLog
  view: FakeView
  host: ReanchorHost
  state: HostState
  flow: ReanchorFlow
  /** Make the scan calibrated, in the epoch the provider is in now, and arm the flow: what src/main.ts does after the calibration. */
  calibrateAndArm(calibration?: ScanCalibration): void
}

export interface RigOptions {
  frame?: ProjectSpatialFrame | null
  autosplit?: boolean
  runId?: string | null
  state?: Partial<HostState>
  /** How long saving the scan may take before the choice comes back; the flow's own default when absent. */
  finishLimitMs?: number
}

export function rig(options: RigOptions = {}): Rig {
  const provider = new FakeProvider()
  const log = new ScanFrameEpochLog()
  log.attach(provider)
  const view = new FakeView()
  const state: HostState = {
    frame: options.frame === undefined ? twoPointFrame() : options.frame,
    calibration: undefined,
    poses: [],
    finishes: ['uploaded'],
    calibrations: [twoPointCalibration()],
    taps: [],
    beginThrows: false,
    said: [],
    calls: [],
    readTaps: [],
    runIds: [],
    heldAt: {},
    shownAt: {},
    heldShiftsAt: {},
    ...options.state,
  }
  let flow: ReanchorFlow
  const next = <T>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!)
  const host: ReanchorHost = {
    storedFrame: () => state.frame,
    calibration: () => state.calibration,
    poses: () => state.poses,
    readTap: async (x, y) => {
      state.calls.push('readTap')
      state.readTaps.push([x, y])
      const tap = state.taps.shift()
      if (!tap) throw new Error('the rig has no tap to answer with')
      return tap
    },
    finishScan: async () => {
      state.calls.push('finishScan')
      state.heldAt['finishScan'] = flow.recordingHeld
      state.shownAt['finishScan'] = view.kind
      state.heldShiftsAt['finishScan'] = flow.heldShifts
      const outcome = next(state.finishes)
      if (outcome === 'throw') throw new Error('the export threw')
      return outcome
    },
    beginScan: async (arRunId, epoch) => {
      state.calls.push(`beginScan:${epoch}`)
      state.runIds.push(arRunId)
      state.heldAt['beginScan'] = flow.recordingHeld
      state.shownAt['beginScan'] = view.kind
      state.heldShiftsAt['beginScan'] = flow.heldShifts
      if (state.beginThrows) throw new Error('the store refused')
      // What src/main.ts does to the epoch log and the calibration for a new scan.
      log.reset()
      log.forgetCalibration()
      state.calibration = undefined
      state.poses.length = 0
    },
    calibrate: async () => {
      state.calls.push('calibrate')
      state.heldAt['calibrate'] = flow.recordingHeld
      state.shownAt['calibrate'] = view.kind
      state.heldShiftsAt['calibrate'] = flow.heldShifts
      const made = next(state.calibrations)
      if (made === 'throw') throw new Error('the calibration threw')
      if (made === null) return false
      state.calibration = made
      log.noteCalibrated(log.currentEpoch)
      return true
    },
    say: (text) => {
      state.said.push(text)
    },
  }
  const flowOptions: ReanchorOptions = {
    view,
    host,
    epochs: log,
    arRunId: () => (options.runId === undefined ? 'run-a' : options.runId),
    ...(options.autosplit ? { autosplit: true } : {}),
    ...(options.finishLimitMs === undefined ? {} : { finishLimitMs: options.finishLimitMs }),
    now: () => new Date('2026-11-17T09:30:00.000Z'),
  }
  flow = new ReanchorFlow(flowOptions)
  flow.attach(provider)
  return {
    provider,
    log,
    view,
    host,
    state,
    flow,
    calibrateAndArm(calibration = twoPointCalibration()) {
      state.calibration = calibration
      log.noteCalibrated(log.currentEpoch)
      flow.arm()
    },
  }
}

/** Lets every promise the flow started settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Waits until `condition` holds, in timer ticks: for a flow that runs against the real scan store, whose database (the
 * fake one included) answers on timers, which `settle()`'s immediates do not wait for.
 */
export async function waitFor(condition: () => boolean, what: string, limitMs = 5_000): Promise<void> {
  const until = Date.now() + limitMs
  while (!condition()) {
    if (Date.now() > until) throw new Error(`gave up waiting for ${what}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}
