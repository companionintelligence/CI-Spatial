/**
 * 4D person capture — the HTTP path end to end (wave 10).
 *
 * The unit suites cover the driver surface, the room rules, sync aggregation
 * and range parsing in isolation. What they cannot cover is that the *routes*
 * actually compose: that a take groups sessions, that a person-mode upload
 * KEEPS its clip where a walkthrough upload deletes it, that the clip is
 * servable with ranges, and that a person-4d job completes green with a
 * remediation hint when no GPU host is configured.
 *
 * That last one is the most important assertion in this file. "No FDANYONE_HOST
 * set" is the expected default state on every machine we own, and it must be a
 * completed job with a hint — never a failed one.
 *
 * Browser-free (request fixture only). Run under the `api` project against a
 * directly reachable Deno server:
 *
 *   INFERENCE_MODE=mock npm run server
 *   API_URL=http://localhost:8000 npx playwright test --project=api person-capture
 */
import { test, expect } from '@playwright/test'

const API = process.env['API_URL'] ?? 'http://localhost:8000'

interface WorldJob {
  jobId: string
  type: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  result?: string
  error?: string
}

/**
 * A tiny but structurally valid MP4.
 *
 * ffmpeg will reject it as undecodable, which is fine and in fact useful: this
 * exercises the storage, take-association and serving path without depending on
 * a real encode. The clip must still be kept on disk either way.
 */
function makeTinyMp4(): Buffer {
  const ftyp = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from('isom'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2mp41'),
  ])
  // Pad so ranged reads have something to slice.
  return Buffer.concat([ftyp, Buffer.alloc(4096, 0x21)])
}

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 40): Promise<T> {
  let last = await fn()
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise(r => setTimeout(r, 250))
    last = await fn()
  }
  return last
}

test.describe('take model', () => {
  test('sessions sharing a takeId are grouped; a solo session is not', async ({ request }) => {
    const takeId = `take-${crypto.randomUUID()}`

    const a = await request.post(`${API}/sessions`, { data: { takeId, clientId: 'client-a' } })
    expect(a.ok()).toBeTruthy()
    const b = await request.post(`${API}/sessions`, { data: { takeId, clientId: 'client-b' } })
    expect(b.ok()).toBeTruthy()
    // A session with no take at all — must not be swept into anyone's take.
    const solo = await request.post(`${API}/sessions`, { data: {} })
    expect(solo.ok()).toBeTruthy()
    const soloBody = await solo.json()
    expect(soloBody.takeId).toBeUndefined()

    const take = await request.get(`${API}/takes/${takeId}`)
    expect(take.ok()).toBeTruthy()
    const body = await take.json()
    expect(body.memberCount).toBe(2)
    const ids = body.sessions.map((s: Record<string, string>) => s.clientId).sort()
    expect(ids).toEqual(['client-a', 'client-b'])
  })

  test('a malformed take id is rejected rather than resolving a path', async ({ request }) => {
    const res = await request.get(`${API}/takes/${encodeURIComponent('take-../etc')}`)
    expect(res.status()).toBe(400)
  })

  test('an unknown but well-formed take is an empty take, not a 404', async ({ request }) => {
    const res = await request.get(`${API}/takes/take-${crypto.randomUUID()}`)
    expect(res.ok()).toBeTruthy()
    expect((await res.json()).memberCount).toBe(0)
  })
})

test.describe('measured clock sync', () => {
  test('a solo take is unsynced with no residual — never a fabricated zero', async ({ request }) => {
    const takeId = `take-${crypto.randomUUID()}`
    await request.post(`${API}/sessions`, { data: { takeId, clientId: 'client-solo' } })

    const res = await request.post(`${API}/takes/${takeId}/sync`, {
      data: { clientId: 'client-solo', offsetMs: 12, sampleCount: 11, expectedMembers: 1 },
    })
    expect(res.ok()).toBeTruthy()
    const { sync } = await res.json()
    expect(sync.method).toBe('unsynced')
    expect(sync.reason).toBe('solo-take')
    // ADR 0005 rule 3: a claim of sync must be backed by a measurement, and one
    // client cannot measure an inter-member residual at all.
    expect(sync.residualMs).toBeUndefined()
    expect(sync.offsetMs).toBeUndefined()
  })

  test('two members produce a measured residual for both, in any report order', async ({ request }) => {
    const takeId = `take-${crypto.randomUUID()}`
    await request.post(`${API}/sessions`, { data: { takeId, clientId: 'client-a' } })
    await request.post(`${API}/sessions`, { data: { takeId, clientId: 'client-b' } })

    // First member reports alone — still unsynced, nothing to compare against.
    const first = await request.post(`${API}/takes/${takeId}/sync`, {
      data: { clientId: 'client-a', offsetMs: 100, sampleCount: 11 },
    })
    expect((await first.json()).sync.method).toBe('unsynced')

    // Second member arrives; the residual is recomputed across both.
    const second = await request.post(`${API}/takes/${takeId}/sync`, {
      data: { clientId: 'client-b', offsetMs: 140, sampleCount: 9 },
    })
    const { sync } = await second.json()
    expect(sync.method).toBe('measured')
    expect(sync.residualMs).toBe(20)
    expect(sync.offsetMs).toBe(140)

    // ...and the first member's stored record was upgraded too, without it
    // having to re-measure.
    const take = await request.get(`${API}/takes/${takeId}`)
    const members = (await take.json()).sessions
    const a = members.find((s: Record<string, unknown>) => s.clientId === 'client-a')
    expect((a.sync as Record<string, unknown>).method).toBe('measured')
    expect((a.sync as Record<string, unknown>).residualMs).toBe(20)
  })
})

test.describe('durable person clips', () => {
  test('a person-mode upload keeps the clip and enqueues no reconstruct job', async ({ request }) => {
    const takeId = `take-${crypto.randomUUID()}`
    const res = await request.post(`${API}/ingest-video`, {
      multipart: {
        video: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: makeTinyMp4() },
        mode: 'person',
        mimeType: 'video/mp4',
        takeId,
        clientId: 'client-a',
        poseTrack: {
          name: 'pose-track.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify({ version: 1, hasArSession: true, frames: [] })),
        },
      },
    })
    expect(res.status()).toBe(202)
    const body = await res.json()

    // No lingbot-map-reconstruct: that job reconstructs a *place*.
    expect(body.jobId).toBeNull()
    expect(body.takeId).toBe(takeId)
    expect(body.clipUrl).toContain('/clip/clip.mp4')

    // The clip survives the request — this is the behaviour that differs from
    // walkthrough mode, where the video is deleted in a `finally`.
    const clip = await request.get(`${API}${body.clipUrl}`)
    expect(clip.ok()).toBeTruthy()
    expect(clip.headers()['content-type']).toBe('video/mp4')
    expect(clip.headers()['accept-ranges']).toBe('bytes')

    // The pose track round-trips.
    const pose = await request.get(`${API}/sessions/${body.sessionId}/pose-track.json`)
    expect(pose.ok()).toBeTruthy()
    expect((await pose.json()).version).toBe(1)
  })

  test('a clip serves ranges — the first ranged route in the codebase', async ({ request }) => {
    const res = await request.post(`${API}/ingest-video`, {
      multipart: {
        video: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: makeTinyMp4() },
        mode: 'person',
        mimeType: 'video/mp4',
      },
    })
    const { clipUrl } = await res.json()

    const partial = await request.get(`${API}${clipUrl}`, { headers: { Range: 'bytes=0-1023' } })
    expect(partial.status()).toBe(206)
    expect(partial.headers()['content-range']).toMatch(/^bytes 0-1023\/\d+$/)
    expect((await partial.body()).byteLength).toBe(1024)

    const unsatisfiable = await request.get(`${API}${clipUrl}`, { headers: { Range: 'bytes=99999999-' } })
    expect(unsatisfiable.status()).toBe(416)
    expect(unsatisfiable.headers()['content-range']).toMatch(/^bytes \*\/\d+$/)
  })

  test('a clip path cannot escape the session directory', async ({ request }) => {
    const res = await request.get(`${API}/sessions/sess-nope/clip/${encodeURIComponent('../../secret')}`)
    expect([400, 404]).toContain(res.status())
  })
})

test.describe('person-4d reconstruction', () => {
  test('with no GPU host configured the job completes GREEN with a hint', async ({ request }) => {
    // The single most important assertion in this file. Unconfigured is the
    // expected state on every machine we own, and it must never be a red job —
    // same contract as BRUSH_BIN and LINGBOT_MAP_*.
    const upload = await request.post(`${API}/ingest-video`, {
      multipart: {
        video: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: makeTinyMp4() },
        mode: 'person',
        mimeType: 'video/mp4',
      },
    })
    expect(upload.status()).toBe(202)
    const { scanId } = await upload.json()

    const enqueued = await request.post(`${API}/worlds/default/jobs`, {
      data: { type: 'person-4d-reconstruct', scanId },
    })
    expect(enqueued.status()).toBe(202)
    const { jobId } = await enqueued.json()

    // Poll the WORLD jobs route, not `/jobs/:id` — that one is the legacy
    // optimize-scan shim and 404s for every other WorldJob type.
    const job = await poll(
      async () => {
        const all = await (await request.get(`${API}/worlds/default/jobs`)).json() as WorldJob[]
        return all.find(j => j.jobId === jobId)
      },
      j => j?.status === 'completed' || j?.status === 'failed',
    )
    expect(job).toBeTruthy()
    if (!job) throw new Error('job vanished')
    expect(job.status).toBe('completed')
    expect(job.error).toBeFalsy()
    expect(job.result ?? '').toMatch(/skipped/i)
    expect(job.result ?? '').toMatch(/FDANYONE_HOST/)
  })

  test('the job type is accepted by the generic job route', async ({ request }) => {
    // WORLD_JOB_TYPES is a hand-maintained Set that is NOT derived from the
    // union, so it silently drifts. This is the assertion that catches that.
    const res = await request.post(`${API}/worlds/default/jobs`, {
      data: { type: 'person-4d-reconstruct' },
    })
    // Accepted (202) — a rejection would be 400 "type must be one of …".
    expect(res.status()).toBe(202)
  })
})
