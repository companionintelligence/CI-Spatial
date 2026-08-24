/**
 * memory_push.test.ts — Companion Memory push contract tests.
 * Run: deno test --allow-net --allow-env --allow-read --allow-write memory_push.test.ts
 *
 * The integration tests run against a stub CI-Server (Deno.serve on a loopback
 * port) implementing POST /files/upload and POST /v1/events, so the multipart
 * shape, the x-api-key header, and the event body are asserted as a real server
 * would see them.
 */
import { Hono } from 'hono'
import {
  configFromEnv,
  pushScanToMemory,
  registerMemoryPush,
  type MemoryPushConfig,
} from '../../../server/memory_push.ts'
import type { ScanManifest } from '../../../src/world/types.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEquals<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(`${msg ?? 'assertEquals'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}

// ── Config ────────────────────────────────────────────────────────────────────

Deno.test('configFromEnv: inert unless BOTH url and token are present', () => {
  const none = configFromEnv(() => undefined)
  assertEquals(none.enabled, false, 'no env = disabled')

  const urlOnly = configFromEnv((k) => (k === 'CI_SERVER_URL' ? 'http://x/api' : undefined))
  assertEquals(urlOnly.enabled, false, 'url without token = disabled')

  const tokenOnly = configFromEnv((k) => (k === 'CI_SERVER_TOKEN' ? 'k' : undefined))
  assertEquals(tokenOnly.enabled, false, 'token without url = disabled')

  const both = configFromEnv((k) => ({
    CI_SERVER_URL: 'http://gateway:8642/api/',
    CI_SERVER_TOKEN: 'secret-key',
  } as Record<string, string>)[k])
  assertEquals(both.enabled, true)
  assertEquals(both.baseUrl, 'http://gateway:8642/api', 'trailing slash stripped')
  assertEquals(both.sourceSystem, 'companion-scan', 'default source system')
})

Deno.test('configFromEnv: whitespace-only values do not enable the integration', () => {
  const cfg = configFromEnv((k) => ({ CI_SERVER_URL: '  ', CI_SERVER_TOKEN: ' ' } as Record<string, string>)[k])
  assertEquals(cfg.enabled, false)
})

// ── Stub CI-Server ────────────────────────────────────────────────────────────

interface Seen {
  uploadAuth?: string | null
  uploadFilename?: string
  uploadBytes?: number
  uploadSkipDescription?: string | null
  eventAuth?: string | null
  eventBody?: {
    events: Array<{
      source_system: string
      source_id: string
      kind: string
      occurred_at: string
      title?: string
      description?: string
      payload: Record<string, unknown>
    }>
  }
}

function stubServer(opts: {
  uploadStatus?: number
  eventStatus?: number
  duplicate?: boolean
  rejectReason?: string
} = {}) {
  const seen: Seen = {}
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const u = new URL(req.url)
    // Path is the API base + route: the gateway strips /api before CI-Server,
    // so the stub accepts either shape.
    if (u.pathname.endsWith('/files/upload') && req.method === 'POST') {
      seen.uploadAuth = req.headers.get('x-api-key')
      if (opts.uploadStatus && opts.uploadStatus >= 400) {
        return new Response('nope', { status: opts.uploadStatus })
      }
      const form = await req.formData()
      const f = form.get('files')
      if (f instanceof File) {
        seen.uploadFilename = f.name
        seen.uploadBytes = (await f.arrayBuffer()).byteLength
      }
      seen.uploadSkipDescription = form.get('skipDescription') as string | null
      return Response.json([{ id: 'file-uuid-1' }])
    }
    if (u.pathname.endsWith('/v1/events') && req.method === 'POST') {
      seen.eventAuth = req.headers.get('x-api-key')
      seen.eventBody = await req.json()
      if (opts.eventStatus && opts.eventStatus >= 400) {
        return new Response('bad request', { status: opts.eventStatus })
      }
      if (opts.rejectReason) {
        return Response.json({ ingested: 0, duplicate: 0, rejected: [{ index: 0, reason: opts.rejectReason }] })
      }
      return Response.json(
        opts.duplicate ? { ingested: 0, duplicate: 1, rejected: [] } : { ingested: 1, duplicate: 0, rejected: [] },
      )
    }
    return new Response('not found', { status: 404 })
  })
  const addr = server.addr as Deno.NetAddr
  return { base: `http://127.0.0.1:${addr.port}/api`, seen, close: () => server.shutdown() }
}

function cfgFor(base: string): MemoryPushConfig {
  return {
    enabled: true,
    baseUrl: base,
    token: 'secret-key',
    sourceSystem: 'companion-scan',
    timeoutMs: 10_000,
    maxUploadBytes: 1024 * 1024,
  }
}

const SCAN: ScanManifest = {
  scanId: 'scan-session-123',
  sessionId: 'session-123',
  filename: 'room.glb',
  name: 'Living Room',
  glbUrl: '/scans/room.glb',
  metadataUrl: '/scans/room.json',
  geoPose: {
    lat: 33.5146,
    lng: -117.7217,
    altitudeM: null,
    bearing: 81.5,
    accuracyM: null,
    fixedAt: '2026-08-01T10:00:00.000Z',
    address: '30872 Calle Moraga, Laguna Niguel, CA',
    displayAddress: '30872 Calle Moraga, Laguna Niguel, Orange County, CA, USA',
  },
  localToWorld: null,
  accuracyM: null,
  capturedAt: '2026-08-01T10:05:00.000Z',
  pointCount: 1303,
  detectionCount: 0,
  layerIndex: [],
  status: 'ready',
} as unknown as ScanManifest

/**
 * Detections sidecar shapes:
 *   'none'   — no sidecar at all (splat-detect never ran)
 *   'legacy' — the label+position-only shape older sidecars carry, and the only
 *              shape this push understood before extents shipped
 *   'full'   — what splat_analyzer actually writes: an oriented 3D box per
 *              object (position/rotation/scale) plus the per-view frames its
 *              clustering voted over
 */
type DetectFixture = 'none' | 'legacy' | 'full'

/** The real run_local.py shape, down to the per-frame `score` the peak comes from. */
const FULL_INTERACTIONS = {
  objects: [
    {
      label: 'sofa',
      position: { x: 1, y: 0, z: 2 },
      rotation: { x: 0, y: 0.7071, z: 0, w: 0.7071 },
      scale: { x: 2.05, y: 0.82, z: 0.94 },
      frames: [
        { frame_idx: 3, box: [0, 0, 100, 100], score: 0.31 },
        { frame_idx: 5, box: [4, 4, 90, 90], score: 0.47 },
        { frame_idx: 9, box: [8, 8, 80, 80], score: 0.22 },
      ],
    },
    {
      label: 'plant',
      position: { x: -1, y: 0, z: 0.5 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 0.4, y: 1.104, z: 0.4 },
      frames: [{ frame_idx: 2, box: [0, 0, 30, 60], score: 0.18 }],
    },
    // No frames — an object-level score is the only confidence on offer.
    { label: 'sofa', position: { x: 3, y: 0, z: 1 }, scale: { x: 1.8, y: 0.8, z: 0.9 }, score: 0.19 },
  ],
  frame_annotations: {},
}

/** What splat_detect.ts lands beside the sidecar; thresholds left at the analyzer's defaults. */
const DETECT_MANIFEST = {
  schemaVersion: 1,
  tool: 'splat-analyzer',
  status: 'ok',
  createdAt: '2026-08-01T11:00:00.000Z',
  interactionsPath: 'room.interactions.json',
  objectCount: 3,
  prompt: 'sofa, chair, table, tv, lamp, plant',
  params: {
    python: '/home/ci/.venvs/splat-analyzer/bin/python',
    detectDir: '/home/ci/splat_analyzer',
    hipVisibleDevices: '1',
    pointSplatSize: '6',
    quality: 'medium',
    renderer: 'point',
  },
  sessionId: 'session-123',
  scanId: 'scan-session-123',
}

/** A scans dir containing room.glb (+ optionally detection sidecars). */
async function tempScans(
  detections: DetectFixture,
  opts: { detectManifest?: boolean; interactions?: unknown } = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: 'memory-push-test-' })
  await Deno.writeFile(`${dir}/room.glb`, new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]))
  if (opts.interactions !== undefined) {
    await Deno.writeTextFile(`${dir}/room.interactions.json`, JSON.stringify(opts.interactions))
  } else if (detections === 'full') {
    await Deno.writeTextFile(`${dir}/room.interactions.json`, JSON.stringify(FULL_INTERACTIONS))
  } else if (detections === 'legacy') {
    await Deno.writeTextFile(
      `${dir}/room.interactions.json`,
      JSON.stringify({
        objects: [
          { label: 'sofa', position: { x: 1, y: 0, z: 2 } },
          { label: 'plant', position: { x: -1, y: 0, z: 0.5 } },
          { label: 'sofa', position: { x: 3, y: 0, z: 1 } },
        ],
      }),
    )
  }
  if (opts.detectManifest) {
    await Deno.writeTextFile(`${dir}/room.splat-detect.manifest.json`, JSON.stringify(DETECT_MANIFEST))
  }
  return dir
}

/** Narrow one wire object out of the event payload. */
function objectsIn(ev: { payload: Record<string, unknown> }): Array<Record<string, unknown>> {
  return ev.payload.objects as Array<Record<string, unknown>>
}

// ── Integration ───────────────────────────────────────────────────────────────

Deno.test('push: uploads the GLB then records a capture.scan event with geo + detections', async () => {
  const srv = stubServer()
  const dir = await tempScans('full', { detectManifest: true })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })

    // Auth: the brokered API key, on BOTH calls.
    assertEquals(srv.seen.uploadAuth, 'secret-key', 'upload sends x-api-key')
    assertEquals(srv.seen.eventAuth, 'secret-key', 'event sends x-api-key')

    // Upload: multipart field `files`, correct filename + bytes.
    assertEquals(srv.seen.uploadFilename, 'room.glb')
    assertEquals(srv.seen.uploadBytes, 8)
    assertEquals(srv.seen.uploadSkipDescription, 'true', 'mesh needs no vision description')
    assertEquals(result.glbFileId, 'file-uuid-1')

    // Event shape.
    const ev = srv.seen.eventBody!.events[0]
    assertEquals(srv.seen.eventBody!.events.length, 1, 'batch of one')
    assertEquals(ev.source_system, 'companion-scan')
    assertEquals(ev.source_id, 'scan-session-123', 'source_id = scanId for idempotency')
    assertEquals(ev.kind, 'capture.scan')
    assertEquals(ev.occurred_at, '2026-08-01T10:05:00.000Z', 'uses capturedAt')
    assert(ev.title!.includes('Living Room'), 'title names the scan')
    assert(ev.title!.includes('Calle Moraga'), 'title carries the place')

    // Geo travels in payload (this endpoint has no top-level geo column).
    const loc = ev.payload.location as Record<string, unknown>
    assertEquals(loc.lat, 33.5146)
    assertEquals(loc.lon, -117.7217, 'lng is mapped to lon')
    assertEquals(loc.address, '30872 Calle Moraga, Laguna Niguel, CA')

    assertEquals(ev.payload.glb_file_id, 'file-uuid-1', 'event references the uploaded file')
    assertEquals(ev.payload.point_count, 1303)
    assertEquals(ev.payload.detection_count, 3)
    assertEquals(JSON.stringify(ev.payload.detected_labels), JSON.stringify(['plant', 'sofa']), 'labels deduped + sorted')
    assertEquals((ev.payload.objects as unknown[]).length, 3)

    assertEquals(result.eventIngested, 1)
    assertEquals(result.detectionCount, 3)
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

// ── Object geometry ───────────────────────────────────────────────────────────
//
// The sidecar's oriented boxes are the only real extents in this system.
// src/export/gltf.ts fabricates its `dimensions` from a 2D bbox fraction times
// hard-coded constants — plausible-looking, invented, and deliberately not a
// source here. These tests pin the real numbers to the wire.

Deno.test('push: each object carries its 3D extent, orientation, confidence and votes', async () => {
  const srv = stubServer()
  const dir = await tempScans('full', { detectManifest: true })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const objects = objectsIn(srv.seen.eventBody!.events[0])
    assertEquals(objects.length, 3)

    const sofa = objects[0]
    assertEquals(sofa.label, 'sofa')
    assertEquals(JSON.stringify(sofa.position), JSON.stringify({ x: 1, y: 0, z: 2 }))
    assertEquals(
      JSON.stringify(sofa.rotation),
      JSON.stringify({ x: 0, y: 0.7071, z: 0, w: 0.7071 }),
      'the box orientation survives the push',
    )
    assertEquals(
      JSON.stringify(sofa.extent_m),
      JSON.stringify({ x: 2.05, y: 0.82, z: 0.94 }),
      'extent is the sidecar scale verbatim, in metres',
    )
    assertEquals(
      JSON.stringify(sofa.extent_mm),
      JSON.stringify({ x: 2050, y: 820, z: 940 }),
      'and in whole millimetres, ready for ci.inventory length_mm/width_mm/height_mm',
    )
    // 0.47 is the best of the three per-view scores, not the first or the mean:
    // it is the value min_peak_score gates on.
    assertEquals(sofa.confidence, 0.47, 'confidence is the peak per-view score')
    assertEquals(sofa.frame_votes, 3, 'frame_votes is what min_votes gates on')

    // 1.104 m rounds to 1104 mm — the mm form is a rounding of the same
    // measurement, never an independent number.
    assertEquals(JSON.stringify(objectsIn(srv.seen.eventBody!.events[0])[1].extent_mm),
      JSON.stringify({ x: 400, y: 1104, z: 400 }))

    // Third object has no frames: the object-level score stands in, and no
    // vote count is invented for it.
    assertEquals(objects[2].confidence, 0.19, 'object-level score is used when there are no frames')
    assertEquals('frame_votes' in objects[2], false, 'no frames means no vote count is invented')

    assertEquals(result.extentCount, 3, 'the result reports how many extents shipped')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: extents travel with their frame of reference and the detector that produced them', async () => {
  const srv = stubServer()
  const dir = await tempScans('full', { detectManifest: true })
  try {
    await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const meta = srv.seen.eventBody!.events[0].payload.object_extents as Record<string, unknown>
    assert(meta, 'extents are qualified, never bare numbers')

    assertEquals(meta.units, 'm')
    assertEquals(meta.frame, 'splat_local', 'the splat frame, not the world/ENU frame in `location`')
    assertEquals(meta.world_frame_aligned, false, 'that alignment is unvalidated (SPLAT_DETECT_ROADMAP phase 3)')
    assertEquals(meta.calibrated, false, 'never validated on a furnished room (phase 1)')
    assert(String(meta.caveat).includes('not measured dimensions'), 'the caveat says what these are not')
    assert(String(meta.convention).includes('box centre'), 'the convention says what position means')

    // The detector's own parameters, so a consumer can tell a default-threshold
    // run from a calibrated one.
    const det = meta.detector as Record<string, unknown>
    assertEquals(det.tool, 'splat-analyzer')
    assertEquals(det.prompt, 'sofa, chair, table, tv, lamp, plant')
    assertEquals(det.quality, 'medium')
    assertEquals(det.renderer, 'point')
    assertEquals(det.run_at, '2026-08-01T11:00:00.000Z')
    // Unset thresholds mean "splat_analyzer's own default" — recorded as absent
    // rather than guessed at, since that number belongs to the tool.
    assertEquals(det.score_threshold, null)
    assertEquals(det.min_votes, null)
    assertEquals(det.min_peak_score, null)

    const raw = JSON.stringify(srv.seen.eventBody)
    assert(!raw.includes('/home/ci/'), 'appliance filesystem paths are not forwarded')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a sidecar with no detect manifest still ships extents, with the detector unknown', async () => {
  const srv = stubServer()
  const dir = await tempScans('full')
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const meta = srv.seen.eventBody!.events[0].payload.object_extents as Record<string, unknown>
    assertEquals(result.extentCount, 3, 'the measurements are the point; ship them')
    assertEquals(meta.detector, null, 'but never claim parameters we did not read')
    assertEquals(meta.calibrated, false)
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a legacy label+position sidecar pushes exactly as it did before', async () => {
  const srv = stubServer()
  const dir = await tempScans('legacy')
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const ev = srv.seen.eventBody!.events[0]
    assertEquals(result.detectionCount, 3, 'extent-less objects are still memories')
    assertEquals(result.extentCount, 0)
    assertEquals(objectsIn(ev).length, 3)
    assertEquals('extent_m' in objectsIn(ev)[0], false, 'no extent is invented for them')
    assertEquals('object_extents' in ev.payload, false, 'and nothing is qualified that is not there')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: degenerate and sub-millimetre extents are dropped, not rounded to zero', async () => {
  const srv = stubServer()
  // ci.inventory CHECKs its SI columns > 0, so a zero axis must not reach it.
  const dir = await tempScans('full', {
    interactions: {
      objects: [
        { label: 'flat', position: { x: 0, y: 0, z: 0 }, scale: { x: 0, y: 1, z: 1 } },
        { label: 'tiny', position: { x: 1, y: 0, z: 0 }, scale: { x: 0.0004, y: 0.5, z: 0.5 } },
        { label: 'mirrored', position: { x: 2, y: 0, z: 0 }, scale: { x: -1.2, y: 0.5, z: 0.5 } },
      ],
    },
  })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const objects = objectsIn(srv.seen.eventBody!.events[0])

    assertEquals('extent_m' in objects[0], false, 'a zero-thickness box is not an extent')
    assertEquals('extent_mm' in objects[0], false)

    assertEquals((objects[1].extent_m as Record<string, number>).x, 0.0004, 'the raw metres survive')
    assertEquals('extent_mm' in objects[1], false, 'but 0.4mm must not round to a 0mm column value')

    assertEquals(
      JSON.stringify(objects[2].extent_m),
      JSON.stringify({ x: 1.2, y: 0.5, z: 0.5 }),
      'a negative scale is a mirrored axis, not a negative side length',
    )

    assertEquals(result.detectionCount, 3, 'all three are still recorded as detections')
    assertEquals(result.extentCount, 2, 'only the two usable extents count')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: works with no detections sidecar', async () => {
  const srv = stubServer()
  const dir = await tempScans('none')
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    assertEquals(result.detectionCount, 0)
    const ev = srv.seen.eventBody!.events[0]
    assertEquals(ev.payload.detection_count, 0)
    assertEquals((ev.payload.detected_labels as unknown[]).length, 0)
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: re-push of the same scan is reported as duplicate, not an error', async () => {
  const srv = stubServer({ duplicate: true })
  const dir = await tempScans('none')
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    assertEquals(result.eventDuplicate, 1)
    assertEquals(result.eventIngested, 0)
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a missing GLB still records the memory, with a skip reason', async () => {
  const srv = stubServer()
  const dir = await Deno.makeTempDir({ prefix: 'memory-push-empty-' })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    assertEquals(result.glbFileId, null)
    assert(result.glbSkippedReason, 'a skip reason is reported')
    assertEquals(srv.seen.eventBody!.events.length, 1, 'the event is still ingested')
    assert(srv.seen.eventBody!.events[0].payload.glb_skipped_reason, 'skip reason travels in the payload')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: an oversized GLB is skipped but the event still lands', async () => {
  const srv = stubServer()
  const dir = await tempScans('none')
  try {
    const cfg = { ...cfgFor(srv.base), maxUploadBytes: 4 } // file is 8 bytes
    const result = await pushScanToMemory(cfg, SCAN, { scansDir: dir })
    assertEquals(result.glbFileId, null)
    assert(result.glbSkippedReason!.includes('over the'), `got: ${result.glbSkippedReason}`)
    assertEquals(srv.seen.uploadFilename, undefined, 'no upload attempted')
    assertEquals(result.eventIngested, 1)
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a failed upload degrades to event-only rather than losing the capture', async () => {
  const srv = stubServer({ uploadStatus: 500 })
  const dir = await tempScans('none')
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    assertEquals(result.glbFileId, null)
    assert(result.glbSkippedReason!.includes('500'), `got: ${result.glbSkippedReason}`)
    assertEquals(result.eventIngested, 1, 'the memory is still recorded')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a failed event ingest throws, and the error never leaks the token', async () => {
  const srv = stubServer({ eventStatus: 401 })
  const dir = await tempScans('none')
  try {
    await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    throw new Error('expected a throw')
  } catch (err) {
    const msg = String(err)
    assert(msg.includes('401'), `expected the status in the error, got: ${msg}`)
    assert(!msg.includes('secret-key'), 'the API key must never appear in an error')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a per-event rejection surfaces as a failure with its reason', async () => {
  const srv = stubServer({ rejectReason: 'occurred_at must be ISO8601' })
  const dir = await tempScans('none')
  try {
    await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    throw new Error('expected a throw')
  } catch (err) {
    assert(String(err).includes('ISO8601'), `got: ${err}`)
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: refuses to run when the integration is disabled', async () => {
  const cfg: MemoryPushConfig = { ...cfgFor('http://unused'), enabled: false }
  try {
    await pushScanToMemory(cfg, SCAN, { scansDir: '/tmp' })
    throw new Error('expected a throw')
  } catch (err) {
    assert(String(err).includes('not configured'), `got: ${err}`)
  }
})

// ── Status route ──────────────────────────────────────────────────────────────

Deno.test('GET /memory/status: reports disabled with actionable guidance', async () => {
  const app = new Hono()
  registerMemoryPush(app, { ...cfgFor('http://x/api'), enabled: false })
  const res = await app.request('http://local/memory/status')
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.enabled, false)
  assert(String(body.reason).includes('CI_SERVER_URL'), 'names the env var to set')
})

Deno.test('GET /memory/status: reports enabled without ever exposing the token', async () => {
  const app = new Hono()
  registerMemoryPush(app, cfgFor('http://gateway:8642/api'), { probe: () => Promise.resolve(true) })
  const res = await app.request('http://local/memory/status')
  const raw = await res.text()
  assert(!raw.includes('secret-key'), 'the API key must never be exposed')
  const body = JSON.parse(raw)
  assertEquals(body.enabled, true)
  assertEquals(body.baseUrl, 'http://gateway:8642/api')
  assertEquals(body.reachable, true)
})
