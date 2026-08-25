/**
 * 4D person layer — a splat sequence played on a clock.
 *
 * When a scan has been through the `person-4d-reconstruct` world job, the
 * server lands a sequence beside it:
 *
 *   /scans/<base>.4d-capture.manifest.json   run index (frameCount, fps, viewSource)
 *   /scans/<base>.4d/frame-00000.sog …       one trained splat per timestep
 *
 * Rendering reuses the existing path exactly — `loadSplat()` → `SplatMesh`,
 * attached under the scan's root so the transform gizmo and the visibility
 * toggle apply for free. The only new thing is time.
 *
 * ## Windowed, because GPU memory is the real constraint
 *
 * A `SplatMesh` per timestep holds real GPU buffers. A 24-frame sequence of a
 * detailed person, resident all at once, will not scale — so only a window
 * around the playhead is kept and everything else is disposed. `disposeSplat()`
 * must be called for every evicted frame: leaking one mesh per frame at 5fps
 * loses the tab in under a minute. (`mock-rtc-robustness.spec.ts` exists in this
 * repo because a leak of exactly this shape shipped once.)
 *
 * ## A window miss holds, it does not stall
 *
 * If the frame for the current playhead has not finished loading, the last
 * decoded frame stays visible and the clock keeps running. Stalling makes
 * playback stutter unpredictably; holding degrades smoothly and is visibly
 * honest about what it is doing.
 */
import type { Person4DManifest } from '../world/types'
import { disposeSplat, loadSplat, type LoadedSplat } from './splat-viewer'
import { frameIndexAt, PlaybackClock, windowAround } from './playback-clock'

/**
 * Frames kept resident either side of the playhead.
 *
 * **Adopted, not measured.** Per-frame `SplatMesh` footprint has not been
 * characterised — measure it on the first real sequence and revisit. ±2 gives
 * the loader a frame of lead at 5fps without holding much.
 */
export const WINDOW_RADIUS = 2

export interface Splat4DLayer {
  scanId: string
  frameCount: number
  fps: number
  durationSec: number
  /** Frames the manifest promised that could not be resolved. */
  missingFrames: number
  /** Drive from anything — the internal clock now, 08/0008's scrubber later. */
  setPlayhead(seconds: number): void
  play(): void
  pause(): void
  readonly playing: boolean
  readonly playhead: number
  /** The mesh that should currently be in the scene, or null before first load. */
  readonly currentMesh: LoadedSplat | null
  setVisible(visible: boolean): void
  dispose(): void
}

export interface Splat4DCallbacks {
  /** Called when the visible mesh changes, so the caller can swap it in-scene. */
  onFrame: (mesh: LoadedSplat | null, frameIndex: number) => void
  /** Called when the playhead is waiting on a load. */
  onBuffering?: (buffering: boolean) => void
}

/** Fetch the sequence manifest for a scan, or null when it has no 4D layer. */
export async function fetchPerson4DManifest(scanFilename: string): Promise<Person4DManifest | null> {
  const base = scanFilename.replace(/\.glb$/, '')
  try {
    const res = await fetch(`/scans/${encodeURIComponent(`${base}.4d-capture.manifest.json`)}`)
    if (!res.ok) return null
    const manifest = await res.json() as Person4DManifest
    // Only a completed run has a sequence to play. A skipped one (no GPU host
    // configured) is a perfectly normal state and simply has no layer.
    return manifest.status === 'ok' ? manifest : null
  } catch {
    return null
  }
}

/** URL of one timestep. `.sog` preferred, `.ply` is the fallback the stub writes. */
function frameUrl(base: string, index: number, ext: 'sog' | 'ply'): string {
  return `/scans/${encodeURIComponent(`${base}.4d`)}/frame-${String(index).padStart(5, '0')}.${ext}`
}

/**
 * Create a 4D layer for a scan.
 *
 * Returns null when the scan has no completed sequence.
 */
export async function createSplat4DLayer(
  scanId: string,
  scanFilename: string,
  callbacks: Splat4DCallbacks,
): Promise<Splat4DLayer | null> {
  const manifest = await fetchPerson4DManifest(scanFilename)
  if (!manifest || !manifest.frameCount || manifest.frameCount <= 0) return null

  const base = scanFilename.replace(/\.glb$/, '')
  const frameCount = manifest.frameCount
  const fps = manifest.fps && manifest.fps > 0 ? manifest.fps : 5
  const durationSec = frameCount / fps

  const loaded = new Map<number, LoadedSplat>()
  const pending = new Map<number, Promise<LoadedSplat | null>>()
  const failed = new Set<number>()
  let current: LoadedSplat | null = null
  let currentIndex = -1
  let visible = true
  let disposed = false

  /**
   * Load one frame, trying `.sog` then `.ply`.
   *
   * A frame that resolves to neither is recorded in `failed` rather than
   * retried forever — a partial sequence should play what exists and report the
   * gap, not loop over a silently shorter one.
   */
  async function loadFrame(index: number): Promise<LoadedSplat | null> {
    if (loaded.has(index)) return loaded.get(index)!
    if (failed.has(index)) return null
    const existing = pending.get(index)
    if (existing) return existing

    const attempt = (async () => {
      for (const ext of ['sog', 'ply'] as const) {
        try {
          const mesh = await loadSplat({ kind: 'url', url: frameUrl(base, index, ext) })
          if (disposed) { disposeSplat(mesh); return null }
          mesh.mesh.visible = false
          loaded.set(index, mesh)
          return mesh
        } catch { /* try the next extension */ }
      }
      failed.add(index)
      return null
    })().finally(() => pending.delete(index))

    pending.set(index, attempt)
    return attempt
  }

  /** Evict everything outside the window, disposing each mesh exactly once. */
  function evict(keep: number[]): void {
    const keepSet = new Set(keep)
    for (const [index, mesh] of [...loaded]) {
      if (keepSet.has(index)) continue
      if (mesh === current) continue // never dispose what is on screen
      loaded.delete(index)
      disposeSplat(mesh)
    }
  }

  function show(index: number): void {
    const mesh = loaded.get(index)
    if (!mesh) {
      // Hold the last decoded frame; the clock keeps running.
      callbacks.onBuffering?.(true)
      return
    }
    callbacks.onBuffering?.(false)
    if (current === mesh) return
    if (current) current.mesh.visible = false
    current = mesh
    currentIndex = index
    mesh.mesh.visible = visible
    callbacks.onFrame(mesh, index)
  }

  function setPlayhead(seconds: number): void {
    if (disposed) return
    const index = frameIndexAt(seconds, fps, frameCount)
    const want = windowAround(index, WINDOW_RADIUS, frameCount)
    for (const i of want) void loadFrame(i)
    evict(want)
    show(index)
  }

  const clock = new PlaybackClock({ durationSec, loop: true, onTick: setPlayhead })

  // Prime the window so the first frame is on screen before play is pressed.
  await Promise.all(windowAround(0, WINDOW_RADIUS, frameCount).map(i => loadFrame(i)))
  show(0)

  return {
    scanId,
    frameCount,
    fps,
    durationSec,
    get missingFrames() { return failed.size },
    setPlayhead,
    play: () => clock.play(),
    pause: () => clock.pause(),
    get playing() { return clock.playing },
    get playhead() { return clock.playhead },
    get currentMesh() { return current },
    setVisible(next: boolean) {
      visible = next
      if (current) current.mesh.visible = next
    },
    dispose() {
      disposed = true
      clock.dispose()
      // Every mesh, including the visible one — this is teardown.
      for (const mesh of loaded.values()) disposeSplat(mesh)
      loaded.clear()
      current = null
      currentIndex = -1
      callbacks.onFrame(null, currentIndex)
    },
  }
}
