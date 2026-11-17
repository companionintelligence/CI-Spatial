/**
 * What the registry does about frames when scans are put in another Place (ADR 0009): a merge, and a scan moved by
 * `PATCH /projects/:id/scans/:scanId`. The decisions are `./place_frames.ts`'s and have no I/O; this is the part that
 * reads the scans stored, changes the Place registry in the one step it is changed in, and copies photos.
 *
 * A factory with what it needs from `server/main.ts` handed in (`PlaceMoveDeps`), because `main.ts` cannot be imported
 * by a test without starting the server. The routes keep the Place, area and floor checks, the filing of the sidecars and
 * the hand-over of what was made of the scans to the other world; they call this for the frames.
 *
 * ## A moved scan: judged first, changed after it is filed
 *
 * `planScanMove` judges the move and changes nothing. It names the stored scans the request means (`filenames`), once,
 * so the route files exactly those and the judgement and the filing cannot disagree about what the request names. A
 * move that must be refused is refused before anything is touched. `commit`, which the route calls after the scans are
 * filed, is what changes the Place: it takes the frame the scans were measured against when it holds none, and describes the
 * generations the scans name when it holds another, so a request that finds nothing to file (a 404) has changed no Place.
 */
import type { FrameHistoryEntry, Project, ProjectSpatialFrame } from '../src/world/types.ts'
import { type FrameMismatchBody, joinFrameHistory } from '../src/world/frame-generations.ts'
import { placeFrameRevision } from '../src/world/spatial-frame.ts'
import { calibrationFromMeta } from './calibration_fields.ts'
import {
  decideMergeFrames,
  decideReassignFrames,
  framesBroughtByMerge,
  framesNamedByScans,
  knownFrameIds,
  mergeMismatchBody,
  reassignMismatchBody,
} from './place_frames.ts'
import { copyFrameFolder, copyFramePhotos } from './project_media.ts'
import { scanIdFor } from './scan_id.ts'
import { scanProjectId } from './world/world_membership.ts'

/** A stored scan, as far as a move needs to know it: its file, and its sidecar with the session record merged in. */
export interface StoredScanFacts {
  filename: string
  meta: Record<string, unknown>
}

/** What a move needs from the server. */
export interface PlaceMoveDeps {
  /** The folder the Places' photo folders are in. */
  mediaDir: string
  /** The scans stored, as the scan list reads them (`listStoredScans`). */
  listStoredScans(): Promise<ReadonlyArray<StoredScanFacts>>
  /** The Places the registry holds, read now. */
  loadProjects(): Promise<Project[]>
  /** The registry's one-writer step (`mutateProjects`): the mutator changes the Places it is given, and says whether to save. */
  mutateProjects<T>(mutator: (projects: Project[]) => { result: T; save: boolean } | Promise<{ result: T; save: boolean }>): Promise<T>
  /** How many scans are stored for a Place. */
  countScans(projectId: string): Promise<number>
  /** The time, in milliseconds. Default: now. */
  now?(): number
}

/** Whether a stored scan is the one `scanId` names: by its id, its file name, or the capture session it came from. */
export function isScanNamed(filename: string, meta: Record<string, unknown>, scanId: string): boolean {
  const session = meta['sessionId']
  return scanIdFor(filename) === scanId || filename === scanId || (typeof session === 'string' && session.length > 0 && session === scanId)
}

/** What a move of scans into a Place is, as far as its Place goes. */
export type ScanMovePlan =
  /** Nothing is stored under the name the request gives: the route answers 404. */
  | { kind: 'none' }
  /** The scans were measured in another frame than the Place's, and the request did not say it knows: the route answers 409 with `body`. */
  | { kind: 'refused'; body: FrameMismatchBody }
  /** The move may go on: file exactly `filenames`, and call `commit` once they are filed. */
  | { kind: 'go'; filenames: string[]; commit(): Promise<void> }

export interface PlaceMoves {
  /**
   * Judges filing the scan `scanId` (every stored scan it names) under the Place `targetProjectId`: refused when it would
   * put a scan in a frame it was not measured in and `accepted` is not set, and otherwise a plan to file the scans and
   * then `commit`. Changes nothing. A scan that is not in a Place frame, and a move within the scan's own Place, are never refused.
   */
  planScanMove(scanId: string, targetProjectId: string, accepted: boolean): Promise<ScanMovePlan>
  /**
   * Merging `source` into `target`, inside the registry step that merges them: answers the 409 body when the two Places
   * hold different frames and the request did not say it knows (nothing is changed), and otherwise makes `target` hold
   * the frame `source` held when it held none, and describe what `source` held (its history, and its current frame when
   * that is another than `target`'s), copying the photos of each, so the scans that come with the merge can be described and
   * their photos served.
   */
  mergeFrames(target: Project, source: Project, accepted: boolean): Promise<FrameMismatchBody | null>
}

export function createPlaceMoves(deps: PlaceMoveDeps): PlaceMoves {
  const now = () => (deps.now ?? Date.now)()

  /**
   * Describes in the history of `target` the frames in `entries` that belong to `from`'s Place, and copies each one's
   * photos into `target`'s folder. A frame `target` holds now, or has described already, is not described again.
   * Answers whether the history changed.
   */
  async function describeFrames(target: Project, from: Project, entries: readonly FrameHistoryEntry[]): Promise<boolean> {
    const known = knownFrameIds(target)
    const fresh = entries.filter((entry) => entry.frameId === null || !known.has(entry.frameId))
    if (fresh.length === 0) return false
    const joined = joinFrameHistory(target.frameHistory, fresh)
    const changed = JSON.stringify(joined) !== JSON.stringify(target.frameHistory ?? [])
    if (!changed) return false
    target.frameHistory = joined
    for (const entry of fresh) {
      if (entry.frameId !== null) await copyFrameFolder(deps.mediaDir, from.projectId, target.projectId, entry.frameId)
    }
    target.updatedAt = now()
    return true
  }

  /**
   * Makes `target` hold `frame`, which `from`'s scans were measured against: the frame is stored as the Place's (its
   * photos copied into the Place's own folder, so the record names files that are there), and its revision goes up by one.
   * With `withHistory`, the frames `from` held before it join the Place's history, so the scans of those generations stay
   * listed. For the registry step of the move.
   */
  async function giveFrame(target: Project, from: Project, frame: ProjectSpatialFrame, withHistory: boolean): Promise<void> {
    target.spatialFrame = await copyFramePhotos(deps.mediaDir, from.projectId, target.projectId, frame)
    target.spatialFrameRevision = placeFrameRevision(target) + 1
    target.updatedAt = now()
    if (withHistory) await describeFrames(target, from, framesBroughtByMerge(from, false, now()))
  }

  async function mergeFrames(target: Project, source: Project, accepted: boolean): Promise<FrameMismatchBody | null> {
    const decision = decideMergeFrames(target, source)
    if (decision.kind === 'mismatch' && !accepted) {
      return mergeMismatchBody(decision, target, source, await deps.countScans(source.projectId))
    }
    if (decision.kind === 'copy') await giveFrame(target, source, decision.frame, true)
    else await describeFrames(target, source, framesBroughtByMerge(source, decision.kind === 'mismatch', now()))
    return null
  }

  async function commitScanMove(moving: ReadonlyArray<StoredScanFacts>, targetProjectId: string, accepted: boolean): Promise<void> {
    await deps.mutateProjects(async (projects) => {
      const target = projects.find((place) => place.projectId === targetProjectId)
      if (!target) return { result: undefined, save: false }
      let changed = false
      for (const scan of moving) {
        // Judged again, on the registry as it is now: the Place may have taken a frame, or lost one, since the plan.
        const from = projects.find((place) => place.projectId === scanProjectId(scan.meta)) ?? null
        const calibration = calibrationFromMeta(scan.meta)
        const decision = decideReassignFrames(calibration, from, target)
        if (decision.kind === 'copy') {
          // One scan comes, not the Place: the generations the other Place held before are not this Place's to list.
          await giveFrame(target, from!, decision.frame, false)
          changed = true
        } else if (decision.kind === 'mismatch' && accepted && from !== null && calibration.calibrationFrameId !== undefined) {
          const named = framesNamedByScans(from, new Set([calibration.calibrationFrameId]), now())
          changed = (await describeFrames(target, from, named)) || changed
        }
      }
      return { result: undefined, save: changed }
    })
  }

  async function planScanMove(scanId: string, targetProjectId: string, accepted: boolean): Promise<ScanMovePlan> {
    const moving = (await deps.listStoredScans()).filter((scan) => isScanNamed(scan.filename, scan.meta, scanId))
    if (moving.length === 0) return { kind: 'none' }
    const projects = await deps.loadProjects()
    const target = projects.find((place) => place.projectId === targetProjectId)
    if (target) {
      for (const scan of moving) {
        const from = projects.find((place) => place.projectId === scanProjectId(scan.meta)) ?? null
        const decision = decideReassignFrames(calibrationFromMeta(scan.meta), from, target)
        if (decision.kind === 'mismatch' && !accepted) {
          return { kind: 'refused', body: { ...reassignMismatchBody(decision, target), scans: moving.length } }
        }
      }
    }
    return {
      kind: 'go',
      filenames: moving.map((scan) => scan.filename),
      commit: () => commitScanMove(moving, targetProjectId, accepted),
    }
  }

  return { planScanMove, mergeFrames }
}
