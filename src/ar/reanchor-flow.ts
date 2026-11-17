/**
 * One scan, one frame: what the scanner does when the runtime's frame may have moved under a scan that was
 * calibrated against a Place (WP-09b, device experiment DX4).
 *
 * An AR runtime promises one rigid frame only while its tracking holds (src/ar/frame-epoch.ts). A scan that was
 * calibrated at epoch N and goes on recording after the runtime has moved to epoch N+1 has geometry in two frames,
 * and the one calibration it carries is right for at most one of them. This file is the flow around that, as a state
 * machine with no DOM and no AR runtime: the view, the host (everything that belongs to main.ts) and the epoch log
 * are handed in, so the decisions are tested without a phone.
 *
 * ## The rule (owner decision D13)
 *
 * Warn and mark the scan for review, never split it on its own. When a discontinuity arrives after the calibration
 * and the Place has a two-point frame, the scan stops recording and the person chooses:
 *
 *  - **Re-anchor here** ends this scan (it is saved through the export it already has and keeps the calibration it
 *    was made with) and begins another in the epoch the runtime is in now. The new scan is set against the Place's
 *    saved points by the same return-visit flow any later visit uses, so the server needs no new matrix logic: each
 *    scan is one rigid frame, and a scan that lives in one epoch is one scan.
 *  - **Keep going** records on into the same scan. It stays marked for review, because its geometry may be in two
 *    frames, which the quality verdict already says (frameShifts above zero is never 'ready').
 *
 * With no two-point frame to re-anchor against, the scan keeps recording and is told so (a status line, no choice to
 * make). `?autosplit=1` ends the scan at once without asking: for the device experiment that counts how often shifts
 * happen, never the default.
 *
 * ## What "recording held" means
 *
 * While the choice is open, and while the scan is being saved, nothing is added to it: not points, not poses, not
 * captures, not keyframes (`recordingHeld`). That is what keeps the finished scan in one epoch. The discontinuities
 * that arrived while it was held are counted (`heldShifts`) so the quality verdict does not call a scan shifted for
 * an interruption after which nothing was recorded; they count again if the person chooses to keep going, because
 * from then on the scan does hold geometry from either side of them. The person is told it is held (`heldHint`, for
 * the HUD, and the prompt's own words), because the HUD's "Not recording" follows the runtime's tracking and not this.
 *
 * Saving the scan has a limit (`FINISH_LIMIT_MS`). An upload that never answers would otherwise hold recording for as
 * long as the browser waits, with a banner that has no button. Past the limit the choice comes back with its own words
 * and nothing is ended; a save that does finish late is not waited for again.
 *
 * ## Checking drift
 *
 * The same flow answers a question that needs no discontinuity: how far has this scan moved from where it was set?
 * The person taps the landmark again (and the heading marker), `sampleTap` reads each tap, and src/ar/closure.ts turns
 * them into a closure that is kept with the scan (`frameEpochs.closures`). Over its limits it proposes the re-anchor.
 * This is the instrument for the device experiment's table of error against distance walked. A discontinuity that
 * arrives while a check is open ends the check: its taps would be in two frames, which is the thing it measures, and the
 * person is asked what to do about the interruption as at any other time, with recording held.
 *
 * ## What this file does not decide
 *
 * Whether a frame moved (nothing made of taps can say), what the words are (./reanchor-copy.ts), how anything is
 * drawn (./reanchor-banner.ts) or how a scan is saved and begun (src/main.ts, through the host). Re-anchoring against
 * a frame of two taps inherits that frame's error, and the prompt says so.
 */
import type { ProjectSpatialFrame, ScanCalibration, Vec3 } from '../world/types.ts'
import { arRunIdAtEpoch } from '../shared/ar-run-id.ts'
import { closureRecord, measureClosure, pathLengthM, type ClosureTap, type FrameClosureRecord } from './closure.ts'
import type { FrameDiscontinuity, FrameEpochSource } from './frame-epoch.ts'
import * as copy from './reanchor-copy.ts'
import type { TapRefusal, TapResult, TapSample } from './tap-sampling.ts'

/**
 * How long saving the scan may take before the person gets the choice back, in milliseconds.
 *
 * Adopted, not measured (ADR 0005 rule 5). The upload is a bare request with no limit of its own, and an upload of a
 * scan of some megabytes over a phone's connection takes seconds; a minute is about ten times that. Too short, and a
 * slow upload that was going to finish is called failed while it goes on, and the person who presses Re-anchor again
 * saves the same scan twice; too long, and recording stays held for it. Replace it with the upload times DX4's walks
 * record.
 */
export const FINISH_LIMIT_MS = 60_000

// ── What the flow is given ──────────────────────────────────────────────────

export interface PromptAction {
  id: string
  label: string
  /** The choice the person is most likely to want: drawn as the primary button. */
  primary?: boolean
  run(): void
}

export type PromptKind =
  | 'interruption'
  | 'save-failed'
  | 'saving'
  | 'tap-landmark'
  | 'tap-heading'
  | 'closure'
  | 'suggest'

export interface Prompt {
  kind: PromptKind
  text: string
  detail?: string
  actions: PromptAction[]
  /** True while a tap is being read: the prompt stays and its buttons wait. */
  busy?: boolean
}

/** What the flow draws with and listens through. The DOM one is ./reanchor-banner.ts. */
export interface ReanchorView {
  /** Show a prompt, replacing whatever was showing. */
  showPrompt(prompt: Prompt): void
  hidePrompt(): void
  /** Show or hide the Check drift control. */
  setCheckButton(state: { visible: boolean }): void
  /** Where the person's presses and canvas taps arrive. Called once, by the flow, as it is made. */
  bind(handlers: { check(): void; tap(x: number, y: number): void }): void
}

/** What became of saving the scan so far. 'failed' means nothing was ended and nothing was lost. */
export type FinishOutcome = 'uploaded' | 'queued' | 'empty' | 'failed'

/** Everything that belongs to the page and not to the flow. */
export interface ReanchorHost {
  /** The Place's saved frame, or none. */
  storedFrame(): ProjectSpatialFrame | null | undefined
  /** The calibration the scan being recorded carries, or undefined when it has none. */
  calibration(): ScanCalibration | undefined
  /** The scan's camera path so far: the page's pose history. */
  poses(): ReadonlyArray<{ position: Vec3 }>
  /** Read one floor tap at normalised canvas coordinates (`sampleTap`, ./tap-sampling.ts). */
  readTap(x: number, y: number): Promise<TapResult>
  /** Save the scan so far through the export it already has. */
  finishScan(): Promise<FinishOutcome>
  /**
   * Begin the next scan in the epoch the runtime is in now: a new session and a new store record, with `arRunId` (the
   * run's id with the epoch appended, or undefined to take a fresh one) stamped on what the new scan stores, the point
   * cloud and pose trail emptied, no calibration carried over, recording on again.
   */
  beginScan(arRunId: string | undefined, epoch: number): Promise<void>
  /** Run the Place calibration for the scan just begun. Resolves true when it made one. */
  calibrate(): Promise<boolean>
  /** Write a line to the status line. */
  say(text: string): void
}

/** The part of `ScanFrameEpochLog` (./frame-epoch.ts) the flow reads and writes. */
export interface EpochLogPort {
  readonly currentEpoch: number
  /** The epoch the scan's Place calibration was made in, or null when it has none. */
  readonly calibrationEpoch: number | null
  readonly frameShifts: number
  hasDiscontinuitySince(epoch: number): boolean
  noteClosure(record: FrameClosureRecord): void
}

export interface ReanchorOptions {
  view: ReanchorView
  host: ReanchorHost
  epochs: EpochLogPort
  /** The AR run id the scan store is in, to append the new epoch to. Null before AR has started. */
  arRunId(): string | null
  /** `?autosplit=1`: end the scan at once, without asking. For device experiment DX4 only. */
  autosplit?: boolean
  /** How long saving the scan may take before the choice comes back. Default `FINISH_LIMIT_MS`. */
  finishLimitMs?: number
  now?(): Date
}

export type ReanchorOutcome =
  | { ok: true; calibrated: boolean; epoch: number }
  | { ok: false; reason: 'busy' | 'save-failed' | 'save-timed-out' | 'error' }

/**
 * Where the flow is.
 *
 *  `off`          the scan has no calibration, so there is nothing to re-anchor and nothing to check
 *  `watching`     calibrated, recording, waiting for a discontinuity or a check
 *  `prompting`    a choice is open: recording is held
 *  `finishing`    saving the scan before ending it: recording is held
 *  `calibrating`  the next scan has begun and its calibration is running: recording is on, events are the new scan's
 *  `checking`     the person is checking drift: recording is on
 */
export type ReanchorPhase = 'off' | 'watching' | 'prompting' | 'finishing' | 'calibrating' | 'checking'

/** Whether a Place's frame is one a re-anchor can be measured against: only a pair can be tapped again and compared. */
export function canReanchor(frame: ProjectSpatialFrame | null | undefined): boolean {
  return frame?.method === 'two-point-ground'
}

/** Whether the page asked for the scan to be ended at once, without a choice: `?autosplit=1`. Nothing else turns it on. */
export function autosplitRequested(search: string): boolean {
  try {
    return new URLSearchParams(search).get('autosplit') === '1'
  } catch {
    return false
  }
}

type CheckStep = 'landmark' | 'heading' | 'result'

interface Check {
  step: CheckStep
  landmark: TapSample | null
  busy: boolean
}

export class ReanchorFlow {
  private readonly view: ReanchorView
  private readonly host: ReanchorHost
  private readonly epochs: EpochLogPort
  private readonly runId: () => string | null
  private readonly autosplit: boolean
  private readonly finishLimitMs: number
  private readonly now: () => Date

  private _phase: ReanchorPhase = 'off'
  /** The epoch the scan's calibration was made in. */
  private _calibrated = 0
  /** The epoch the person chose to keep going through, or was told of, for this scan. A Clear forgets it: the next scan is another. So does a new calibration. */
  private _kept: number | null = null
  private _heldShifts = 0
  /** The pose trail's length when the calibration was made, so the path since is measured from there. */
  private _poseMark = 0
  private _lastEventEpoch = -1
  private _unsubscribe: (() => void) | null = null
  private _check: Check | null = null

  constructor(options: ReanchorOptions) {
    this.view = options.view
    this.host = options.host
    this.epochs = options.epochs
    this.runId = options.arRunId
    this.autosplit = options.autosplit === true
    this.finishLimitMs = options.finishLimitMs ?? FINISH_LIMIT_MS
    this.now = options.now ?? (() => new Date())
    this.view.bind({
      check: () => this.startCheck(),
      tap: (x, y) => void this.acceptTap(x, y),
    })
  }

  get phase(): ReanchorPhase {
    return this._phase
  }

  /**
   * True while nothing may be added to the scan: a choice is open, or the scan is being saved. The scanner, the
   * capture and the keyframe stream ask it before they record.
   */
  get recordingHeld(): boolean {
    return this._phase === 'prompting' || this._phase === 'finishing'
  }

  /**
   * What the HUD says while recording is held, or null when it is not: that recording is paused, and what the person
   * can do about it. The HUD's own "Not recording" line follows the runtime's tracking, which has usually recovered by
   * the time the choice is open, so it would otherwise say nothing while nothing was being recorded.
   */
  get heldHint(): string | null {
    if (this._phase === 'prompting') return copy.RECORDING_HELD_HINT
    if (this._phase === 'finishing') return copy.RECORDING_SAVING_HINT
    return null
  }

  /**
   * How many discontinuities arrived while recording was held, so no geometry came after them: the quality verdict
   * subtracts them from the scan's frame shifts (src/main.ts), and they count again when recording goes on.
   */
  get heldShifts(): number {
    return this._heldShifts
  }

  /** Listen for discontinuities. Call before the AR session starts, as the epoch log is attached, so none is missed. */
  attach(source: FrameEpochSource): void {
    this._unsubscribe?.()
    this._unsubscribe = source.onFrameDiscontinuity?.((event) => this.onDiscontinuity(event)) ?? null
  }

  /** Stop listening and take the prompt down. */
  dispose(): void {
    this._unsubscribe?.()
    this._unsubscribe = null
    this.view.hidePrompt()
    this.view.setCheckButton({ visible: false })
  }

  // ── Arming ────────────────────────────────────────────────────────────────

  /**
   * The scan was calibrated against the Place: watch for the runtime moving on from the epoch the calibration was
   * made in. A shift that came while the calibration was running already counts, and is put to the person at once: its
   * points were set across it. When the Place's saved points are the ones this very calibration set, the person is told
   * only (`prompt`). A scan with no calibration, or one the epoch log does not hold an epoch for, is not armed.
   */
  arm(): void {
    const calibrationEpoch = this.epochs.calibrationEpoch
    if (calibrationEpoch === null || !this.host.calibration()) {
      this.disarm()
      return
    }
    this._calibrated = calibrationEpoch
    this._kept = null
    this._heldShifts = 0
    this._poseMark = this.host.poses().length
    this._check = null
    this._phase = 'watching'
    this.view.hidePrompt()
    this.refreshButton()
    if (this.epochs.hasDiscontinuitySince(this.baseline)) this.prompt(false, true)
  }

  /**
   * A discontinuity prompts only when the runtime is past this epoch: the one the person kept going through, or else the
   * one the calibration was made in. What was kept through came after the calibration, so it is never the earlier of
   * the two, and arming and a Clear both forget it.
   */
  private get baseline(): number {
    return this._kept ?? this._calibrated
  }

  /** The scan has no calibration to be moved from: nothing is watched and nothing is offered. */
  disarm(): void {
    this._phase = 'off'
    this._heldShifts = 0
    this._check = null
    this.view.hidePrompt()
    this.refreshButton()
  }

  /**
   * The scan was emptied (a Clear, or another scan loaded) and its calibration kept. What was open is closed and the
   * path is counted from the empty trail. A discontinuity since the calibration is put to the person again, because the
   * next scan is in a frame the calibration was not made in. Does nothing while a re-anchor is running its own reset.
   */
  noteScanReset(): void {
    if (this._phase === 'off' || this._phase === 'finishing' || this._phase === 'calibrating') return
    this._heldShifts = 0
    this._kept = null
    this._check = null
    this._poseMark = 0
    this._phase = 'watching'
    this.view.hidePrompt()
    this.refreshButton()
    if (this.epochs.hasDiscontinuitySince(this.baseline)) this.prompt(false)
  }

  // ── A discontinuity ───────────────────────────────────────────────────────

  private onDiscontinuity(event: FrameDiscontinuity): void {
    // The tracker may report an epoch it already reported, with more in it (a reset after a resume): not a new one.
    if (!(event.epoch > this._lastEventEpoch)) return
    this._lastEventEpoch = event.epoch
    switch (this._phase) {
      case 'watching':
        if (this.epochs.hasDiscontinuitySince(this.baseline)) this.prompt(true)
        return
      case 'prompting':
        this._heldShifts++
        this.showInterruptionPrompt()
        return
      case 'finishing':
        this._heldShifts++
        return
      case 'checking':
        // The check's taps would be in two frames, which is what it measures: it is over, and the interruption is put to
        // the person as it would be at any other time, with recording held from here. A tap that is still being read is
        // dropped (`acceptTap` finds the check gone).
        if (!this.epochs.hasDiscontinuitySince(this.baseline)) return
        this._check = null
        this._phase = 'watching'
        this.view.hidePrompt()
        this.prompt(true)
        this.refreshButton()
        return
      default:
        // `off` has no calibration to move from, and `calibrating` records on, so the shift is the scan's own and the
        // quality verdict counts it; it is put to the person once the calibration is made (`arm`).
        return
    }
  }

  /**
   * Put the discontinuity to the person. `live` is true when it arrived while recording was on and is the reason
   * recording stops now; one found on arming, or after a Clear, or after a check, has had geometry recorded after it,
   * so none of it is held. `acrossCalibration` is true when it came while the calibration was running (found on arming).
   */
  private prompt(live: boolean, acrossCalibration = false): void {
    const frame = this.host.storedFrame()
    if (acrossCalibration && this.setByThisCalibration(frame)) {
      // The Place's saved points are the ones this calibration tapped, on both sides of the interruption: re-anchoring to
      // them would be measured against the thing being warned of, and there is no other pair to offer.
      this.host.say(copy.FRAME_SET_ACROSS_SHIFT_WARNING)
      this._kept = this.epochs.currentEpoch
      return
    }
    if (!canReanchor(frame)) {
      // Nothing to choose between, so recording goes on and the person is told. The scan is marked for review by the
      // quality verdict; the same epochs are not warned of twice.
      this.host.say(copy.cannotReanchorWarning(frame))
      this._kept = this.epochs.currentEpoch
      return
    }
    this._heldShifts = live ? 1 : 0
    if (this.autosplit) {
      this._phase = 'prompting'
      this.host.say(copy.AUTOSPLIT_NOTICE)
      void this.reanchor()
      return
    }
    this._phase = 'prompting'
    this.refreshButton()
    this.showInterruptionPrompt()
  }

  /**
   * Whether `frame` is the Place frame this scan's own calibration set rather than one it was measured against: a frame
   * a calibration commits carries the time of that calibration (`calibration-commit.ts`), a frame it was verified
   * against carries the time of the visit that made it.
   */
  private setByThisCalibration(frame: ProjectSpatialFrame | null | undefined): boolean {
    const calibration = this.host.calibration()
    return !!frame && !!calibration && frame.createdAt === calibration.calibratedAt
  }

  private showInterruptionPrompt(): void {
    this.view.showPrompt({
      kind: 'interruption',
      text: copy.interruptionText(this.epochs.frameShifts),
      detail: copy.interruptionDetail(this.host.storedFrame()),
      actions: this.choiceActions(),
    })
  }

  private choiceActions(): PromptAction[] {
    return [
      { id: 'reanchor', label: copy.REANCHOR_LABEL, primary: true, run: () => void this.reanchor() },
      { id: 'keep', label: copy.KEEP_GOING_LABEL, run: () => this.keepGoing() },
    ]
  }

  // ── The two choices ───────────────────────────────────────────────────────

  /**
   * Keep recording into this scan. It stays marked for review (the quality verdict counts every discontinuity again
   * from here), and the runtime is not asked about those it has already moved through. Also closes a closure result
   * the person does not want to act on.
   */
  keepGoing(): void {
    if (this._phase === 'checking') {
      this.endCheck()
      return
    }
    if (this._phase !== 'prompting') return
    this._heldShifts = 0
    this._kept = this.epochs.currentEpoch
    this._phase = 'watching'
    this.view.hidePrompt()
    this.refreshButton()
  }

  /**
   * End this scan and begin another in the epoch the runtime is in now, then run the Place calibration for it.
   *
   * The scan so far is saved first, through the host's export. If that fails nothing was ended, nothing is lost, and the
   * choice stays open. Once it has been saved the new scan begins (a new session, the run's id with the epoch on it,
   * nothing carried over from the old scan, in particular not its calibration), recording goes on into it, and the
   * return-visit calibration runs against the Place's saved points. When the person continues without calibrating, the
   * new scan has no calibration and the flow is off for it.
   */
  async reanchor(): Promise<ReanchorOutcome> {
    if (this._phase !== 'prompting' && this._phase !== 'watching' && this._phase !== 'checking') {
      return { ok: false, reason: 'busy' }
    }
    this._phase = 'finishing'
    this._check = null
    this.refreshButton()
    this.view.showPrompt({ kind: 'saving', text: copy.SAVING_TEXT, actions: [], busy: true })

    const finished = await this.finishWithinLimit()
    if (finished === 'failed' || finished === 'slow') {
      this._phase = 'prompting'
      this.refreshButton()
      this.view.showPrompt({
        kind: 'save-failed',
        text: finished === 'slow' ? copy.SAVE_SLOW_TEXT : copy.SAVE_FAILED_TEXT,
        actions: this.choiceActions(),
      })
      return { ok: false, reason: finished === 'slow' ? 'save-timed-out' : 'save-failed' }
    }

    const epoch = this.epochs.currentEpoch
    const base = this.runId()
    try {
      await this.host.beginScan(base ? arRunIdAtEpoch(base, epoch) : undefined, epoch)
    } catch (error) {
      // The old scan is saved and the new one could not be begun. Recording must not stay held, and the person is not
      // left in a state the flow cannot leave: it is off, and the scanner carries on as it did before.
      console.error('[reanchor] beginning the next scan threw:', error)
      this.disarm()
      return { ok: false, reason: 'error' }
    }
    this._phase = 'calibrating'
    this._heldShifts = 0
    this.view.hidePrompt()
    this.refreshButton()

    let calibrated = false
    try {
      calibrated = await this.host.calibrate()
    } catch (error) {
      console.error('[reanchor] the calibration for the next scan threw:', error)
    }
    // The epoch log holds the epoch the calibration was made in (src/main.ts noted it), and arming reads it from there.
    this.arm()
    return { ok: true, calibrated, epoch }
  }

  /**
   * The host's save, or `'slow'` when it has not answered by the limit. A save that answers after that is not waited for
   * and its answer is dropped: the flow has already put the choice back, and what the host does for itself (recording
   * the file against its entry) it does whatever the flow thinks.
   */
  private finishWithinLimit(): Promise<FinishOutcome | 'slow'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.error(`[reanchor] saving the scan has not answered in ${Math.round(this.finishLimitMs / 1000)} s`)
        resolve('slow')
      }, this.finishLimitMs)
      let pending: Promise<FinishOutcome>
      try {
        pending = this.host.finishScan()
      } catch (error) {
        pending = Promise.reject(error)
      }
      pending.then(
        (outcome) => {
          clearTimeout(timer)
          resolve(outcome)
        },
        (error: unknown) => {
          clearTimeout(timer)
          console.error('[reanchor] saving the scan threw:', error)
          resolve('failed')
        },
      )
    })
  }

  // ── Checking drift ────────────────────────────────────────────────────────

  /** Begin a drift check: ask for the landmark. Does nothing unless the scan is calibrated and recording. */
  startCheck(): void {
    if (this._phase !== 'watching') return
    if (!this.checkable(this.host.calibration())) {
      this.view.showPrompt({
        kind: 'closure',
        text: copy.CHECK_UNAVAILABLE_TEXT,
        actions: [{ id: 'done', label: copy.DONE_LABEL, primary: true, run: () => this.endCheck() }],
      })
      this._phase = 'checking'
      this._check = { step: 'result', landmark: null, busy: false }
      this.refreshButton()
      return
    }
    this._phase = 'checking'
    this._check = { step: 'landmark', landmark: null, busy: false }
    this.refreshButton()
    this.showTapPrompt()
  }

  /** A tap on the canvas while a check is waiting for one. Ignored at any other time. */
  async acceptTap(x: number, y: number): Promise<void> {
    const check = this._check
    if (this._phase !== 'checking' || !check || check.busy || check.step === 'result') return
    check.busy = true
    this.showTapPrompt()
    let result: TapResult
    try {
      result = await this.host.readTap(x, y)
    } catch {
      result = { ok: false, reason: 'no-hit', n: 0 }
    }
    check.busy = false
    // Cancelled, or the scan was reset, while the burst was running.
    if (this._check !== check) return
    if (!result.ok) {
      this.showTapPrompt(result)
      return
    }
    if (check.step === 'landmark') {
      check.landmark = result
      if (this.host.calibration()?.method === 'two-point-ground') {
        check.step = 'heading'
        this.showTapPrompt()
        return
      }
      this.finishCheck(result, null)
      return
    }
    this.finishCheck(check.landmark!, result)
  }

  private skipHeading(): void {
    const check = this._check
    if (this._phase !== 'checking' || !check || check.step !== 'heading' || check.busy || !check.landmark) return
    this.finishCheck(check.landmark, null)
  }

  private checkable(calibration: ScanCalibration | undefined): calibration is ScanCalibration {
    return !!calibration
      && (calibration.method === 'two-point-ground' || calibration.method === 'ground-tap-compass')
      && calibration.sessionToProject.length === 16
  }

  private tapActions(step: CheckStep): PromptAction[] {
    const cancel: PromptAction = { id: 'cancel', label: copy.CANCEL_LABEL, run: () => this.endCheck() }
    if (step === 'heading') {
      return [{ id: 'skip', label: copy.SKIP_HEADING_LABEL, run: () => this.skipHeading() }, cancel]
    }
    return [cancel]
  }

  /** The prompt that asks for the next tap, with the reason the last one was refused when it was. */
  private showTapPrompt(refusal?: TapRefusal): void {
    const check = this._check
    if (!check) return
    const frame = this.host.storedFrame()
    const labels = frame?.method === 'two-point-ground' ? frame.pointLabels : undefined
    const separation = frame?.method === 'two-point-ground' ? frame.separationM : undefined
    const heading = check.step === 'heading'
    const detail = check.busy
      ? copy.READING_TAP_TEXT
      : refusal
        ? copy.refusedTapDetail(refusal)
        : heading ? copy.tapHeadingDetail(separation) : copy.TAP_LANDMARK_DETAIL
    this.view.showPrompt({
      kind: heading ? 'tap-heading' : 'tap-landmark',
      text: heading ? copy.tapHeadingText(labels?.[1]) : copy.tapLandmarkText(labels?.[0]),
      detail,
      actions: this.tapActions(check.step),
      busy: check.busy,
    })
  }

  /** Work the closure out from the taps, keep it with the scan, and show what it says. */
  private finishCheck(landmark: TapSample, heading: TapSample | null): void {
    const check = this._check
    const calibration = this.host.calibration()
    if (!check || !calibration || !this.checkable(calibration)) {
      this.showCheckFailed()
      return
    }
    // The points the calibration itself placed: the landmark at the origin and, on the two-point tier, the heading marker
    // on +Z at the separation it measured. The Place's saved pair is the same pair up to the spacing residual, which
    // neither the translation (read at the landmark) nor the turn (read from directions) depends on.
    const stored: Vec3[] = [{ x: 0, y: 0, z: 0 }]
    const retapped: Vec3[] = [landmark.position]
    if (heading && calibration.method === 'two-point-ground') {
      stored.push({ x: 0, y: 0, z: calibration.separationM })
      retapped.push(heading.position)
    }
    const measured = measureClosure({ sessionToProject: calibration.sessionToProject, stored, retapped })
    if (!measured.ok) {
      this.showCheckFailed()
      return
    }
    const taps: ClosureTap[] = [landmark, ...(heading ? [heading] : [])].map((tap) => ({
      source: tap.source,
      spreadM: tap.spreadM,
      rangeM: tap.rangeM,
    }))
    const record = closureRecord(measured.closure, {
      at: this.now().toISOString(),
      epoch: this.epochs.currentEpoch,
      // From the last pose before the calibration was armed: that is where the camera was when the frame was set.
      pathLengthM: pathLengthM(this.host.poses(), Math.max(0, this._poseMark - 1)),
      taps,
    })
    this.epochs.noteClosure(record)
    check.step = 'result'
    const proposes = record.exceeded && canReanchor(this.host.storedFrame())
    this.view.showPrompt({
      kind: 'closure',
      text: copy.closureMeasurementText(record),
      detail: proposes
        ? `${copy.closureVerdictText(record)} ${copy.reanchorDetail(this.host.storedFrame())}`
        : copy.closureVerdictText(record),
      actions: proposes
        ? this.choiceActions()
        : [{ id: 'done', label: copy.DONE_LABEL, primary: true, run: () => this.endCheck() }],
    })
  }

  private showCheckFailed(): void {
    if (this._check) this._check.step = 'result'
    this.view.showPrompt({
      kind: 'closure',
      text: copy.CHECK_FAILED_TEXT,
      actions: [{ id: 'done', label: copy.DONE_LABEL, primary: true, run: () => this.endCheck() }],
    })
  }

  /** Close the check and go back to watching. A discontinuity that came while it was open is put to the person now. */
  private endCheck(): void {
    if (this._phase !== 'checking') return
    this._check = null
    this._phase = 'watching'
    this.view.hidePrompt()
    this.refreshButton()
    if (this.epochs.hasDiscontinuitySince(this.baseline)) this.prompt(false)
  }

  /**
   * Offer a drift check, with `text` as the reason, for a caller that has cause to think the frame has moved (the
   * runtime anchors of WP-17b report drift from the calibration's pose; they are a flag and not an epoch). Does nothing
   * unless the scan is calibrated and recording.
   */
  suggestCheck(text: string): void {
    if (this._phase !== 'watching' || !this.checkable(this.host.calibration())) return
    this.view.showPrompt({
      kind: 'suggest',
      text,
      actions: [
        { id: 'check', label: copy.CHECK_DRIFT_LABEL, primary: true, run: () => { this.view.hidePrompt(); this.startCheck() } },
        { id: 'later', label: copy.CANCEL_LABEL, run: () => this.view.hidePrompt() },
      ],
    })
  }

  private refreshButton(): void {
    this.view.setCheckButton({ visible: this._phase === 'watching' && this.checkable(this.host.calibration()) })
  }
}
