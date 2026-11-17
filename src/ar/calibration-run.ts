/**
 * The scanner's calibration, run against the Place's reference policy (WP-08): `runProjectCalibration` with the
 * Place-reference hooks supplied, the ways out that run it again, and the result stamped with the generation of the
 * Place's reference it belongs to.
 *
 * `./project-calibration.ts` is one run of the modal for one Place. This is what the page calls instead. It takes
 * the modal's own options and adds `exits`, what only the page knows (which Place is selected, how to open its
 * picker, what to wait for before a run, and what the server says about a reference). It then:
 *
 *  - runs the modal for the Place that is selected, with the hooks that make "Replace this Place's reference" ask
 *    first, show "Improve this Place's reference" before a landmark is placed and "Keep the saved reference" inside the
 *    upgrade that follows (./replace-reference.ts), and with the
 *    modal's `onWrongPlace` option, the hook of WP-07's "Wrong Place? Choose another" button, which closes the modal for
 *    the Place picker;
 *  - runs it again when the person leaves it for another Place, to improve the reference, or to go back from that
 *    (./calibration-exits.ts);
 *  - stamps what comes out. The modal makes the calibration and, when the Place's frame changes, the new frame; this
 *    gives the frame a new id, names that id on the calibration, and says which frame it replaces and why
 *    (`planFrameGeneration`, ../world/frame-replacement.ts). The result is what the modal returned with those
 *    fields filled in, so a caller that read only `calibration`, `spatialFrame` and `referencePhotos` goes on doing
 *    so, and passes `replaces` to the frame's write.
 *
 * What a calibration is stamped against is the frame the modal was given for that run, not the Place as it stands when the
 * run ends: a frame the server answered for meanwhile (a retry settling while the person is placing points) is not the one
 * their points were compared with.
 *
 * A run with no Place selected (the person chose to go on with none) has no frame to stamp: the result is null, as for
 * "Continue uncalibrated".
 */
import type { Project, ProjectSpatialFrame } from '../world/types'
import { improveOffered, planFrameGeneration, type FrameReplaces, type ReferenceStatus } from '../world/frame-replacement.ts'
import { fetchFrameStatus } from '../project/frame-status.ts'
import { runWithExits } from './calibration-exits.ts'
import { runProjectCalibration as runModal, type CalibrationResult } from './project-calibration'
import { askToReplaceReference } from './replace-reference.ts'

/** What the page tells this about itself. */
export interface PlaceExits {
  /** The Place selected now. The Place picker changes it, so it is read each time the modal is about to run. */
  selected(): Project | null
  /** Opens the Place picker and resolves when the person has chosen, chosen none, or left it. */
  choosePlace(): Promise<void>
  /** Waits for anything the next run must see first (a frame still being sent). */
  settle?(): Promise<void>
  /** What the server says about a Place's reference. Default: `GET /projects/:id/frame-status`. */
  fetchStatus?(project: Project): Promise<ReferenceStatus | null>
}

type ModalOptions = Parameters<typeof runModal>[0]

/**
 * The option WP-07's return-visit flow adds to the modal: pressing "Wrong Place? Choose another" calls it, and the modal
 * closes with no calibration. Declared here, so that this file builds without that package; once it has landed the modal's
 * own option type carries it and this adds nothing.
 */
interface WrongPlaceHook {
  onWrongPlace?: () => void
}

export type PlaceCalibrationOptions = Omit<ModalOptions, 'project' | 'generation' | 'onWrongPlace'> & {
  exits: PlaceExits
  /** Whether "Improve this Place's reference" is offered for a frame. Default: `improveOffered`. */
  canImprove?: (stored: ProjectSpatialFrame | undefined) => boolean
  /** The modal to run. Default: the calibration modal. A test supplies a scripted one. */
  modal?: typeof runModal
}

/** A calibration result with the Place's reference accounted for. */
export interface PlaceCalibration extends CalibrationResult {
  /** Set when `spatialFrame` replaces a frame the Place held: which one, and why. Pass it to the frame's write. */
  replaces?: FrameReplaces
  /** The frame that was replaced, as the Place held it. */
  superseded?: ProjectSpatialFrame
}

/** A copy of the Place that holds no frame: the modal then runs as a first calibration, which is what an upgrade is. */
function withoutFrame(project: Project): Project {
  const copy = { ...project }
  delete copy.spatialFrame
  return copy
}

export async function runProjectCalibration(options: PlaceCalibrationOptions): Promise<PlaceCalibration | null> {
  const { exits, canImprove, modal: run = runModal, ...modalOptions } = options
  const fetchStatus = exits.fetchStatus ?? ((project: Project) => fetchFrameStatus(project.projectId))
  // What the last run began with. Held in an object: the loop sets it from inside its own callback, which the compiler cannot follow.
  const last: { ran: boolean; held: ProjectSpatialFrame | undefined } = { ran: false, held: undefined }

  const { result, mode } = await runWithExits<CalibrationResult>({
    selected: exits.selected,
    choosePlace: exits.choosePlace,
    settle: exits.settle,
    run: (runMode, onExit) => {
      const project = exits.selected()
      if (!project) return Promise.resolve(null)
      last.ran = true
      last.held = project.spatialFrame
      const modalRun: ModalOptions & WrongPlaceHook = {
        ...modalOptions,
        project: runMode === 'upgrade' ? withoutFrame(project) : project,
        generation: {
          mode: runMode,
          canImprove: runMode === 'upgrade' ? undefined : (canImprove ?? ((stored) => improveOffered(stored))),
          onImprove: () => onExit('improve'),
          onKeepReference: () => onExit('keep'),
          confirmReplace: (host, ask) => askToReplaceReference(host, ask, { fetchStatus: () => fetchStatus(project) }),
        },
        onWrongPlace: () => onExit('choose-place'),
      }
      return run(modalRun)
    },
  })
  if (!result || !last.ran) return null

  const plan = planFrameGeneration({
    held: last.held,
    calibration: result.calibration,
    spatialFrame: result.spatialFrame,
    mode,
  })
  return {
    ...result,
    calibration: plan.calibration,
    ...(plan.spatialFrame ? { spatialFrame: plan.spatialFrame } : {}),
    ...(plan.replaces ? { replaces: plan.replaces, superseded: plan.superseded } : {}),
  }
}
