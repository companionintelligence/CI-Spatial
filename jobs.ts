/**
 * JobQueue — minimal persistent job runner for the single-tenant scan server.
 *
 * Jobs are processed sequentially by one in-process worker (the box also runs
 * VLM inference, so CPU-bound concurrency of 1 is deliberate).  State is
 * persisted to <scansDir>/jobs.json on every transition, and jobs that were
 * `running` when the process died are re-queued on startup.
 *
 * Job type `optimize-scan`: runs pipeline.ts on a stored .glb and writes
 *   <base>.opt.glb            quantized (+Draco) full-quality scan
 *   <base>.lodN.glb           voxel-downsampled point-cloud previews
 *   <base>.manifest.json      artifact index + stats + per-stage log
 */
import { optimizeScan } from './pipeline.ts'

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface Job {
  id: string
  type: 'optimize-scan'
  /** Scan filename inside the scans directory */
  target: string
  status: JobStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  note?: string
}

export interface ScanManifest {
  source: string
  createdAt: string
  stats: Record<string, number>
  stages: Array<{ name: string; ok: boolean; ms: number; note?: string }>
  artifacts: {
    optimized: { filename: string; bytes: number; draco: boolean; quantized: boolean }
    /** Coarsest first — viewer loads lods[0] as the instant preview */
    lods: Array<{ filename: string; bytes: number; points: number; voxelM: number }>
  }
}

const MAX_JOB_HISTORY = 200

export class JobQueue {
  private _jobs: Job[] = []
  private _working = false

  constructor(
    private readonly scansDir: string,
    private readonly onEvent: (event: Record<string, unknown>) => void = () => {},
  ) {}

  get jobs(): Job[] {
    return this._jobs
  }

  job(id: string): Job | undefined {
    return this._jobs.find((j) => j.id === id)
  }

  /** Latest job for a given scan filename (any status). */
  jobForTarget(target: string): Job | undefined {
    for (let i = this._jobs.length - 1; i >= 0; i--) {
      if (this._jobs[i].target === target) return this._jobs[i]
    }
    return undefined
  }

  async init(): Promise<void> {
    try {
      const raw = await Deno.readTextFile(this._stateFile())
      this._jobs = JSON.parse(raw) as Job[]
      // Re-queue work interrupted by a previous shutdown
      for (const job of this._jobs) {
        if (job.status === 'running') {
          job.status = 'queued'
          job.note = 'requeued after restart'
        }
      }
    } catch {
      this._jobs = []
    }
    void this._pump()
  }

  enqueue(type: Job['type'], target: string): Job {
    const existing = this._jobs.find(
      (j) => j.type === type && j.target === target &&
        (j.status === 'queued' || j.status === 'running'),
    )
    if (existing) return existing

    const job: Job = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      target,
      status: 'queued',
      createdAt: new Date().toISOString(),
    }
    this._jobs.push(job)
    if (this._jobs.length > MAX_JOB_HISTORY) {
      this._jobs = this._jobs.filter((j) => j.status === 'queued' || j.status === 'running')
        .concat(this._jobs.filter((j) => j.status === 'done' || j.status === 'error').slice(-MAX_JOB_HISTORY / 2))
    }
    void this._persist()
    this._emit(job)
    void this._pump()
    return job
  }

  // ── Worker loop ─────────────────────────────────────────────────────────────

  private async _pump(): Promise<void> {
    if (this._working) return
    this._working = true
    try {
      for (;;) {
        const job = this._jobs.find((j) => j.status === 'queued')
        if (!job) break

        job.status = 'running'
        job.startedAt = new Date().toISOString()
        await this._persist()
        this._emit(job)

        try {
          await this._runOptimize(job)
          job.status = 'done'
        } catch (e) {
          job.status = 'error'
          job.error = e instanceof Error ? e.message : String(e)
          console.error(`[jobs] ${job.id} failed:`, job.error)
        }
        job.finishedAt = new Date().toISOString()
        await this._persist()
        this._emit(job)
      }
    } finally {
      this._working = false
    }
  }

  private async _runOptimize(job: Job): Promise<void> {
    const sourcePath = `${this.scansDir}/${job.target}`
    const glb = await Deno.readFile(sourcePath)
    console.log(`[jobs] optimizing ${job.target} (${(glb.byteLength / 1024).toFixed(0)} KB)`)

    const result = await optimizeScan(glb)
    const base = job.target.replace(/\.glb$/, '')

    const optimizedName = `${base}.opt.glb`
    await Deno.writeFile(`${this.scansDir}/${optimizedName}`, result.optimized.bytes)

    // pipeline returns coarsest-first; name finest as lod1, coarser as lod2…
    const lodEntries: ScanManifest['artifacts']['lods'] = []
    const finestFirst = [...result.lods].sort((a, b) => (a.voxelM ?? 0) - (b.voxelM ?? 0))
    for (let i = 0; i < finestFirst.length; i++) {
      const lod = finestFirst[i]
      const filename = `${base}.lod${i + 1}.glb`
      await Deno.writeFile(`${this.scansDir}/${filename}`, lod.bytes)
      lodEntries.push({
        filename,
        bytes: lod.bytes.byteLength,
        points: lod.points ?? 0,
        voxelM: lod.voxelM ?? 0,
      })
    }
    lodEntries.sort((a, b) => b.voxelM - a.voxelM) // coarsest first for the manifest

    const manifest: ScanManifest = {
      source: job.target,
      createdAt: new Date().toISOString(),
      stats: result.stats as unknown as Record<string, number>,
      stages: result.stages,
      artifacts: {
        optimized: {
          filename: optimizedName,
          bytes: result.optimized.bytes.byteLength,
          draco: result.optimized.draco,
          quantized: result.optimized.quantized,
        },
        lods: lodEntries,
      },
    }
    await Deno.writeTextFile(
      `${this.scansDir}/${base}.manifest.json`,
      JSON.stringify(manifest, null, 2),
    )

    const ratio = result.optimized.bytes.byteLength / glb.byteLength
    job.note = `${(glb.byteLength / 1024).toFixed(0)} KB → ${(result.optimized.bytes.byteLength / 1024).toFixed(0)} KB (${Math.round(ratio * 100)}%)` +
      (lodEntries.length ? ` + ${lodEntries.length} LODs` : '')
    console.log(`[jobs] ${job.target}: ${job.note}`)
  }

  // ── Persistence + events ────────────────────────────────────────────────────

  private _stateFile(): string {
    return `${this.scansDir}/jobs.json`
  }

  private async _persist(): Promise<void> {
    try {
      await Deno.writeTextFile(this._stateFile(), JSON.stringify(this._jobs, null, 2))
    } catch (e) {
      console.error('[jobs] persist failed:', e)
    }
  }

  private _emit(job: Job): void {
    this.onEvent({
      type: 'job-update',
      job: {
        id: job.id,
        jobType: job.type,
        target: job.target,
        status: job.status,
        error: job.error ?? null,
        note: job.note ?? null,
      },
    })
  }
}
