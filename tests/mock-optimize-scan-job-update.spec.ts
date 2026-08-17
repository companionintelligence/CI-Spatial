/**
 * Legacy 'job-update' event shim — viewer UI update on optimize-scan
 * WorldJob transitions (docs/factory/01-merge-jobs/0004).
 *
 * Verifies the viewer's existing `'job-update'` handling path
 * (`src/viewer/viewer.ts`'s `handleJobUpdate`, wired in `connectServerEvents`)
 * still fires and updates the scan-status chip with *no viewer-side code
 * changes*, now that the event is sourced from a translated `optimize-scan`
 * `WorldJob` (`main.ts`'s `broadcastLegacyJobUpdate` / `worldJobToLegacyJob`)
 * instead of the retiring `JobQueue._emit()` path. This is ticket 0004's
 * second Acceptance Criterion: "Given the desktop viewer open during a scan
 * upload, when optimization completes, then the viewer's UI updates exactly
 * as it did before this wave."
 *
 * Requirements: Vite dev server (VITE_URL) + Deno server (API_URL), both
 * pointed at the same 'default' world.
 * Run:
 *   API_URL=http://localhost:8000 VITE_URL=https://localhost:5173 \
 *     npx playwright test --project=chromium-mock mock-optimize-scan-job-update
 */
import { test, expect } from '@playwright/test'

const API_URL = process.env['API_URL'] ?? ''

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

/**
 * Budget for "an optimize-scan job I just enqueued reaches a terminal state".
 *
 * Generous on purpose. ADR 0003's single-flight execution is *global* — one
 * WorldJob processes at a time across every world — so this job's latency is
 * the queue ahead of it, not its own work (the GLB below is ~50 bytes). Run
 * alone, the whole spec takes ~2s; run as part of `npm run test:box`, the
 * api project is concurrently uploading ~48 scans that each enqueue an
 * optimize job, and a 20s budget expired here with the job still 'queued'.
 * Waiting longer costs nothing on a quiet queue.
 */
const JOB_SETTLE_TIMEOUT_MS = 120_000

test.describe('optimize-scan job-update event drives the viewer UI', () => {
  test.skip(!API_URL, 'requires API_URL — set to a directly reachable Deno server')
  test.setTimeout(JOB_SETTLE_TIMEOUT_MS * 2)

  test('re-optimizing a scan while the viewer is open updates the scan-status chip live', async ({ page, request }) => {
    const filename = `job-update-${Date.now()}.glb`
    const upResp = await request.post(`${API_URL}/upload-scan`, {
      multipart: {
        file: { name: filename, mimeType: 'model/gltf-binary', buffer: makeMinimalGlb() },
        metadata: JSON.stringify({ detectionCount: 0, labels: [], exportedAt: new Date().toISOString() }),
      },
    })
    expect(upResp.ok()).toBeTruthy()
    const { filename: storedFilename } = await upResp.json() as { filename: string }

    // Let the upload's own optimize-scan job settle before the test's own
    // re-optimize call, so the chip transitions asserted below belong to the
    // SECOND job, not a race against the first. This wait is load-bearing:
    // dedupe (ADR 0003) would otherwise hand the re-optimize POST back the
    // still-pending first job, and its completion event could land before
    // the viewer is even open.
    await expect.poll(async () => {
      const scans = await (await request.get(`${API_URL}/scans`)).json() as
        Array<{ filename: string; job: { status: string } | null }>
      return scans.find((s) => s.filename === storedFilename)?.job?.status
    }, {
      timeout: JOB_SETTLE_TIMEOUT_MS,
      message: 'upload\'s optimize-scan job never reached "done" — is the shared job queue backed up?',
    }).toBe('done')

    page.on('pageerror', (err) => console.error('[page]', err))
    await page.goto('/viewer.html?world=default')

    const scanItem = page.locator('.scan-item')
      .filter({ has: page.locator(`.scan-name[title="${storedFilename}"]`) })
    await expect(scanItem).toBeVisible({ timeout: 30_000 })
    const statusEl = scanItem.locator('.scan-status')

    // Re-optimize while the viewer's /events WebSocket is live-connected —
    // the resulting 'job-update' transitions (queued -> running -> done)
    // must reach handleJobUpdate() and update this chip with no reload.
    const reoptResp = await request.post(`${API_URL}/scans/${encodeURIComponent(storedFilename)}/optimize`)
    expect(reoptResp.ok()).toBeTruthy()

    // Same queue, same reason for the budget: the re-optimize job waits its
    // turn behind whatever else is in flight before it can emit 'done'.
    await expect(statusEl).toContainText(/Optimized -/, { timeout: JOB_SETTLE_TIMEOUT_MS })
  })
})
