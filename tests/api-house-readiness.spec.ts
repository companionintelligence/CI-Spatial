/**
 * House-readiness preflight — the green light before the operator walks into the
 * two-story test house with a laptop and phone. Runs against a live Deno server
 * (mock or ollama), one lightweight probe per surface the house protocol leans
 * on, so a broken server is caught at the door instead of on the stairs.
 *
 *   API_URL=http://localhost:8000 npm run test:house
 *
 * The `api` playwright project's testMatch is /api-.*\.spec\.ts/, so this file is
 * named `api-house-readiness.spec.ts`; the `test:house` script filters it by the
 * substring `house-readiness`.
 *
 * Tests are serial and gate on a healthy engine first (test.describe.serial): if
 * the preflight gate fails, the downstream lifecycle checks are meaningless.
 * Live-only surfaces (session write path) clean-skip when the server is missing.
 */
import { test, expect } from '@playwright/test'

const API = process.env['API_URL'] ?? 'http://localhost:8000'
const WORLD = 'default'

// A 1x1 white JPEG (smallest valid keyframe) so the lifecycle check writes one
// real frame without shipping a fixture file.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////' +
  '////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z',
  'base64',
)

interface Health {
  status: string
  model: string
  mode: string
  engineLoadState: string
}

test.describe.serial('house-readiness preflight', () => {
  test.setTimeout(60_000)

  let health: Health | null = null

  test('preflight: server healthy, engine ready, mode ollama|mock', async ({ request }) => {
    const resp = await request.get(`${API}/health`)
    expect(resp.ok(), `GET /health at ${API}`).toBeTruthy()
    health = await resp.json() as Health
    expect(health.status).toBe('ok')
    expect(health.engineLoadState, 'engine must have finished loading').toBe('ready')
    expect(['ollama', 'mock'], `mode was "${health.mode}"`).toContain(health.mode)
  })

  test('session lifecycle: open → keyframe → finalize → readback', async ({ request }) => {
    test.skip(!health, 'preflight failed — server unreachable')

    // Open
    const open = await request.post(`${API}/sessions`)
    expect(open.status(), 'POST /sessions').toBe(201)
    const opened = await open.json() as { sessionId: string }
    const sessionId = opened.sessionId
    expect(sessionId, 'session id shape').toMatch(/^sess-/)

    // One keyframe
    const kf = await request.post(`${API}/sessions/${sessionId}/keyframes`, {
      multipart: {
        image: { name: 'kf-00000.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG },
        meta: JSON.stringify({ index: 0 }),
      },
    })
    expect(kf.ok(), 'POST keyframe').toBeTruthy()
    expect(await kf.json()).toMatchObject({ ok: true, index: 0 })

    // Finalize (no glb — pose-less capture, like a video-ingest session)
    const fin = await request.post(`${API}/sessions/${sessionId}/finalize`, {
      data: {},
      headers: { 'content-type': 'application/json' },
    })
    expect(fin.ok(), 'POST finalize').toBeTruthy()
    const finalized = await fin.json() as { keyframeCount: number; finalizedAt: string }
    expect(finalized.keyframeCount, 'one keyframe counted').toBe(1)
    expect(finalized.finalizedAt).toBeTruthy()

    // Readback
    const got = await request.get(`${API}/sessions/${sessionId}`)
    expect(got.ok(), 'GET session record').toBeTruthy()
    const record = await got.json() as { sessionId: string; keyframeCount: number }
    expect(record.sessionId).toBe(sessionId)
    expect(record.keyframeCount).toBe(1)

    // Cleanup: the server exposes no DELETE /sessions route, so the record is
    // left in the isolated test scans dir (torn down with the mock server).
    // Documented rather than silently leaking against a shared server.
  })

  test('world default has scanner+editor members with tokens REDACTED', async ({ request }) => {
    test.skip(!health, 'preflight failed — server unreachable')
    const resp = await request.get(`${API}/worlds/${WORLD}`)
    expect(resp.ok(), `GET /worlds/${WORLD}`).toBeTruthy()
    const world = await resp.json() as {
      shareSlug: string
      members: Array<{ role: string; token: string }>
    }
    expect(world.shareSlug).toBe(WORLD)
    const roles = world.members.map((m) => m.role)
    expect(roles, 'scanner member present').toContain('scanner')
    expect(roles, 'editor member present').toContain('editor')
    // Privacy: an unauthenticated client must not see raw tokens in the response.
    for (const m of world.members) {
      expect(m.token, `token for ${m.role} must be redacted`).toBe('')
    }
  })

  test('job types splat-train / lingbot-map-reconstruct / splat-detect are known', async ({ request }) => {
    test.skip(!health, 'preflight failed — server unreachable')
    // We probe by POSTing an obviously-incomplete job of each type. The server
    // rejects a truly UNKNOWN type with a 400 whose error lists the valid set;
    // a KNOWN type is accepted (202) — either way, "unknown-type" is the failure
    // we lock against. First confirm the negative: a bogus type IS rejected.
    const bogus = await request.post(`${API}/worlds/${WORLD}/jobs`, {
      data: { type: 'definitely-not-a-real-job-type' },
      headers: { 'content-type': 'application/json' },
    })
    expect(bogus.status(), 'bogus job type rejected 400').toBe(400)
    const bogusBody = await bogus.json() as { error: string }
    expect(bogusBody.error, 'error enumerates valid types').toContain('splat-train')

    for (const type of ['splat-train', 'lingbot-map-reconstruct', 'splat-detect']) {
      const resp = await request.post(`${API}/worlds/${WORLD}/jobs`, {
        data: { type, scanId: 'scan-does-not-exist' },
        headers: { 'content-type': 'application/json' },
      })
      // Whatever the outcome, it must NOT be the unknown-type 400.
      if (resp.status() === 400) {
        const body = await resp.json() as { error: string }
        expect(body.error, `${type} must not be rejected as unknown`).not.toContain('type must be one of')
      } else {
        expect(resp.status(), `${type} accepted as a known job type`).toBe(202)
      }
    }
  })

  test('/ingest-video rejects a bad tiny request (400/413, not 404)', async ({ request }) => {
    test.skip(!health, 'preflight failed — server unreachable')
    // No video field → the route exists and validates (400), proving the route
    // is wired (a missing route would 404). We do NOT upload a real video here.
    const resp = await request.post(`${API}/ingest-video`, {
      multipart: { name: 'nope' },
    })
    expect([400, 413], `status was ${resp.status()}`).toContain(resp.status())
    expect(resp.status(), 'route is wired (not 404)').not.toBe(404)
  })

  test('/ingest-video: a non-multipart body is a clean 400, not a 500', async ({ request }) => {
    test.skip(!health, 'preflight failed — server unreachable')
    // A garbage/non-multipart POST must not blow up formData() parsing into a
    // 500 — the route should catch the parse failure and return a 400.
    const resp = await request.post(`${API}/ingest-video`, {
      data: 'not multipart at all',
      headers: { 'content-type': 'text/plain' },
    })
    expect(resp.status(), `non-multipart POST status was ${resp.status()}`).toBe(400)
    const body = await resp.json() as { error: string; code: string }
    expect(body.code, 'bad-request code').toBe('bad-request')
  })
})
