/**
 * Calibration reference photos — path safety, body validation, and the
 * crosshair projection (wave 09 ticket 0007).
 *
 * The route handlers themselves live in `server/main.ts`, which cannot be
 * imported without running its top-level side effects (hostname resolution,
 * VLM engine load, `Deno.serve`) — the same constraint that put session path
 * resolution in `session_id.ts`. So the two halves that must be *provable*
 * live in `server/project_media.ts` and are tested here directly, and the HTTP
 * surface is covered end-to-end in `tests/api-reference-photos.spec.ts`,
 * matching how `/sessions/:id/keyframes` is already covered.
 *
 * The crosshair cases are the point of the feature, not a detail. A photo
 * without a correctly-placed mark is a vague hint; the ticket's own risk
 * section says a wide shot matched by eye is worth perhaps tens of
 * centimetres. A crosshair that is *wrong* is worse than absent, because the
 * user still trusts it.
 */
// `src/ar/reference-photo.ts` reaches `src/spatial/resolver.ts`, which
// type-imports `src/ar/provider.ts` and its `HTMLCanvasElement`. Deno's default
// libs have no DOM, so the type-check fails on a name the test never uses.
/// <reference lib="dom" />
import { assertEquals, assertAlmostEquals, assert } from 'jsr:@std/assert@^1.0.0'
import {
  PROJECT_ID_RE,
  parseReferencePhotoMeta,
  projectMediaDirPath,
  referencePhotoFileName,
  referencePhotoUrl,
  roleForReferencePhotoFile,
} from '../../../server/project_media.ts'
import {
  imagePointToViewportPoint,
  viewportPointToImagePoint,
} from '../../../src/spatial/resolver.ts'
import {
  referenceCrosshairPixels,
  referencePhotoTitle,
  tapPointWithinPhoto,
} from '../../../src/ar/reference-photo.ts'

const ROOT = '/srv/scans/projects'

// ── Path safety ──────────────────────────────────────────────────────────────

Deno.test('projectMediaDirPath accepts the ids this server actually mints', () => {
  assertEquals(projectMediaDirPath(ROOT, 'proj-default'), `${ROOT}/proj-default`)
  assertEquals(projectMediaDirPath(ROOT, 'proj-1756051200000'), `${ROOT}/proj-1756051200000`)
  assert(PROJECT_ID_RE.test('proj-default'))
})

Deno.test('projectMediaDirPath refuses anything that could leave its parent', () => {
  for (
    const bad of [
      '../../etc',
      'proj-../../etc',
      'proj-a/../../b',
      'proj-.',
      'proj-a/b',
      'proj-a\\b',
      '/proj-a',
      'proj-',
      '',
      null,
      undefined,
    ]
  ) {
    assertEquals(projectMediaDirPath(ROOT, bad as string | null), null, `should reject: ${String(bad)}`)
  }
})

// ── Filename allowlist ───────────────────────────────────────────────────────

Deno.test('only the two names the POST route writes are servable', () => {
  assertEquals(roleForReferencePhotoFile('ref-landmark.jpg'), 'landmark')
  assertEquals(roleForReferencePhotoFile('ref-headingMarker.jpg'), 'headingMarker')
  assertEquals(referencePhotoFileName('landmark'), 'ref-landmark.jpg')
  assertEquals(referencePhotoFileName('headingMarker'), 'ref-headingMarker.jpg')
})

Deno.test('traversal in :file fails by not being on the allowlist', () => {
  for (
    const bad of [
      '../../../etc/passwd',
      '../projects.json',
      'ref-landmark.jpg/../../../etc/passwd',
      'ref-landmark.JPG',
      'ref-landmark.jpeg',
      'reference-photos.json',
      'ref-other.jpg',
      '',
      null,
    ]
  ) {
    assertEquals(roleForReferencePhotoFile(bad as string | null), null, `should reject: ${String(bad)}`)
  }
})

Deno.test('the served URL round-trips back to its role', () => {
  const url = referencePhotoUrl('proj-1756051200000', 'headingMarker')
  assertEquals(url, '/projects/proj-1756051200000/reference-photos/ref-headingMarker.jpg')
  assertEquals(roleForReferencePhotoFile(url.split('/').pop()!), 'headingMarker')
})

// ── meta validation ──────────────────────────────────────────────────────────

const VALID_META = {
  role: 'landmark',
  tapPoint: { x: 0.42, y: 0.71 },
  pose: { position: { x: 1, y: 0, z: -2 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
  capturedAt: '2026-08-25T10:00:00.000Z',
}

function parse(meta: unknown) {
  return parseReferencePhotoMeta(typeof meta === 'string' ? meta : JSON.stringify(meta))
}

Deno.test('parseReferencePhotoMeta accepts a well-formed body', () => {
  const result = parse(VALID_META)
  assert(!('error' in result), `unexpected error: ${JSON.stringify(result)}`)
  assertEquals(result.meta.role, 'landmark')
  assertEquals(result.meta.tapPoint, { x: 0.42, y: 0.71 })
  assertEquals(result.meta.pose.rotation.w, 1)
  assertEquals(result.meta.capturedAt, '2026-08-25T10:00:00.000Z')
})

Deno.test('parseReferencePhotoMeta keeps a trimmed pointLabels description', () => {
  const result = parse({ ...VALID_META, label: '  north door frame  ' })
  assert(!('error' in result))
  assertEquals(result.meta.label, 'north door frame')
})

Deno.test('parseReferencePhotoMeta rejects a missing or unparseable body', () => {
  assertEquals(parseReferencePhotoMeta(null), { error: 'Missing meta field' })
  assertEquals(parseReferencePhotoMeta(undefined), { error: 'Missing meta field' })
  const notJson = parseReferencePhotoMeta('{nope')
  assert('error' in notJson && notJson.error === 'meta is not valid JSON')
})

Deno.test('parseReferencePhotoMeta rejects an unknown role', () => {
  for (const role of ['origin', 'heading', 'Landmark', '', 1, null]) {
    const result = parse({ ...VALID_META, role })
    assert('error' in result, `should reject role: ${String(role)}`)
    assert(result.error.includes('role must be one of'))
  }
})

Deno.test('parseReferencePhotoMeta range-checks tapPoint, not just its type', () => {
  // Out of range is the case that matters: a crosshair drawn from 1.4 lands off
  // the image and points at nothing, while still looking authoritative.
  for (
    const tapPoint of [
      { x: 1.4, y: 0.5 },
      { x: -0.01, y: 0.5 },
      { x: 0.5, y: 2 },
      { x: Number.NaN, y: 0.5 },
      { x: '0.5', y: 0.5 },
      { x: 0.5 },
      null,
    ]
  ) {
    const result = parse({ ...VALID_META, tapPoint })
    assert('error' in result, `should reject tapPoint: ${JSON.stringify(tapPoint)}`)
  }
  // The boundaries themselves are legitimate — a tap at the very edge of the
  // canvas is a real tap.
  for (const tapPoint of [{ x: 0, y: 0 }, { x: 1, y: 1 }]) {
    assert(!('error' in parse({ ...VALID_META, tapPoint })))
  }
})

Deno.test('parseReferencePhotoMeta rejects an incomplete pose', () => {
  for (
    const pose of [
      undefined,
      { position: { x: 0, y: 0, z: 0 } },
      { position: { x: 0, y: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      { position: { x: 0, y: 0, z: Number.POSITIVE_INFINITY }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ]
  ) {
    const result = parse({ ...VALID_META, pose })
    assert('error' in result, `should reject pose: ${JSON.stringify(pose)}`)
  }
})

// ── Crosshair projection ─────────────────────────────────────────────────────

Deno.test('viewportPointToImagePoint inverts imagePointToViewportPoint', () => {
  // A portrait viewport over a landscape camera frame — the real case on a
  // phone, and the one where the two coordinate systems disagree most.
  const frame = { width: 1280, height: 720 }
  const viewport = { width: 390, height: 844 }
  for (const point of [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.9 }, { x: 0, y: 0 }, { x: 1, y: 1 }]) {
    const toImage = viewportPointToImagePoint(point.x, point.y, frame, viewport)
    const back = imagePointToViewportPoint(toImage.x, toImage.y, frame, viewport)
    assertAlmostEquals(back.x, point.x, 1e-9)
    assertAlmostEquals(back.y, point.y, 1e-9)
  }
})

Deno.test('a canvas tap maps inside the cover-cropped frame, off the naive value', () => {
  const frame = { width: 1280, height: 720 }
  const viewport = { width: 390, height: 844 }
  // Cover-crop keeps the full height of the viewport and throws away the sides
  // of a landscape frame, so a centred tap stays centred...
  const centre = tapPointWithinPhoto({ x: 0.5, y: 0.5 }, frame, viewport)
  assert(centre)
  assertAlmostEquals(centre.x, 0.5, 1e-9)
  assertAlmostEquals(centre.y, 0.5, 1e-9)

  // ...but an off-centre tap does not. Storing the raw canvas x here would put
  // the crosshair well off the tapped feature, which is the bug this exists to
  // stop, so the two must genuinely differ.
  const edge = tapPointWithinPhoto({ x: 0.1, y: 0.5 }, frame, viewport)
  assert(edge)
  assert(Math.abs(edge.x - 0.1) > 0.15, `expected a real correction, got ${edge.x}`)
  assert(edge.x >= 0 && edge.x <= 1)
})

Deno.test('tapPointWithinPhoto refuses a correction that lands outside the frame', () => {
  // Degenerate sizes cannot describe a real capture. No crosshair beats one
  // that is confidently wrong.
  assertEquals(tapPointWithinPhoto({ x: 0.5, y: 0.5 }, { width: 0, height: 0 }, { width: 390, height: 844 }), {
    x: 0.5,
    y: 0.5,
  })
  const wild = tapPointWithinPhoto({ x: 2, y: 2 }, { width: 1280, height: 720 }, { width: 390, height: 844 })
  assertEquals(wild, null)
})

Deno.test('referenceCrosshairPixels maps normalised coords onto a rendered size', () => {
  assertEquals(referenceCrosshairPixels({ x: 0, y: 0 }, { width: 320, height: 180 }), { left: 0, top: 0 })
  assertEquals(referenceCrosshairPixels({ x: 1, y: 1 }, { width: 320, height: 180 }), { left: 320, top: 180 })
  assertEquals(referenceCrosshairPixels({ x: 0.25, y: 0.5 }, { width: 320, height: 180 }), { left: 80, top: 90 })
  // Independent of the size it was captured at — that is the whole reason the
  // stored value is normalised.
  assertEquals(referenceCrosshairPixels({ x: 0.25, y: 0.5 }, { width: 640, height: 360 }), { left: 160, top: 180 })
})

Deno.test('referenceCrosshairPixels never emits NaN', () => {
  // CSS drops a NaN length silently, which would pin the crosshair to the
  // photo's top-left corner — confidently wrong rather than visibly broken.
  const unlaidOut = referenceCrosshairPixels({ x: 0.5, y: 0.5 }, { width: 0, height: 0 })
  assertEquals(unlaidOut, { left: 0, top: 0 })
  const bad = referenceCrosshairPixels({ x: Number.NaN, y: Number.NaN }, { width: 320, height: 180 })
  assertEquals(bad, { left: 160, top: 90 })
})

// ── Copy ─────────────────────────────────────────────────────────────────────

Deno.test('the two photos are labelled A and B, because order sets the rotation', () => {
  // Tapping the correct pair in reverse order passes the separation check and
  // rotates the frame exactly 180°. The panel is the only thing that can warn
  // the user, so which photo is which has to be unmistakable.
  assert(referencePhotoTitle('landmark').includes('A'))
  assert(referencePhotoTitle('headingMarker').includes('B'))
  assert(referencePhotoTitle('landmark') !== referencePhotoTitle('headingMarker'))
})
