/**
 * `POST`/`GET /projects/:id/reference-photos` — the server half of wave 09
 * ticket 0007, against a live Deno server.
 *
 *   API_URL=http://localhost:8000 npx playwright test --project=api reference-photos
 *
 * Path safety and body validation are proved unit-wise in
 * `tests/unit/deno/reference_photos.test.ts`; this file proves the routes are
 * actually wired to that logic and that the bytes survive a round trip. The
 * split matches how `/sessions/:id/keyframes` is covered — its validation is
 * shape-only, and its behaviour is exercised through `api-*` specs like this.
 *
 * Every test creates and deletes its own Place. Reference photos are keyed by
 * Place and role, so a shared fixture would let one test's bytes satisfy
 * another's readback.
 */
import { test, expect, type APIRequestContext } from '@playwright/test'

const API = process.env['API_URL'] ?? 'http://localhost:8000'

// A 1x1 white JPEG — a real image, no fixture file. Same trick, and the same
// literal, as api-house-readiness.spec.ts.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////' +
  '////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z',
  'base64',
)

const VALID_META = {
  role: 'landmark',
  tapPoint: { x: 0.42, y: 0.71 },
  pose: { position: { x: 1, y: 0, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-08-25T10:00:00.000Z',
}

function multipart(meta: unknown, image: Buffer | null = TINY_JPEG) {
  const body: Record<string, unknown> = {}
  if (image) body['image'] = { name: 'ref.jpg', mimeType: 'image/jpeg', buffer: image }
  if (meta !== undefined) body['meta'] = typeof meta === 'string' ? meta : JSON.stringify(meta)
  return { multipart: body as never }
}

async function createPlace(request: APIRequestContext, label: string): Promise<string> {
  const res = await request.post(`${API}/projects`, {
    data: { name: `zz-refphoto-${label}-${Date.now()}`, placeType: 'room' },
  })
  expect(res.ok(), `POST /projects failed: ${res.status()}`).toBeTruthy()
  const body = await res.json()
  return body.project?.projectId ?? body.projectId
}

test.describe('project reference photos', () => {
  test('POST stores a photo and returns the URL that serves it back', async ({ request }) => {
    const id = await createPlace(request, 'roundtrip')
    try {
      const post = await request.post(`${API}/projects/${id}/reference-photos`, multipart(VALID_META))
      expect(post.status(), await post.text()).toBe(200)
      const body = await post.json() as { ok: boolean; role: string; url: string }
      expect(body.ok).toBe(true)
      expect(body.role).toBe('landmark')
      expect(body.url).toBe(`/projects/${id}/reference-photos/ref-landmark.jpg`)

      const get = await request.get(`${API}${body.url}`)
      expect(get.status()).toBe(200)
      expect(get.headers()['content-type']).toContain('image/jpeg')
      // The exact bytes, not merely "some image": a truncated or re-encoded
      // photo would still render and still be wrong.
      expect(Buffer.from(await get.body()).equals(TINY_JPEG)).toBeTruthy()
    } finally {
      await request.delete(`${API}/projects/${id}`).catch(() => {})
    }
  })

  test('the two roles are stored separately, and re-posting replaces rather than appends', async ({ request }) => {
    const id = await createPlace(request, 'roles')
    try {
      for (const role of ['landmark', 'headingMarker']) {
        const res = await request.post(`${API}/projects/${id}/reference-photos`, multipart({ ...VALID_META, role }))
        expect(res.status(), await res.text()).toBe(200)
        expect((await res.json()).url).toContain(`ref-${role}.jpg`)
      }

      // Re-calibration must leave two photos, not four. The filename is derived
      // from the role for exactly this reason.
      const again = await request.post(`${API}/projects/${id}/reference-photos`, multipart(VALID_META))
      expect(again.status()).toBe(200)
      expect((await again.json()).url).toBe(`/projects/${id}/reference-photos/ref-landmark.jpg`)

      for (const role of ['landmark', 'headingMarker']) {
        const get = await request.get(`${API}/projects/${id}/reference-photos/ref-${role}.jpg`)
        expect(get.status(), `GET ref-${role}.jpg`).toBe(200)
      }
    } finally {
      await request.delete(`${API}/projects/${id}`).catch(() => {})
    }
  })

  test('POST rejects a missing image, a missing or invalid meta, and an unknown role', async ({ request }) => {
    const id = await createPlace(request, 'reject')
    try {
      const noImage = await request.post(`${API}/projects/${id}/reference-photos`, multipart(VALID_META, null))
      expect(noImage.status()).toBe(400)
      expect((await noImage.json()).error).toContain('image')

      const noMeta = await request.post(`${API}/projects/${id}/reference-photos`, multipart(undefined))
      expect(noMeta.status()).toBe(400)

      const badJson = await request.post(`${API}/projects/${id}/reference-photos`, multipart('{nope'))
      expect(badJson.status()).toBe(400)
      expect((await badJson.json()).error).toContain('JSON')

      const badRole = await request.post(
        `${API}/projects/${id}/reference-photos`,
        multipart({ ...VALID_META, role: 'origin' }),
      )
      expect(badRole.status()).toBe(400)
      expect((await badRole.json()).error).toContain('role')

      // The tap point is the whole reason the photo is useful; an out-of-range
      // crosshair points at nothing while still looking authoritative.
      const badTap = await request.post(
        `${API}/projects/${id}/reference-photos`,
        multipart({ ...VALID_META, tapPoint: { x: 1.4, y: 0.5 } }),
      )
      expect(badTap.status()).toBe(400)
      expect((await badTap.json()).error).toContain('tapPoint')
    } finally {
      await request.delete(`${API}/projects/${id}`).catch(() => {})
    }
  })

  test('an unknown Place and a malformed Place id are both refused', async ({ request }) => {
    const missing = await request.post(`${API}/projects/proj-000000000/reference-photos`, multipart(VALID_META))
    expect(missing.status()).toBe(404)

    const malformed = await request.post(`${API}/projects/not-a-place/reference-photos`, multipart(VALID_META))
    expect(malformed.status()).toBe(400)
  })

  test('GET refuses traversal in :file and reports a genuinely absent photo as 404', async ({ request }) => {
    const id = await createPlace(request, 'traversal')
    try {
      for (
        const file of [
          '..%2F..%2Fprojects.json',
          '..%2Fprojects.json',
          'ref-landmark.jpeg',
          'reference-photos.json',
          'ref-other.jpg',
        ]
      ) {
        const res = await request.get(`${API}/projects/${id}/reference-photos/${file}`)
        expect(res.status(), `GET ${file} must not serve`).toBe(400)
      }

      // A well-formed name for a photo that was never posted is a 404, not a
      // 400 — the two failures mean different things to the client, which is
      // what lets the panel say "never uploaded" instead of "broken".
      const absent = await request.get(`${API}/projects/${id}/reference-photos/ref-headingMarker.jpg`)
      expect(absent.status()).toBe(404)
    } finally {
      await request.delete(`${API}/projects/${id}`).catch(() => {})
    }
  })
})
