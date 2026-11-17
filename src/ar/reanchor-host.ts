/**
 * The scan half of the re-anchor flow's host: how a scan is ended and the next one begun (WP-09b).
 *
 * ./reanchor-flow.ts decides when a scan ends; src/main.ts owns everything a scan is made of (the store, the point
 * cloud, the pose trail, the keyframe stream, the Place entry, the calibration). This file is the order of operations
 * between them, with main.ts's parts handed in as `ScanHostPorts`, so the order is tested against the real store and the
 * real flow and main.ts keeps a few lines of wiring instead of the sequence.
 *
 * ## Ending a scan: the existing path
 *
 * The scan so far is saved the way an autosave saves it: the store's snapshot, then the GLB export with its sidecar,
 * uploaded, then the bookkeeping for the file that came back. Nothing about it is new, which is the point: a finished
 * scan is an ordinary scan that keeps the calibration it was made with, and the server places it by that calibration as
 * it places any other. The autosave is held off for the duration (`exclusive`), so a timer that fires meanwhile cannot
 * export the same scan twice or export the next one half-begun.
 *
 * A capture that is still being analysed when the person presses Re-anchor belongs to the scan that is ending, and its
 * objects are written into the live session when the model answers, which is the old scan's only until the next one
 * begins. So the save waits for it (`capturing`), for no longer than `CAPTURE_SETTLE_LIMIT_MS`: past that the scan is
 * ended without it, and its objects are not written into either scan (the photo stays in the history of the old one).
 *
 * What the outcome means. `'uploaded'` and `'queued'` (the service worker holds it and sends it when the network
 * returns) both mean the scan is safe and the next one may begin. `'empty'` means there was nothing to save (the
 * interruption came before anything was recorded): the next scan begins and no empty scan is sent. `'failed'` means the
 * server turned it away and the phone kept no copy it can offer: nothing is ended, because ending it would empty the
 * point cloud, which exists nowhere else.
 *
 * ## Beginning the next one
 *
 * In this order, and each step is why the next one is safe:
 *
 *  1. The number of objects the old scan held is read, before the store moves on (the page's reset wants it).
 *  2. A new session starts in the store (`beginSession`): the old scan's record stays in the history, untouched.
 *  3. The store's AR run becomes the run's id with the epoch on it (`<run>.<epoch>`): what the new scan stores, the
 *     detections and the captures, carries it, and what the old scan stored does not match it, so it is not shown with
 *     or exported into the new one.
 *  4. The page empties what a scan accumulates (the point cloud, the pose trail, the keyframe stream, the epoch log's
 *     count). This is the reset a Clear does, which stops the keyframe stream.
 *  5. The calibration is forgotten, in the page and in the epoch log. A Clear keeps it, because the next scan after a
 *     Clear is in the same frame; this scan is in another, and carrying the old calibration over would place it in a frame
 *     it was not measured in, silently. It has none until the next step makes one.
 *  6. If the keyframe stream was on, it is started again, into a new server session, so the new scan has its own.
 *
 * A store that does not begin a session (read-only, or superseded by another tab) ends the sequence there, before
 * anything is emptied: the page has no scan of its own to end, and the cloud and the calibration it holds exist nowhere
 * else.
 *
 * Then the Place calibration runs for it (the return-visit flow, against the Place's saved points), and once it has made
 * one the scan's Place entry is created with the new session and the new calibration, or, when an export has already
 * made the entry while the calibration was running, given the calibration (`carryCalibration`): an entry without one
 * would send every later upload of the scan uncalibrated, and the server would place it by GPS or on a grid. A scan the
 * person continues without calibrating has no entry until it is exported, as any scan has none.
 */
import type { ScanCalibration } from '../world/types.ts'
import type { FinishOutcome, ReanchorHost } from './reanchor-flow.ts'

/**
 * The longest the save waits for a capture that is being analysed, in milliseconds.
 *
 * Adopted, not measured (ADR 0005 rule 5). A capture takes 3 to 7 s to be answered (the page's own comment on it), so
 * this is about twice the slow end: long enough that a capture the person has just taken is not lost, short enough
 * that a model that never answers (its own request limit is over a minute) does not hold the scan. Replace it with the
 * capture times DX4's walks record.
 */
export const CAPTURE_SETTLE_LIMIT_MS = 15_000

/** How often the wait looks again, in milliseconds. */
const CAPTURE_POLL_MS = 100

/** What of an export the host reads: the same shape `exportToGLB` (src/export/gltf.ts) answers with. */
export interface ExportedScan {
  uploadedFilename?: string
  upload: 'uploaded' | 'queued-offline' | 'failed' | 'skipped'
}

/** What of `DetectionStore` (src/scene/store.ts) the host uses. */
export interface ScanHostStore {
  saveSnapshot(): Promise<boolean>
  beginSession(): boolean | Promise<boolean>
  startArRun(arRunId?: string): string
  currentRunDetections(): { readonly size: number }
}

/** The parts of the page the sequence needs. All of them belong to src/main.ts. */
export interface ScanHostPorts {
  store: ScanHostStore
  /** Runs `fn` while no autosave runs and none starts, then lets a queued one go. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  /** Whether the scan holds anything worth saving: points, detections or a camera path. */
  hasContent(): boolean
  /** Export the scan through the path it already has: uploaded, not downloaded. */
  exportScan(): Promise<ExportedScan>
  /** The bookkeeping for an uploaded scan: its Place entry, and the file name the keyframe session links to. */
  recordUploaded(filename: string): Promise<void>
  /** The page's own reset of everything a scan accumulates (`resetScanner` in src/main.ts); given the objects the old scan held. */
  resetScan(detectionsLeft: number): void
  /** Forget the scan's calibration, in the page and in the epoch log: the next scan is in another frame. */
  clearCalibration(): void
  /** The keyframe stream, to start again for the new scan when it was running. Null on a page with none. */
  keyframes: { readonly active: boolean; start(): Promise<void> } | null
  /** Run the Place calibration for the scan that has just begun. Resolves true when it made one. */
  calibrate(): Promise<boolean>
  /** Create the scan's Place entry now, or take the calibration to the one it has, with the live session and calibration. */
  ensureEntry(): Promise<unknown>
  /** Whether a capture is being analysed: its objects are not in the scan yet. Absent on a page with no capture path. */
  capturing?(): boolean
}

/** How long the save waits for a capture, and how: all but the limit are there so a test needs no clock. */
export interface ScanHostTiming {
  limitMs?: number
  pollMs?: number
  now?(): number
  sleep?(ms: number): Promise<void>
}

/**
 * Give an entry the scan already has the calibration the scan has been given since, so that what is exported from it
 * says so. An entry is made by the first export of a scan, and a scan's calibration is made by a flow that can run for a
 * minute with recording on: an export in between (a capture's autosave, a manual one) makes the entry without a
 * calibration, and nothing would ever give it one, so every upload of the scan would go up uncalibrated. Returns whether
 * the entry changed, for the caller to save it. An entry with a calibration of its own keeps it.
 */
export function carryCalibration(entry: { calibration?: ScanCalibration }, calibration: ScanCalibration | undefined): boolean {
  if (!calibration || entry.calibration) return false
  entry.calibration = calibration
  return true
}

/** Wait, up to the limit, for the page to have no capture being analysed. */
async function settleCapture(ports: ScanHostPorts, timing: ScanHostTiming): Promise<void> {
  if (!ports.capturing) return
  const now = timing.now ?? Date.now
  const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const until = now() + (timing.limitMs ?? CAPTURE_SETTLE_LIMIT_MS)
  while (ports.capturing() && now() < until) await sleep(timing.pollMs ?? CAPTURE_POLL_MS)
}

export type ScanHost = Pick<ReanchorHost, 'finishScan' | 'beginScan' | 'calibrate'>

export function createScanHost(ports: ScanHostPorts, timing: ScanHostTiming = {}): ScanHost {
  return {
    finishScan: async () => {
      // Before the lock, so a capture's own autosave (queued as it finishes) is the one the lock then cancels.
      await settleCapture(ports, timing)
      return ports.exclusive(async (): Promise<FinishOutcome> => {
        try {
          await ports.store.saveSnapshot()
          if (!ports.hasContent()) return 'empty'
          const result = await ports.exportScan()
          if (result.upload === 'queued-offline') return 'queued'
          if (result.upload !== 'uploaded' || !result.uploadedFilename) return 'failed'
          // Bookkeeping must not undo a scan that is on the server: its failure is logged, and the scan is saved.
          await ports.recordUploaded(result.uploadedFilename).catch((error: unknown) => {
            console.error('[reanchor] the saved scan could not be recorded against its Place (non-fatal):', error)
          })
          return 'uploaded'
        } catch (error) {
          console.error('[reanchor] saving the scan failed:', error)
          return 'failed'
        }
      })
    },

    beginScan: async (arRunId) => {
      const detectionsLeft = ports.store.currentRunDetections().size
      const keyframesWereOn = ports.keyframes?.active === true
      // A store that did not begin a session (read-only, or superseded by another tab) has no scan of its own to end, and
      // emptying the page's cloud and forgetting its calibration under the session it still holds would lose both.
      if (!(await ports.store.beginSession())) throw new Error('the scan store did not begin a new session')
      ports.store.startArRun(arRunId)
      ports.resetScan(detectionsLeft)
      ports.clearCalibration()
      if (keyframesWereOn) {
        void ports.keyframes?.start().catch((error: unknown) => {
          console.warn('[reanchor] keyframe streaming did not start again for the new scan:', error)
        })
      }
    },

    calibrate: async () => {
      const calibrated = await ports.calibrate()
      if (calibrated) {
        await ports.ensureEntry().catch((error: unknown) => {
          console.error('[reanchor] the new scan has no Place entry yet (non-fatal; the next export makes it):', error)
        })
      }
      return calibrated
    },
  }
}
