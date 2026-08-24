/**
 * SenseNova-Vision worker driver.
 *
 * Keeps the heavyweight Python runtime outside the Deno server process. The
 * worker follows the upstream public entrypoint and produces a structured
 * result even when the optional checkout/model are not installed yet.
 */
import { isRunnable } from './exec_probe.ts'

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
  const bashBin = opts.bashBin ?? Deno.env.get('SENSENOVA_BASH') ?? 'bash'
  const launcher = `${repoDir}/scripts/run_sensenova_vision.sh`
  const useWsl = /(?:^|[\\/])wsl(?:\.exe)?$/i.test(bashBin)
  const base = { task: opts.task, outputDir: opts.outputDir, files: [] as string[] }

  if (!repoDir || !modelPath) {
    return { ...base, status: 'skipped', log: '', remediation: 'Set SENSENOVA_DIR and SENSENOVA_MODEL_PATH, then install the SenseNova-Vision runtime.' }
  }
  if (!(await exists(launcher)) || !(await isRunnable(bashBin))) {
    return { ...base, status: 'skipped', log: '', remediation: `SenseNova launcher or bash is unavailable (${launcher}).` }
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
    const output = await new Deno.Command(bashBin, {
      args,
      cwd: repoDir,
      env: { MODEL_PATH: runtimePath(modelPath) },
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const log = [new TextDecoder().decode(output.stdout), new TextDecoder().decode(output.stderr)].filter(Boolean).join('\n').trim()
    const files = await listFiles(opts.outputDir)
    if (!output.success) return { ...base, status: 'error', log, error: `SenseNova exited ${output.code}` }
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
  return entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit).map(entry => entry.path)
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
