/**
 * What an uploaded video or photo set will and will not produce — said before
 * the upload, not discovered after it.
 *
 * The start screen offered "Add a walkthrough video or photo set from a Place
 * — no AR needed". That is true about the room's shape and silently wrong
 * about the things standing in it, and someone who uploads a video to get
 * their furniture catalogued gets a reconstruction with zero objects in it and
 * no sentence anywhere explaining why.
 *
 * The split is measured, not cautious. A video ingest reconstructs geometry
 * well — 48 of 48 frames registered, a 12,430-point cloud, a 38.5 MB splat,
 * and 38 objects recognised in the flat frames. It places none of them: the
 * keyframes a video produces carry only {index, file, timestamp}, and 0 of 48
 * carried where the camera was standing, against 17 of 17 on a capture made by
 * walking with a phone. Without that, "a chair is in this picture" can never
 * become "a chair is over there", so all 29 candidate objects were refused
 * before any geometry was consulted. Working the camera positions back out of
 * the video itself does not rescue it: forced onto those, the same run placed
 * 0 of 29 — the aim was right (the search cones did hit the reconstruction,
 * median 109 points) and the distances were not, because positions recovered
 * that way are self-consistent without being in metres, and every distance
 * this step depends on is a real one.
 *
 * Kept as data in one module, next to PLACE_MODAL_COPY's precedent, because
 * three call sites have to say the same thing — the pre-upload dialog, the
 * line under the upload card, and the finished-upload result — and because the
 * only part that varies is which alternative is honest on THIS device.
 * "Scan the room instead" is bad advice on a phone that cannot run the
 * scanner at all (see src/ar/preflight.ts, where that is a verdict and not a
 * guess), and admitting that is better than repeating the suggestion.
 *
 * Register: no job names, no pipeline stages, no talk of poses or tracking.
 * Someone uploading a walkthrough of their living room has no reason to know
 * any of those words exist. The short form of the same claim is written into
 * the upload card in index.html, which paints before this bundle loads and so
 * cannot import it.
 */

/**
 * Whether a live scan is worth recommending on this device.
 *
 * Three states rather than a boolean because the upload path is wired at the
 * very top of boot (main.ts calls wireContentUpload() before the secure-context
 * check, let alone before an AR runtime is created), so a tap can land while
 * the answer is genuinely not known yet. `'unknown'` says the true thing about
 * scanning without claiming anything about this device.
 */
export type ScanCapability = 'available' | 'unavailable' | 'unknown'

export interface UploadExpectation {
  /** Heading for the pre-upload dialog. */
  title: string
  /** What the upload does produce. Leads, because it is the reason to do it. */
  builds: string
  /** What it does not — stated flatly, since the outcome is always zero objects. */
  limit: string
  /** What to do about that, or the honest admission that there is nothing to do. */
  alternative: string
}

/** Shared across all three verdicts: the outcome does not depend on the device. */
const BUILDS = 'A video or photo set rebuilds this room in 3D — its shape, its surfaces, its layout.'
const LIMIT = 'It cannot tell where things are standing inside it, so nothing gets catalogued: no furniture, no objects.'

/**
 * The pre-upload expectation, in the words the user gets to read.
 *
 * Uploading is a legitimate thing to do and produces a real reconstruction, so
 * `builds` leads and nothing here is phrased as a warning or a mistake.
 */
export function uploadExpectation(scan: ScanCapability): UploadExpectation {
  const alternative = scan === 'unavailable'
    // Naming the limit as the device's, once, and then dropping it: repeating
    // "scan instead" to someone whose phone has already been found unable to
    // is the advice-shaped noise this branch exists to avoid.
    ? 'Only walking the room with a phone can place objects, and this device cannot do that — an upload is the most it can build here.'
    : scan === 'available'
      ? 'Walking the room with this phone is what places objects. Both land in the same Place, so you can upload now and walk it later.'
      // Not yet knowable, so the claim is about the method rather than the phone.
      : 'Walking a room with a phone is what places objects. You can upload now and do that on the same Place later.'
  return { title: 'Before you upload', builds: BUILDS, limit: LIMIT, alternative }
}

/**
 * The same expectation as one line, for the status line under the upload card.
 *
 * That element (`#upload-video-progress`) is a single centred paragraph shared
 * with upload progress and errors, so this is the whole verdict or nothing —
 * there is no room there for a heading.
 */
export function uploadExpectationLine(scan: ScanCapability): string {
  const copy = uploadExpectation(scan)
  return `${copy.builds} ${copy.limit} ${copy.alternative}`
}

/**
 * Tail for the "Uploaded — N keyframes extracted" result line.
 *
 * Short by necessity and duplicated in spirit rather than in words: the result
 * line is read seconds before the editor opens on a reconstruction with an
 * empty object list, which is the one moment the expectation set minutes
 * earlier is most likely to have been forgotten.
 */
export const UPLOAD_RESULT_NOTE = 'Building the room in 3D — objects are not placed from an upload.'
