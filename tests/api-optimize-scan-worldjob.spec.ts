/**
 * optimize-scan WorldJob migration (docs/factory/01-merge-jobs/0003) — verifies
 * that uploading a scan through the real `/upload-scan` route now creates a
 * `WorldJob` of type `optimize-scan` (parked under the `'default'` world per
 * ADR 0003's "Which world does an optimize-scan WorldJob belong to?"), that it
 * reaches `completed` with the same artifact filenames the old `jobs.ts`
 * `JobQueue` path produced, and that no legacy `jobs.json` entry is created
 * for it (Acceptance Criteria, ticket 0003).
 *
 * Browser-free (request fixture only). Run under the `api` project against a
 * directly reachable Deno server:
 *
 *   INFERENCE_MODE=mock npm run server
 *   API_URL=http://localhost:8000 npx playwright test --project=api optimize-scan-worldjob
 */
import { test, expect } from '@playwright/test'

const API = process.env['API_URL'] ?? 'http://localhost:8000'

interface WorldJob {
  jobId: string
  worldId: string
  type: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  scanId?: string
  payload?: Record<string, unknown>
  result?: string
  artifacts?: Array<{ type: string; url?: string; label: string }>
  error?: string
}

/** Build a minimal valid GLB buffer (~50 bytes) — same shape tests/server.spec.ts uses */
function makeMinimalGlb(): Buffer {
  const jsonStr = JSON.stringify({ asset: { version: '2.0' } })
  const jsonBytes = Buffer.from(jsonStr, 'utf8')
  const padded = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 0x20)
  jsonBytes.copy(padded)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // magic 'glTF'
  header.writeUInt32LE(2, 4)          // version 2
  header.writeUInt32LE(12 + 8 + padded.length, 8) // total length
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(padded.length, 0)
  chunkHeader.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  return Buffer.concat([header, chunkHeader, padded])
}

test.describe('optimize-scan as a WorldJob', () => {
  test.setTimeout(60_000)

  test('POST /upload-scan creates an optimize-scan WorldJob under the default world, which reaches completed', async ({ request }) => {
    const filename = `worldjob-${Date.now()}.glb`
    const upResp = await request.post(`${API}/upload-scan`, {
      multipart: {
        file: { name: filename, mimeType: 'model/gltf-binary', buffer: makeMinimalGlb() },
        metadata: JSON.stringify({ detectionCount: 0, labels: [], exportedAt: new Date().toISOString() }),
      },
    })
    expect(upResp.ok()).toBeTruthy()
    const upBody = await upResp.json() as { filename: string; job: string }
    expect(upBody.job).toMatch(/^job-/) // WorldJob.jobId, not Job.id — same generation pattern (ADR 0003 field mapping)
    const storedFilename = upBody.filename

    // Poll GET /worlds/default/jobs (not the legacy GET /jobs) for the
    // optimize-scan WorldJob this upload created.
    const deadline = Date.now() + 30_000
    let job: WorldJob | undefined
    while (Date.now() < deadline) {
      const jobs = await (await request.get(`${API}/worlds/default/jobs`)).json() as WorldJob[]
      job = jobs.find((j) => j.type === 'optimize-scan' && j.payload?.['filename'] === storedFilename)
      if (job && (job.status === 'completed' || job.status === 'failed')) break
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(job, 'optimize-scan WorldJob for this upload').toBeTruthy()
    expect(job!.jobId).toBe(upBody.job)
    expect(job!.worldId).toBe('world-default') // ADR 0003: parked under the 'default' world
    expect(job!.scanId).toBeFalsy() // ADR 0003: scanId stays undefined; target lives in payload.filename
    expect(job!.status, job!.error).toBe('completed')
    expect(job!.result).toBeTruthy()

    // Same artifact filenames the old jobs.ts path produced (DoD: byte-identical output).
    const optimized = job!.artifacts?.find((a) => a.url?.endsWith('.opt.glb'))
    expect(optimized?.url).toBe(`/scans/${encodeURIComponent(storedFilename.replace(/\.glb$/, '.opt.glb'))}`)
    const manifest = job!.artifacts?.find((a) => a.url?.endsWith('.manifest.json'))
    expect(manifest?.url).toBe(`/scans/${encodeURIComponent(storedFilename.replace(/\.glb$/, '.manifest.json'))}`)

    const manifestResp = await request.get(`${API}/scans/${encodeURIComponent(storedFilename)}/manifest`)
    expect(manifestResp.ok()).toBeTruthy()

    // Ticket 01-merge-jobs/0004: GET /jobs is now shimmed onto WorldJob data
    // (worldJobToLegacyJob), so this upload's optimize-scan WorldJob shows up
    // there again — translated to the legacy Job shape — even though it was
    // never a jobs.json/JobQueue entry (superseding this test's earlier
    // ticket-0003-era assertion that it would be absent from /jobs).
    const legacyJobs = await (await request.get(`${API}/jobs`)).json() as Array<
      { id: string; type: string; target: string; status: string; note?: string | null }
    >
    const legacyJob = legacyJobs.find((j) => j.target === storedFilename)
    expect(legacyJob, 'shimmed legacy Job for this upload').toBeTruthy()
    expect(legacyJob!.id).toBe(job!.jobId)
    expect(legacyJob!.type).toBe('optimize-scan')
    expect(legacyJob!.status).toBe('done') // WorldJobStatus 'completed' -> legacy 'done'
    expect(legacyJob!.note).toBe(job!.result) // Job.note <- WorldJob.result

    const legacyJobById = await (await request.get(`${API}/jobs/${encodeURIComponent(job!.jobId)}`)).json() as {
      id: string
      target: string
      status: string
    }
    expect(legacyJobById.id).toBe(job!.jobId)
    expect(legacyJobById.target).toBe(storedFilename)
    expect(legacyJobById.status).toBe('done')
  })
})
