/**
 * Take orchestration: densify (or not) → frame sets → per-timestep train.
 *
 * Every stage returns `ok` / `skipped` / `error` and the whole run always ends
 * with a result object, because the appliance maps those straight through:
 * `skipped` becomes a *green* job with a remediation hint, never a red one.
 * That contract is what lets a Companion Scan install work with no GPU host
 * attached at all.
 */
import path from 'node:path'
import { densify } from '../stages/densify.mjs'
import { bestClip, choosePath, planFrameSets } from '../stages/frameset.mjs'
import { runStub } from '../stages/stub.mjs'
import { trainTimestep, writeDataset } from '../stages/train.mjs'

export async function runTake(take, opts = {}) {
  const { workDir, env = process.env, stub = false, onProgress = () => {} } = opts
  const sequenceDir = path.join(workDir, take.takeId, 'sequence')
  const clips = take.clips ?? []

  if (clips.length === 0) {
    return { status: 'error', error: 'take has no clips' }
  }

  if (stub) {
    onProgress(0.5, 'stub')
    const result = await runStub({
      takeId: take.takeId,
      sequenceDir,
      fps: take.params?.timestepFps ?? 5,
      clipCount: clips.length,
    })
    onProgress(1, 'done')
    return result
  }

  // Which path, and why. Recorded rather than decided silently — a take that
  // *could* have been multi-camera and was densified instead is a fact the
  // operator should be able to see.
  const decision = choosePath(clips)
  onProgress(0.05, `path: ${decision.viewSource}`)

  let views
  let durationMs = Math.max(...clips.map(c => c.durationMs ?? 0), 0)

  if (decision.viewSource === 'densified') {
    const clip = bestClip(clips)
    onProgress(0.1, 'densify')
    const out = await densify({
      clipPath: clip.localPath,
      viewsPerLayer: take.params?.viewsPerLayer ?? 6,
      env,
      workDir,
    })
    if (out.status !== 'ok') {
      // Skip and error both propagate verbatim — the appliance distinguishes them.
      return { ...out, takeId: take.takeId, clipCount: clips.length }
    }
    views = (out.cameras?.cameras ?? out.cameras ?? []).map((cam, i) => ({
      source: path.join(out.denseDir, `${String(i).padStart(2, '0')}.mp4`),
      pose: cam,
    }))
  } else {
    // Real cameras: each clip contributes one view, already in a shared frame
    // because every device calibrated against the same two ground markers.
    views = clips.map(c => ({
      source: c.localPath,
      pose: c.pose ?? null,
      offsetMs: c.sync?.method === 'measured' ? -(c.sync.offsetMs ?? 0) : 0,
    }))
  }

  const frameSets = planFrameSets({
    views,
    durationMs,
    timestepFps: take.params?.timestepFps ?? 5,
  })
  onProgress(0.25, `${frameSets.length} timesteps`)

  let trained = 0
  for (const frameSet of frameSets) {
    const datasetDir = path.join(workDir, take.takeId, `t-${String(frameSet.index).padStart(5, '0')}`)
    await writeDataset(datasetDir, frameSet, { width: 1080, height: 1920, fovYDeg: 60 })
    const out = await trainTimestep({ datasetDir, exportDir: sequenceDir, env })
    if (out.status === 'skipped') {
      return { ...out, takeId: take.takeId, clipCount: clips.length }
    }
    if (out.status === 'error') {
      return { ...out, takeId: take.takeId, clipCount: clips.length }
    }
    trained++
    onProgress(0.25 + (trained / frameSets.length) * 0.7, `trained ${trained}/${frameSets.length}`)
  }

  onProgress(1, 'done')
  return {
    status: 'ok',
    takeId: take.takeId,
    viewSource: decision.viewSource,
    pathReason: decision.reason,
    degraded: decision.degraded ?? false,
    clipCount: clips.length,
    viewCount: views.length,
    frameCount: frameSets.length,
    fps: take.params?.timestepFps ?? 5,
    durationMs,
    sequenceDir,
  }
}
