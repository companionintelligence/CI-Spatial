/**
 * Stage 1 — view densification via 4DAnyone.
 *
 * Runs only when a take has a single clip. With N real cameras the views
 * already exist and this stage is skipped entirely, which is the whole reason
 * the frame set (not 4DAnyone's output) is the pipeline's contract.
 *
 * 4DAnyone's CLI and output layout are pinned from its README (upstream
 * ant-research/4DAnyone). The arg builder is pure so it is testable without a
 * GPU; the run itself is not verifiable here — see this subsystem's README
 * under "Confidence levels".
 */
import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 4DAnyone requires `views_per_layer` to be divisible by 4 or 6.
 *
 * Validated before spawning because a bad value fails deep inside the model,
 * minutes into a run, with an error that does not name the cause.
 */
export function isValidViewsPerLayer(n) {
  return Number.isInteger(n) && n > 0 && (n % 4 === 0 || n % 6 === 0)
}

/**
 * Assemble the inference command. Pure — no filesystem, no spawn.
 *
 * Flags are exactly those the README documents: `--video_path`,
 * `--views_per_layer`, `--layer_pitches`, `--start_yaw`, `--yaw_span`,
 * `--data_dir`. Order is stable so the test can assert on it.
 */
export function buildDensifyArgs({ videoPath, viewsPerLayer, dataDir, layerPitches, startYaw, yawSpan }) {
  const args = ['inference.py', '--video_path', videoPath, '--views_per_layer', String(viewsPerLayer)]
  if (dataDir) args.push('--data_dir', dataDir)
  if (layerPitches) args.push('--layer_pitches', JSON.stringify(layerPitches))
  if (typeof startYaw === 'number') args.push('--start_yaw', String(startYaw))
  if (typeof yawSpan === 'number') args.push('--yaw_span', String(yawSpan))
  return args
}

/**
 * Parse 4DAnyone's output directory.
 *
 * The expected shape is validated explicitly rather than globbed, so an
 * upstream layout change fails with a message naming what was missing instead
 * of silently producing an empty sequence.
 */
export async function readDensifyOutput(clipOutDir) {
  const camerasPath = path.join(clipOutDir, 'cameras.json')
  const metadataPath = path.join(clipOutDir, 'metadata.json')
  const densePath = path.join(clipOutDir, 'videos', 'dense')

  for (const [label, p] of [['cameras.json', camerasPath], ['videos/dense/', densePath]]) {
    try {
      await access(p)
    } catch {
      throw new Error(`4DAnyone output is missing ${label} (looked in ${clipOutDir})`)
    }
  }

  const cameras = JSON.parse(await readFile(camerasPath, 'utf8'))
  let metadata = {}
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch { /* metadata is informational */ }

  return { cameras, metadata, denseDir: densePath }
}

/**
 * Run densification for one clip.
 *
 * Returns `{ status: 'skipped' }` with remediation when 4DAnyone is not
 * configured — never an error. The appliance maps that straight through to a
 * green job with a hint.
 */
export async function densify({ clipPath, viewsPerLayer, env = process.env, workDir, spawnFn = spawn }) {
  const dir = env.FDANYONE_DIR
  if (!dir) {
    return {
      status: 'skipped',
      remediation: 'FDANYONE_DIR is not set — install 4DAnyone on a CUDA host with ~44 GiB and set it (see README)',
    }
  }
  if (!isValidViewsPerLayer(viewsPerLayer)) {
    return { status: 'error', error: `views_per_layer must be divisible by 4 or 6 (got ${viewsPerLayer})` }
  }

  const python = env.FDANYONE_PYTHON || 'python3'
  const dataDir = path.join(workDir, 'fdanyone')
  const args = buildDensifyArgs({ videoPath: clipPath, viewsPerLayer, dataDir })

  const code = await new Promise((resolve, reject) => {
    const child = spawnFn(python, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', d => { stderr += String(d) })
    child.on('error', reject)
    child.on('close', c => resolve({ code: c, stderr }))
  })

  if (code.code !== 0) {
    return { status: 'error', error: `4DAnyone exited ${code.code}: ${String(code.stderr).slice(-500)}` }
  }

  const clipName = path.basename(clipPath, path.extname(clipPath))
  const out = await readDensifyOutput(path.join(dataDir, clipName))
  return { status: 'ok', ...out }
}
