/**
 * Running the calibration modal again when the person leaves it for something else (WP-08).
 *
 * The modal is built for one Place and one run: its stored frame, its first-calibration or return-visit copy and its
 * photos are fixed when it opens. Two of its ways out do not end the scan's calibration, they change what the
 * calibration is about, so the modal closes without a result and tells the page which (`onExit`), and the page runs
 * it again:
 *
 *  - `'choose-place'` ("Wrong Place? Choose another", the button and the `onWrongPlace` option of WP-07's return-visit
 *    flow): the Place picker opens, and the modal runs again for the Place the person ends up on. A person who leaves the
 *    picker without choosing goes back to the Place they had, and one who chooses to go on with no Place at all gets no
 *    calibration, as "Continue uncalibrated" would give them.
 *  - `'improve'` ("Improve this Place's reference"): the modal runs again as an upgrade, a first calibration whose
 *    frame replaces the Place's. The person has already confirmed the replacement.
 *  - `'keep'` ("Keep the saved reference", inside an upgrade): the person gave it up. The modal runs again as an ordinary
 *    visit to the Place, against the reference it still has.
 *
 * Nothing here knows about the DOM, the picker or the server: the page hands in what each step does, which is what
 * lets the loop be tested with fakes. Each turn round the loop is one tap of a button, so it cannot spin.
 */
import type { GenerationMode } from '../world/frame-replacement.ts'
import type { Project } from '../world/types'

/** Where the person leaves the modal to go: the page runs it again afterwards. */
export type CalibrationExit = 'choose-place' | 'improve' | 'keep'

export interface ExitLoopDeps<R> {
  /**
   * Runs the modal for the Place that is selected now, in `mode`. `onExit` is how the modal says the person left it
   * for another run; the modal then resolves null.
   */
  run(mode: GenerationMode | undefined, onExit: (exit: CalibrationExit) => void): Promise<R | null>
  /** The Place the page has selected now. The picker changes it. */
  selected(): Project | null
  /** Opens the Place picker and resolves when the person has chosen a Place, chosen none, or left it. */
  choosePlace(): Promise<void>
  /** Waits for anything the next run must see first, such as a frame that is still being sent. */
  settle?(): Promise<void>
}

export interface ExitLoopResult<R> {
  /** What the last run resolved to: the calibration, or null when the person went on without one. */
  result: R | null
  /** The mode the last run was in, which the result was made under. */
  mode: GenerationMode | undefined
}

export async function runWithExits<R>(deps: ExitLoopDeps<R>): Promise<ExitLoopResult<R>> {
  let mode: GenerationMode | undefined
  for (;;) {
    await deps.settle?.()
    // Held in an object: the modal sets it from its own click handler, which the compiler cannot follow.
    const left: { exit: CalibrationExit | null } = { exit: null }
    const result = await deps.run(mode, (requested) => {
      left.exit = requested
    })
    // A run that produced a calibration is done, whatever else it reported.
    if (left.exit === null || result !== null) return { result, mode }

    if (left.exit === 'improve') {
      mode = 'upgrade'
      continue
    }
    mode = undefined
    if (left.exit === 'keep') continue
    await deps.choosePlace()
    if (deps.selected() === null) return { result: null, mode }
  }
}

/**
 * What the page's Place picker takes to be opened: the action to run when a Place has been chosen (or none), the
 * purpose it is opened for, and the action to run when it is left without a choice.
 */
export type PlacePickerOpener = (afterSelection?: () => void, purpose?: 'scan', onDismiss?: () => void) => void

/**
 * Opens the Place picker for the scan and resolves when the person has made a choice or left it. A page whose picker
 * is not wired resolves at once: there is nothing to choose.
 */
export function openPlacePickerAndWait(open: PlacePickerOpener | null): Promise<void> {
  return new Promise((resolve) => {
    if (!open) {
      resolve()
      return
    }
    open(() => resolve(), 'scan', () => resolve())
  })
}
