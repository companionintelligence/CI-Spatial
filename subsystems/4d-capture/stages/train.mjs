/**
 * Stage 3 — one Gaussian splat per timestep.
 *
 * Reuses the conventions `server/splat/splat_train.ts` and
 * `splat_train_dataset.ts` already pin, because getting them wrong produces a
 * plausible-looking but wrong splat:
 *
 *  - Nerfstudio `transforms.json` + `images/` (+ optional `sparse_pc.ply`)
 *  - **No axis flip.** Companion-Scan / WebXR / three.js poses are already in
 *    the OpenGL/Blender camera-to-world convention Nerfstudio expects. This is
 *    the single easiest thing to get wrong here.
 *  - GPU selection is an env var, not a flag: `CUBECL_WGPU_DEFAULT_DEVICE`.
 *
 * The one deliberate divergence is iteration count. A static scan trains at
 * 15000; here that is multiplied by the timestep count, so it defaults far
 * lower. Sequence length × iterations is the pipeline's whole cost budget.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Lower than a static scan's 15000 — this is paid once per timestep. */
export const DEFAULT_TRAIN_ITERS = 3000

/**
 * Nerfstudio transforms for one frame set.
 *
 * No axis flip, and real image dimensions must be supplied by the caller — the
 * dataset builder in the main repo reads them from the JPEG SOF marker rather
 * than trusting recorded metadata, because phone downscaling makes recorded
 * dims drift.
 */
export function buildTransforms(frameSet, { width, height, fovYDeg }) {
  const fl_y = (height / 2) / Math.tan((fovYDeg * Math.PI) / 180 / 2)
  return {
    camera_model: 'OPENCV',
    fl_x: fl_y,
    fl_y,
    cx: width / 2,
    cy: height / 2,
    w: width,
    h: height,
    frames: frameSet.views.map(v => ({
      file_path: `images/view-${String(v.viewIndex).padStart(3, '0')}.jpg`,
      // Camera-to-world, unflipped — see the module header.
      transform_matrix: v.matrix ?? IDENTITY,
    })),
  }
}

const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
]

/** Brush CLI args. Pure, so the assembly is testable without the binary. */
export function buildBrushArgs({ datasetDir, exportDir, trainIters, shDegree = 2, maxResolution = 1280 }) {
  return [
    datasetDir,
    '--export-path', exportDir,
    '--total-steps', String(trainIters),
    '--sh-degree', String(shDegree),
    '--max-resolution', String(maxResolution),
  ]
}

/** Write a Nerfstudio dataset directory for one timestep. */
export async function writeDataset(dir, frameSet, intrinsics) {
  await mkdir(path.join(dir, 'images'), { recursive: true })
  await writeFile(
    path.join(dir, 'transforms.json'),
    JSON.stringify(buildTransforms(frameSet, intrinsics), null, 2),
  )
  return dir
}

/**
 * Train one timestep.
 *
 * A missing Brush binary is `skipped`, not an error — same contract as every
 * other optional GPU tool in this system.
 */
export async function trainTimestep({ datasetDir, exportDir, env = process.env, spawnFn = spawn }) {
  const bin = env.BRUSH_BIN || `${env.HOME ?? '~'}/brush/src/target/release/brush-cli`
  const trainIters = Number(env.BRUSH_TRAIN_ITERS) > 0 ? Number(env.BRUSH_TRAIN_ITERS) : DEFAULT_TRAIN_ITERS
  const args = buildBrushArgs({ datasetDir, exportDir, trainIters })

  const result = await new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, {
      // The GPU pin is an env var, not a flag.
      env: { ...env, CUBECL_WGPU_DEFAULT_DEVICE: env.BRUSH_DEVICE || 'DiscreteGpu(1)' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', d => { stderr += String(d) })
    child.on('error', err => resolve({ code: -1, stderr: String(err) }))
    child.on('close', code => resolve({ code, stderr }))
  })

  if (result.code === -1) {
    return { status: 'skipped', remediation: `Build Brush and set BRUSH_BIN (looked for ${bin})` }
  }
  if (result.code !== 0) {
    return { status: 'error', error: `brush exited ${result.code}: ${String(result.stderr).slice(-300)}` }
  }
  return { status: 'ok', exportDir }
}
