/**
 * 4DAnyone's input rules, enforced on the device.
 *
 * A clip that fails these produces a poor reconstruction or none at all, and
 * the failure otherwise surfaces 25 minutes into a GPU job on another machine —
 * the worst possible place to discover it. So the rules are checked before
 * upload, and the messages name the actual measurement rather than restating
 * the rule.
 *
 * The values are pinned from 4DAnyone's README (upstream ant-research/4DAnyone,
 * not this repo): "720p or higher, with 1080p recommended", "9:16 portrait
 * aspect ratio", "one person in a full-body or upper-body shot", "at least 121
 * frames", "only mild camera motion".
 *
 * Two of those five are not mechanically checkable and are deliberately not
 * faked here — see {@link ClipAdvisory}.
 *
 * Pure and DOM-free so it unit-tests without a browser.
 *
 * See docs/factory/10-4d-person-capture/0003-person-clip-recorder.md.
 */

/** Minimum frames 4DAnyone requires. */
export const MIN_FRAMES = 121

/** Minimum short-edge resolution. Below this, reconstruction quality falls off badly. */
export const MIN_SHORT_EDGE = 720

/** Recommended short-edge resolution. */
export const RECOMMENDED_SHORT_EDGE = 1080

/** Target aspect ratio (portrait 9:16), and how far from it is tolerable. */
export const TARGET_ASPECT = 9 / 16
export const ASPECT_TOLERANCE = 0.08

export interface ClipFacts {
  width: number
  height: number
  durationMs: number
  /** Frames per second. Client-side this is the negotiated nominal rate, which is advisory. */
  fps: number
  /** Whether an AR session supplied a pose track alongside the recording. */
  hasArSession: boolean
}

export interface ClipProblem {
  code: 'too-short' | 'too-low-res' | 'not-portrait' | 'empty'
  message: string
}

export interface ClipAdvisory {
  code: 'below-recommended-res' | 'motion-unverifiable' | 'motion-high' | 'no-pose-track'
  message: string
}

export interface ClipValidation {
  ok: boolean
  /** Blocking failures — the clip should be re-recorded. */
  problems: ClipProblem[]
  /**
   * Non-blocking notes. Kept separate because "we could not check this" and
   * "this failed the check" are different claims, and only the second one
   * justifies refusing a clip the user cannot re-shoot.
   */
  advisories: ClipAdvisory[]
  /** Frames implied by duration × fps. Advisory: ffprobe is authoritative server-side. */
  estimatedFrames: number
}

/** Frames implied by a duration and rate. Rounded down — a partial frame is not a frame. */
export function estimateFrames(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || !Number.isFinite(fps) || durationMs <= 0 || fps <= 0) return 0
  return Math.floor((durationMs / 1000) * fps)
}

/** Seconds needed to reach {@link MIN_FRAMES} at `fps`. */
export function minSecondsAt(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 0
  return MIN_FRAMES / fps
}

/**
 * Check a recorded clip against the input rules.
 *
 * Note what is *not* asserted: "one person, full-body or upper-body" needs a
 * detector this path does not run, and "mild camera motion" has no device-side
 * threshold — the acceptable amount is a property of the reconstruction, not of
 * the capture. Where an AR session ran, motion is measurable and reported as an
 * advisory; where none did, the result says the check could not run rather than
 * implying it passed. Reporting a verdict nothing measured is the defect ADR
 * 0005 rule 3 exists to prevent.
 */
export function validateClip(facts: ClipFacts, motion?: { medianSpeedMps: number }): ClipValidation {
  const problems: ClipProblem[] = []
  const advisories: ClipAdvisory[] = []

  const { width, height, durationMs, fps } = facts
  const estimatedFrames = estimateFrames(durationMs, fps)

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || durationMs <= 0) {
    problems.push({ code: 'empty', message: 'That recording came out empty. Try again.' })
    return { ok: false, problems, advisories, estimatedFrames: 0 }
  }

  if (estimatedFrames < MIN_FRAMES) {
    const needS = minSecondsAt(fps)
    problems.push({
      code: 'too-short',
      message: `That clip is ${(durationMs / 1000).toFixed(1)}s. Record at least ${needS.toFixed(1)}s so there are enough frames to reconstruct.`,
    })
  }

  const shortEdge = Math.min(width, height)
  if (shortEdge < MIN_SHORT_EDGE) {
    problems.push({
      code: 'too-low-res',
      message: `This camera is recording at ${width}×${height}. Reconstruction needs at least ${MIN_SHORT_EDGE}p on the short edge.`,
    })
  } else if (shortEdge < RECOMMENDED_SHORT_EDGE) {
    advisories.push({
      code: 'below-recommended-res',
      message: `Recording at ${width}×${height}. ${RECOMMENDED_SHORT_EDGE}p gives a noticeably better result where the device offers it.`,
    })
  }

  // Portrait, and roughly 9:16. Landscape is the common mistake and is worth
  // naming as such rather than reporting an aspect number.
  const aspect = width / height
  if (width > height) {
    problems.push({ code: 'not-portrait', message: 'Hold the phone upright. This clip is landscape, and reconstruction expects a 9:16 portrait frame.' })
  } else if (Math.abs(aspect - TARGET_ASPECT) > ASPECT_TOLERANCE) {
    problems.push({
      code: 'not-portrait',
      message: `This frame is ${width}×${height}. Reconstruction expects roughly 9:16 portrait.`,
    })
  }

  if (!facts.hasArSession) {
    advisories.push({
      code: 'no-pose-track',
      message: 'No AR session, so this clip has no camera track. It can still be reconstructed on its own, but it cannot be combined with other devices.',
    })
    advisories.push({
      code: 'motion-unverifiable',
      message: 'Camera motion was not measured — keep the movement gentle.',
    })
  } else if (motion) {
    // An adopted advisory threshold, not a gate: brisk walking is ~1.4 m/s and
    // is well past "mild" for this purpose, but nothing has characterised where
    // reconstruction actually degrades.
    if (motion.medianSpeedMps > 0.8) {
      advisories.push({
        code: 'motion-high',
        message: `The camera moved at about ${motion.medianSpeedMps.toFixed(1)} m/s. Slower, smoother movement reconstructs better.`,
      })
    }
  } else {
    advisories.push({
      code: 'motion-unverifiable',
      message: 'Camera motion was not measured — keep the movement gentle.',
    })
  }

  return { ok: problems.length === 0, problems, advisories, estimatedFrames }
}

/**
 * Candidate recording mime types, best first.
 *
 * Safari and Chrome disagree on container and codec strings, and the supported
 * combinations differ by OS version — so this is probed rather than assumed,
 * and whatever the device offers is what gets recorded. ffmpeg normalises
 * server-side, so the client's job is to capture well rather than uniformly.
 */
export const CLIP_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const

/**
 * First candidate the platform supports.
 *
 * `null` when none are — which is a real outcome on some older browsers, and
 * must surface as a clear message rather than a half-started recorder.
 */
export function pickClipMimeType(
  isSupported: (type: string) => boolean,
  candidates: readonly string[] = CLIP_MIME_CANDIDATES,
): string | null {
  for (const type of candidates) {
    if (isSupported(type)) return type
  }
  return null
}

/** File extension for a recorded mime type. Used only to name the upload. */
export function extensionForMime(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'
}
