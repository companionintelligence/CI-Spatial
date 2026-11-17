/**
 * SenseNova-Vision worker driver.
 *
 * Keeps the heavyweight Python runtime outside the Deno server process. The
 * worker follows the upstream public entrypoint and produces a structured
 * result even when the optional checkout/model are not installed yet.
 */
import { whichPath } from './exec_probe.ts'
import { sampleEvenly } from './sample_even.ts'
import { budgetFromEnv, runWithDeadline } from './run_with_deadline.ts'

/** One hour: a recon3d pass over eight keyframes is minutes on a GPU. Untuned. */
const DEFAULT_SENSENOVA_TIMEOUT_MS = 60 * 60 * 1000

export type SenseNovaTask = 'recon3d' | 'camera_pose' | 'depth' | 'normal' | 'bbox_detection' | 'pan_seg'

export interface SenseNovaVisionRunOptions {
  sessionDir: string
  outputDir: string
  task: SenseNovaTask
  query?: string
  repoDir?: string
  modelPath?: string
  bashBin?: string
  maxImages?: number
}

export interface SenseNovaVisionResult {
  status: 'ok' | 'skipped' | 'error'
  task: SenseNovaTask
  outputDir: string
  files: string[]
  log: string
  error?: string
  remediation?: string
}

const TASKS = new Set<SenseNovaTask>(['recon3d', 'camera_pose', 'depth', 'normal', 'bbox_detection', 'pan_seg'])

export function senseNovaTask(value: unknown): SenseNovaTask {
  return typeof value === 'string' && TASKS.has(value as SenseNovaTask) ? value as SenseNovaTask : 'recon3d'
}

export async function runSenseNovaVision(opts: SenseNovaVisionRunOptions): Promise<SenseNovaVisionResult> {
  const repoDir = opts.repoDir ?? Deno.env.get('SENSENOVA_DIR') ?? ''
  const modelPath = opts.modelPath ?? Deno.env.get('SENSENOVA_MODEL_PATH') ?? ''
  const bashName = opts.bashBin ?? Deno.env.get('SENSENOVA_BASH') ?? 'bash'
  const launcher = `${repoDir}/scripts/run_sensenova_vision.sh`
  const useWsl = /(?:^|[\\/])wsl(?:\.exe)?$/i.test(bashName)
  const base = { task: opts.task, outputDir: opts.outputDir, files: [] as string[] }

  if (!repoDir || !modelPath) {
    return { ...base, status: 'skipped', log: '', remediation: 'Set SENSENOVA_DIR and SENSENOVA_MODEL_PATH, then install the SenseNova-Vision runtime.' }
  }
  if (!(await exists(launcher))) {
    return { ...base, status: 'skipped', log: '', remediation: `SenseNova launcher not found at ${launcher}.` }
  }
  // A bare name is looked up on PATH, as a shell would. Deno.stat on the bare
  // name checks the server's working directory instead, which is why this
  // driver used to skip on every Linux default (see exec_probe.ts).
  const bashBin = await whichPath(bashName)
  if (!bashBin) {
    // A value with a separator is a path, and PATH was never consulted for it.
    // Naming PATH there would send the operator to a fix they already applied.
    const isPath = /[\\/]/.test(bashName)
    return {
      ...base,
      status: 'skipped',
      log: '',
      remediation: isPath
        ? `SenseNova needs "${bashName}" to run its launcher, but no runnable file exists at that path. ` +
          'Install it, or correct SENSENOVA_BASH.'
        : `SenseNova needs "${bashName}" to run its launcher, but it was not found on PATH. ` +
          'Install it, or set SENSENOVA_BASH to its full path.',
    }
  }
  const images = await sessionImages(opts.sessionDir, opts.maxImages ?? (opts.task === 'recon3d' || opts.task === 'camera_pose' ? 8 : 1))
  if (images.length === 0) {
    return { ...base, status: 'skipped', log: '', remediation: 'This scan has no uploaded keyframes. Capture with keyframe streaming enabled.' }
  }

  await Deno.mkdir(opts.outputDir, { recursive: true })
  const query = opts.query?.trim() || defaultQuery(opts.task)
  const runtimePath = (path: string): string => useWsl ? windowsPathToWsl(path) : path
  const args = useWsl
    ? ['--cd', runtimePath(repoDir), 'bash', runtimePath(launcher), 'inference', opts.task, query, images.map(runtimePath).join(','), '--model_path', runtimePath(modelPath), '--output_dir', runtimePath(opts.outputDir)]
    : [launcher, 'inference', opts.task, query, images.join(','), '--model_path', modelPath, '--output_dir', opts.outputDir]
  try {
    const output = await runWithDeadline(bashBin, {
      args,
      cwd: repoDir,
      env: { MODEL_PATH: runtimePath(modelPath) },
      stdout: 'piped',
      stderr: 'piped',
    }, budgetFromEnv('SENSENOVA_TIMEOUT_MS', DEFAULT_SENSENOVA_TIMEOUT_MS))
    const log = [new TextDecoder().decode(output.stdout), new TextDecoder().decode(output.stderr)].filter(Boolean).join('\n').trim()
    const files = await listFiles(opts.outputDir)
    if (!output.success) {
      const error = output.timeoutReason
        ? `SenseNova ${output.timeoutReason} and was stopped`
        : `SenseNova exited ${output.code}`
      return { ...base, status: 'error', log, error }
    }
    return { ...base, status: 'ok', files, log }
  } catch (error) {
    return { ...base, status: 'error', log: '', error: error instanceof Error ? error.message : String(error) }
  }
}

/** WSL consumes Linux paths even when the Deno coordinator runs on Windows. */
function windowsPathToWsl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized)
  return match ? `/mnt/${match[1]!.toLowerCase()}/${match[2]}` : normalized
}

function defaultQuery(task: SenseNovaTask): string {
  if (task === 'bbox_detection') return 'bed, chair, table, sofa, tv, lamp, door, window'
  if (task === 'pan_seg') return 'floor, wall, ceiling, furniture, door, window'
  return ''
}

async function sessionImages(sessionDir: string, limit: number): Promise<string[]> {
  const entries: Array<{ name: string; path: string }> = []
  try {
    for await (const entry of Deno.readDir(sessionDir)) {
      if (entry.isFile && /\.(jpe?g|png)$/i.test(entry.name)) entries.push({ name: entry.name, path: `${sessionDir}/${entry.name}` })
    }
  } catch { return [] }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name))
  return sampleEvenly(sorted, limit).map(entry => entry.path)
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`
      if (entry.isDirectory) await walk(path)
      else if (entry.isFile) files.push(path)
    }
  }
  try { await walk(dir) } catch { /* missing output is represented by an empty artifact list */ }
  return files
}

async function exists(path: string): Promise<boolean> {
  try { await Deno.stat(path); return true } catch { return false }
}
