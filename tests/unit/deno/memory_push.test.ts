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
  /**
   * Every upload in order, not just the last. The splat pipeline can attach a
   * second file, and "exactly one splat encoding was uploaded" is a claim only
   * the full list can settle — `uploadFilename` alone would show the winner and
   * hide however many attempts came before it.
   */
  uploads: Array<{ name: string; bytes: number }>
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
  const seen: Seen = { uploads: [] }
  let nextFileId = 0
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
        seen.uploads.push({ name: f.name, bytes: seen.uploadBytes })
      }
      seen.uploadSkipDescription = form.get('skipDescription') as string | null
      // Distinct ids per upload: the GLB is always first, so `file-uuid-1`
      // still means the mesh in every test written before splats existed.
      return Response.json([{ id: `file-uuid-${++nextFileId}` }])
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
  opts: {
    detectManifest?: boolean
    interactions?: unknown
    /**
     * Extra binary artifacts beside the mesh: filename -> byte length. Sizes
     * matter more than contents here — `discoverSplatArtifacts` stats the file
     * and the upload cap compares against what stat reported.
     */
    files?: Record<string, number>
    /**
     * Extra JSON sidecars: filename -> value, written verbatim. Verbatim so a
     * value like `[]` can be tested: an array is a thing a sidecar can hold and
     * a manifest reader must reject.
     */
    sidecars?: Record<string, unknown>
  } = {},
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
  for (const [name, size] of Object.entries(opts.files ?? {})) {
    await Deno.writeFile(`${dir}/${name}`, new Uint8Array(size))
  }
  for (const [name, value] of Object.entries(opts.sidecars ?? {})) {
    await Deno.writeTextFile(`${dir}/${name}`, JSON.stringify(value))
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

// ── Splat artifacts, the metric frame, and the capture-time detections ────────
//
// Three populations of new payload, all of them optional, all of them read off
// sidecars this test writes by hand. The shared contract is that none of them
// may change what a scan without them ships — pinned at the bottom of this
// section.

/** What splat_train.ts lands beside the scan when Brush has run. */
const TRAIN_MANIFEST = {
  schemaVersion: 1,
  tool: 'brush',
  status: 'ok',
  createdAt: '2026-08-01T10:40:00.000Z',
  plyPath: 'room.splat.ply',
  gaussianCount: 412_003,
  frameCount: 87,
}

/** And what splat_finish.ts lands after compressing it. */
const FINISH_MANIFEST = {
  schemaVersion: 1,
  tool: 'splat-transform',
  status: 'ok',
  createdAt: '2026-08-01T10:55:00.000Z',
  sogPath: 'room.sog',
  compressedPlyPath: 'room.compressed.ply',
}

/**
 * A splat-align manifest whose fit is inside its own tolerance — the only case
 * that may convert a splat-space length into metres.
 *
 * `projectTransform` is ROW-major (translation at 3/7/11) and is a +90° yaw
 * about Y with a uniform scale of 2 and a translation, i.e. s·R with
 * R·(x,y,z) = (z, y, −x). Chosen so every expected number below is exact in
 * binary and hand-checkable: the sofa at (1,0,2) must land at (7, 0.5, −4).
 */
const ALIGN_MANIFEST = {
  schemaVersion: 1,
  tool: 'umeyama',
  status: 'ok',
  createdAt: '2026-08-01T11:15:00.000Z',
  plyPath: 'room.splat.ply',
  calibrationMethod: 'two-point-ground',
  projectTransform: [
    0, 0, 2, 3,
    0, 2, 0, 0.5,
    -2, 0, 0, -2,
    0, 0, 0, 1,
  ],
  scale: 2,
  residualM: 0.04,
  correspondenceCount: 12,
  params: { minCorrespondences: 4, maxResidualM: 0.25 },
}

/** The upload sidecar gltf.ts writes: VLM detections resolved to world space. */
const META_SIDECAR = {
  detections: [
    { label: 'lamp', worldPos: { x: 1, y: 2, z: 3 }, confidence: 0.62, dimensions: { x: 9, y: 9, z: 9 } },
    { label: 'chair', worldPos: { x: -0.5, y: 0, z: 1.25 } },
    // Neither of these is a detection: no label, and no position.
    { label: '', worldPos: { x: 0, y: 0, z: 0 } },
    { label: 'ghost' },
  ],
}

function payloadOf(seen: Seen): Record<string, unknown> {
  return seen.eventBody!.events[0].payload
}

Deno.test('push: every splat encoding is referenced, exactly one is uploaded', async () => {
  const srv = stubServer()
  const dir = await tempScans('none', {
    files: { 'room.sog': 12, 'room.compressed.ply': 40, 'room.splat.ply': 900 },
    sidecars: {
      'room.splat-train.manifest.json': TRAIN_MANIFEST,
      'room.splat-finish.manifest.json': FINISH_MANIFEST,
    },
  })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const splat = payloadOf(srv.seen).splat as Record<string, unknown>
    const artifacts = splat.artifacts as Array<Record<string, unknown>>

    assertEquals(
      artifacts.map((a) => a.kind).join(','),
      'sog,compressed_ply,splat_ply',
      'delivery-preference order: smallest encoding first',
    )
    assertEquals(artifacts.map((a) => a.filename).join(','), 'room.sog,room.compressed.ply,room.splat.ply')

    // One attachment, not three of the same radiance field.
    assertEquals(artifacts[0].file_id, 'file-uuid-2', 'the sog is attached (the glb took file-uuid-1)')
    assertEquals(artifacts[1].file_id, null, 'the others are references — the appliance serves them from /scans/')
    assertEquals(artifacts[2].file_id, null)
    assertEquals(artifacts[2].bytes, 900, 'with their size, so a consumer can decide whether to fetch')
    assertEquals(
      srv.seen.uploads.map((u) => u.name).join(','),
      'room.glb,room.sog',
      'the 900-byte raw PLY is never sent alongside the sog it duplicates',
    )

    // Counts come off the manifests; nothing here opens a PLY.
    assertEquals(splat.gaussian_count, 412_003)
    assertEquals(splat.frame_count, 87)
    assertEquals(splat.train_tool, 'brush')
    assertEquals(splat.train_status, 'ok')
    assertEquals(splat.finish_status, 'ok')

    assertEquals(
      JSON.stringify(payloadOf(srv.seen).file_ids),
      JSON.stringify(['file-uuid-1', 'file-uuid-2']),
      'one walkable list of every attachment, whichever pipeline produced it',
    )
    assertEquals(result.splatArtifactCount, 3)
    assertEquals(JSON.stringify(result.splatFileIds), JSON.stringify(['file-uuid-2']))
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: an encoding over the cap falls through to the next, and says why', async () => {
  const srv = stubServer()
  const dir = await tempScans('none', { files: { 'room.sog': 40, 'room.compressed.ply': 3 } })
  try {
    // The glb is exactly 8 bytes, so it still fits a cap of 8.
    const result = await pushScanToMemory({ ...cfgFor(srv.base), maxUploadBytes: 8 }, SCAN, { scansDir: dir })
    const artifacts = (payloadOf(srv.seen).splat as Record<string, unknown>).artifacts as Array<Record<string, unknown>>

    assertEquals(artifacts[0].file_id, null, 'the 40-byte sog does not fit')
    assert(String(artifacts[0].skipped_reason).includes('over the'), `got: ${artifacts[0].skipped_reason}`)
    assertEquals(artifacts[0].bytes, 40, 'it is still named and sized — it exists on the appliance')
    assertEquals(artifacts[1].file_id, 'file-uuid-2', 'and the next encoding down is attached instead')
    assertEquals(srv.seen.uploads.map((u) => u.name).join(','), 'room.glb,room.compressed.ply')
    assertEquals(result.eventIngested, 1, 'the memory lands either way')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a trustworthy fit ships spatial_frame and carries each box into the project frame', async () => {
  const srv = stubServer()
  const dir = await tempScans('full', {
    detectManifest: true,
    sidecars: { 'room.splat-align.manifest.json': ALIGN_MANIFEST },
  })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const frame = payloadOf(srv.seen).spatial_frame as Record<string, unknown>

    assertEquals(frame.metric, true, 'the fit converged, scaled positively and measured itself in tolerance')
    assertEquals(frame.units, 'm')
    assertEquals(frame.frame, 'project')
    assertEquals(frame.scale, 2)
    assertEquals(frame.residual_m, 0.04)
    assertEquals(frame.max_residual_m, 0.25)
    assertEquals(frame.correspondence_count, 12)
    assertEquals(frame.calibration_method, 'two-point-ground')
    assertEquals(frame.fit_status, 'ok')
    assertEquals((frame.project_transform as number[]).length, 16)
    assert(String(frame.transform_convention).includes('row-major'), 'the convention is stated, not assumed')
    assert(
      String(frame.caveat).includes('not the ENU frame'),
      'and the project frame is explicitly not where `location` lives',
    )
    assertEquals(result.spatialFrameMetric, true)

    const objects = objectsIn(srv.seen.eventBody!.events[0])
    const sofa = objects[0]
    // Unchanged: the splat-frame numbers an older consumer already reads.
    assertEquals(JSON.stringify(sofa.position), JSON.stringify({ x: 1, y: 0, z: 2 }))
    assertEquals(JSON.stringify(sofa.extent_m), JSON.stringify({ x: 2.05, y: 0.82, z: 0.94 }))
    // Added: the same box in the Place's metric frame. s·R applied to (1,0,2)
    // is (2·2+3, 2·0+0.5, −2·1−2) = (7, 0.5, −4).
    assertEquals(JSON.stringify(sofa.position_project), JSON.stringify({ x: 7, y: 0.5, z: -4 }))
    assertEquals(
      JSON.stringify(sofa.extent_metric_m),
      JSON.stringify({ x: 4.1, y: 1.64, z: 1.88 }),
      'side lengths scale by the uniform fit scale, exactly',
    )

    // The orientation makes the SAME trip as the position. The box is a +90°
    // yaw about Y and so is the fit, so the composition is a 180° yaw:
    // (x, y, z, w) = (0, 1, 0, 0). A `position_project` shipped beside the
    // untransformed splat-frame quaternion — the defect this pins — would leave
    // this at (0, 0.7071, 0, 0.7071).
    const rp = sofa.rotation_project as Record<string, number>
    assert(rp, 'a rotated box in a metric fit must carry its project-frame orientation')
    assert(Math.abs(rp.y - 1) < 1e-9, `rotation_project.y ${rp.y}`)
    assert(Math.abs(rp.x) < 1e-9 && Math.abs(rp.z) < 1e-9 && Math.abs(rp.w) < 1e-9, JSON.stringify(rp))
    assert(
      Math.abs(Math.hypot(rp.x, rp.y, rp.z, rp.w) - 1) < 1e-9,
      'and it is a unit quaternion — the sidecar quaternion is normalised before composing',
    )
    assertEquals(
      JSON.stringify(sofa.rotation),
      JSON.stringify({ x: 0, y: 0.7071, z: 0, w: 0.7071 }),
      'while `rotation` stays the splat-frame original, verbatim',
    )

    // An identity-rotation box comes back as the fit's own rotation.
    const plant = objects[1].rotation_project as Record<string, number>
    assert(Math.abs(plant.y - Math.SQRT1_2) < 1e-9 && Math.abs(plant.w - Math.SQRT1_2) < 1e-9, JSON.stringify(plant))

    // The third object carried no rotation at all, so there is no orientation
    // to disagree about and `position_project` alone is unambiguous.
    assertEquals(JSON.stringify(objects[2].position_project), JSON.stringify({ x: 5, y: 0.5, z: -8 }))
    assertEquals('rotation_project' in objects[2], false, 'no orientation is invented for a box that had none')

    const meta = payloadOf(srv.seen).object_extents as Record<string, unknown>
    assertEquals(meta.project_frame_aligned, true)
    const metric = meta.metric as Record<string, unknown>
    assertEquals(metric.scale, 2)
    assertEquals(metric.residual_m, 0.04)
    assertEquals(
      JSON.stringify(metric.applied_to),
      JSON.stringify(['extent_metric_m', 'position_project', 'rotation_project']),
      'the pose fields are all-or-nothing, and the block says which shipped',
    )
    assertEquals(meta.frame, 'splat_local', 'the un-suffixed numbers are still splat-frame')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: rotation_project composes fit-then-box, pinned on two axes that do not commute', async () => {
  // The test above uses a fit and a box that are both yaws about Y, which is
  // symmetric: it cannot tell R_fit·R_box from R_box·R_fit. This one can.
  // R_fit is +90° about X (row-major rows [1,0,0] [0,0,-1] [0,1,0], scale 1,
  // no translation) and the sofa's box is +90° about Y, so the composition
  // R_fit·R_box is [[0,0,1],[1,0,0],[0,1,0]] — a 120° turn about (1,1,1),
  // whose quaternion is (0.5, 0.5, 0.5, 0.5). The reversed order would give
  // z = −0.5, so the sign of z is the whole assertion.
  const srv = stubServer()
  const dir = await tempScans('full', {
    sidecars: {
      'room.splat-align.manifest.json': {
        ...ALIGN_MANIFEST,
        scale: 1,
        projectTransform: [
          1, 0, 0, 0,
          0, 0, -1, 0,
          0, 1, 0, 0,
          0, 0, 0, 1,
        ],
      },
    },
  })
  try {
    await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const sofa = objectsIn(srv.seen.eventBody!.events[0])[0]
    const rp = sofa.rotation_project as Record<string, number>
    for (const axis of ['x', 'y', 'z', 'w'] as const) {
      assert(Math.abs(rp[axis] - 0.5) < 1e-9, `rotation_project.${axis} = ${rp[axis]}, expected 0.5`)
    }
    // And the centre took the same transform: (1,0,2) under (x,y,z) -> (x,−z,y).
    assertEquals(JSON.stringify(sofa.position_project), JSON.stringify({ x: 1, y: -2, z: 0 }))
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

/**
 * Rebuild a row-major rotation matrix from an xyzw quaternion.
 *
 * The inverse direction of the extraction under test, written out here rather
 * than imported, so the round-trip below compares two independent statements of
 * the same rotation instead of one implementation agreeing with itself.
 */
function matrixFromQuat(q: Record<string, number>): number[][] {
  const { x, y, z, w } = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}

Deno.test('push: the fit rotation survives extraction for every quaternion branch', async () => {
  // Shepperd's method picks one of four branches by which diagonal term is
  // largest, and a transcription slip in any of them ships a plausible wrong
  // orientation. The trace>0 branch is the only one a yaw fixture reaches, so
  // each of the other three gets a rotation that lands in it: a half-turn about
  // X, Y and Z has trace −1 and puts the largest term on a different diagonal
  // each time. The last row is a general rotation with no zeros to hide behind.
  // Rodrigues, row-major. The axis-aligned half-turns that reach the three
  // non-trace branches most obviously are a trap: at exactly 180° the
  // quaternion has a single non-zero component and every off-diagonal term the
  // branches differ in is 0, so a sign slip in one of them round-trips
  // perfectly. These are 150° turns about *tilted* axes instead — past the
  // 120° where the trace goes negative, with nothing zero anywhere.
  const rot = (axis: [number, number, number], deg: number): number[][] => {
    const n = Math.hypot(...axis)
    const [x, y, z] = axis.map((a) => a / n)
    const t = (deg * Math.PI) / 180
    const c = Math.cos(t), si = Math.sin(t), k = 1 - c
    return [
      [c + x * x * k, x * y * k - z * si, x * z * k + y * si],
      [y * x * k + z * si, c + y * y * k, y * z * k - x * si],
      [z * x * k - y * si, z * y * k + x * si, c + z * z * k],
    ]
  }
  const cases: Array<{ what: string; r: number[][] }> = [
    { what: 'trace>0 (+90° about Y)', r: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] },
    { what: 'trace>0 (+37° about a tilted axis)', r: rot([0.3, 0.5, 0.81], 37) },
    // Which diagonal term is largest follows the dominant axis component, so
    // these three land in the x-, y- and z-dominant branches respectively.
    { what: 'x-dominant (150° about a mostly-X axis)', r: rot([0.9, 0.3, 0.2], 150) },
    { what: 'y-dominant (150° about a mostly-Y axis)', r: rot([0.2, 0.9, 0.35], 150) },
    { what: 'z-dominant (150° about a mostly-Z axis)', r: rot([0.25, 0.15, 0.94], 150) },
    // Exactly 180°, which is the degenerate case the tilted turns above cover
    // for: worth keeping so branch *selection* is pinned at the boundary too.
    { what: 'x-dominant (180° about X)', r: [[1, 0, 0], [0, -1, 0], [0, 0, -1]] },
    { what: 'y-dominant (180° about Y)', r: [[-1, 0, 0], [0, 1, 0], [0, 0, -1]] },
    { what: 'z-dominant (180° about Z)', r: [[-1, 0, 0], [0, -1, 0], [0, 0, 1]] },
    // A 120° turn about (1,1,1)/√3: trace exactly 0, all three diagonals tied,
    // so it pins which way the ties break.
    { what: 'general 120° (all diagonals tied)', r: [[0, 0, 1], [1, 0, 0], [0, 1, 0]] },
  ]

  for (const { what, r } of cases) {
    const srv = stubServer()
    const dir = await tempScans('full', {
      sidecars: {
        'room.splat-align.manifest.json': {
          ...ALIGN_MANIFEST,
          scale: 1,
          projectTransform: [
            r[0][0], r[0][1], r[0][2], 0,
            r[1][0], r[1][1], r[1][2], 0,
            r[2][0], r[2][1], r[2][2], 0,
            0, 0, 0, 1,
          ],
        },
      },
    })
    try {
      await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
      // The plant's box rotation is the identity, so its rotation_project IS
      // the fit's own rotation and the round-trip is unobscured.
      const plant = objectsIn(srv.seen.eventBody!.events[0])[1]
      const q = plant.rotation_project as Record<string, number>
      assert(q, `${what}: no rotation_project emitted`)
      const back = matrixFromQuat(q)
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          assert(
            Math.abs(back[i][j] - r[i][j]) < 1e-9,
            `${what}: R[${i}][${j}] round-tripped to ${back[i][j]}, expected ${r[i][j]}`,
          )
        }
      }
    } finally {
      await srv.close()
      await Deno.remove(dir, { recursive: true })
    }
  }
})

Deno.test('push: a fit outside its own tolerance ships the frame but no metric numbers', async () => {
  const srv = stubServer()
  const dir = await tempScans('full', {
    detectManifest: true,
    // The aligner said ok, but the residual it recorded is 0.9 m against its
    // own 0.25 m limit. A fit that converged badly is a wrong answer, not a
    // rounded one, so nothing converts.
    sidecars: { 'room.splat-align.manifest.json': { ...ALIGN_MANIFEST, residualM: 0.9 } },
  })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const frame = payloadOf(srv.seen).spatial_frame as Record<string, unknown>

    assertEquals(frame.metric, false, 'this is the field a consumer branches on')
    assertEquals(frame.scale, 2, 'the number is still reported — it is just not usable, and the caveat says so')
    assertEquals(frame.residual_m, 0.9)
    assertEquals(result.spatialFrameMetric, false)

    const sofa = objectsIn(srv.seen.eventBody!.events[0])[0]
    assertEquals('extent_metric_m' in sofa, false, 'no length is converted from a fit that failed')
    assertEquals('position_project' in sofa, false)
    assertEquals('rotation_project' in sofa, false)
    assertEquals(JSON.stringify(sofa.extent_m), JSON.stringify({ x: 2.05, y: 0.82, z: 0.94 }), 'the splat-frame box is untouched')

    const meta = payloadOf(srv.seen).object_extents as Record<string, unknown>
    assertEquals(meta.project_frame_aligned, false)
    assertEquals(meta.metric, null, 'and no metric provenance is claimed')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a transform that is not a similarity ships no project-frame pose at all', async () => {
  const srv = stubServer()
  const dir = await tempScans('full', {
    detectManifest: true,
    sidecars: {
      // Non-uniform scale: rows of length 2, 3 and 2. There is no single
      // rotation in that block, so an orientation cannot be carried through it
      // — and a position that travelled while the orientation stayed behind is
      // the mixed-frame pose this refuses to emit.
      'room.splat-align.manifest.json': {
        ...ALIGN_MANIFEST,
        projectTransform: [
          0, 0, 2, 3,
          0, 3, 0, 0.5,
          -2, 0, 0, -2,
          0, 0, 0, 1,
        ],
      },
    },
  })
  try {
    await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const sofa = objectsIn(srv.seen.eventBody!.events[0])[0]
    assertEquals('position_project' in sofa, false, 'no half-applied pose')
    assertEquals('rotation_project' in sofa, false)
    // The uniform scale factor is still a measured number, so lengths convert.
    assertEquals(JSON.stringify(sofa.extent_metric_m), JSON.stringify({ x: 4.1, y: 1.64, z: 1.88 }))
    const metric = (payloadOf(srv.seen).object_extents as Record<string, unknown>).metric as Record<string, unknown>
    assertEquals(JSON.stringify(metric.applied_to), JSON.stringify(['extent_metric_m']), 'and the block says only that shipped')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: capture-time detections ship with their world positions and their own frame block', async () => {
  const srv = stubServer()
  const dir = await tempScans('none', { sidecars: { 'room.json': META_SIDECAR } })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const mesh = payloadOf(srv.seen).mesh_objects as Array<Record<string, unknown>>

    assertEquals(mesh.length, 2, 'an entry with no label or no position is not a detection')
    assertEquals(mesh[0].label, 'lamp')
    assertEquals(JSON.stringify(mesh[0].world_pos), JSON.stringify({ x: 1, y: 2, z: 3 }))
    assertEquals(mesh[0].confidence, 0.62)
    assertEquals('confidence' in mesh[1], false, 'no score is invented for an entry that carried none')
    assertEquals(result.meshObjectCount, 2)

    // The GLB exporter's `dimensions` is a 2D bbox fraction times hard-coded
    // constants. It is present in the fixture and must not be forwarded: it
    // would arrive indistinguishable from splat_analyzer's measured extents.
    assertEquals('dimensions' in mesh[0], false, "gltf.ts's fabricated dimensions are not forwarded")
    assert(!JSON.stringify(mesh).includes('dimensions'), 'not under any name, anywhere in the block')

    const meshFrame = payloadOf(srv.seen).mesh_object_frame as Record<string, unknown>
    assertEquals(meshFrame.frame, 'scan_world', 'a different frame from the splat boxes, and it says so')
    assertEquals(meshFrame.has_extents, false)
    assert(String(meshFrame.convention).includes('points, not volumes'), 'the convention says what these are not')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: a sidecar holding a JSON array reads as absent, not as an empty manifest', async () => {
  const srv = stubServer()
  const dir = await tempScans('full', {
    // `typeof [] === 'object'`, so an array would otherwise pass the manifest
    // guard and be read as a stage that ran and recorded nothing — a splat
    // block full of nulls for a scan that never trained one, and a
    // spatial_frame for a scan with no fit.
    sidecars: {
      'room.splat-train.manifest.json': [],
      'room.splat-finish.manifest.json': [],
      'room.splat-align.manifest.json': [],
      'room.splat-detect.manifest.json': [],
    },
  })
  try {
    const result = await pushScanToMemory(cfgFor(srv.base), SCAN, { scansDir: dir })
    const payload = payloadOf(srv.seen)

    assertEquals('splat' in payload, false, 'an unreadable sidecar is not a splat that trained')
    assertEquals('spatial_frame' in payload, false, 'nor a fit that solved')
    assertEquals(
      (payload.object_extents as Record<string, unknown>).detector,
      null,
      'nor a detector whose every parameter happens to be unset',
    )
    assertEquals(result.splatArtifactCount, 0)
    assertEquals(result.spatialFrameMetric, false)
    assertEquals(result.detectionCount, 3, 'the real sidecar still reads normally')
  } finally {
    await srv.close()
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('push: the splat/align/mesh fields are additive — the old payload is untouched', async () => {
  // The contract for every consumer that already reads these events: new
  // stages add keys, they never move, rename or reinterpret an existing one.
  // Asserted by pushing the SAME scan twice, once with none of the new
  // sidecars and once with all of them, and diffing the two payloads.
  const bare = stubServer()
  const rich = stubServer()
  const bareDir = await tempScans('full', { detectManifest: true })
  const richDir = await tempScans('full', {
    detectManifest: true,
    files: { 'room.sog': 12 },
    sidecars: {
      'room.splat-train.manifest.json': TRAIN_MANIFEST,
      'room.splat-finish.manifest.json': FINISH_MANIFEST,
      'room.splat-align.manifest.json': ALIGN_MANIFEST,
      'room.json': META_SIDECAR,
    },
  })
  try {
    await pushScanToMemory(cfgFor(bare.base), SCAN, { scansDir: bareDir })
    await pushScanToMemory(cfgFor(rich.base), SCAN, { scansDir: richDir })
    const old = payloadOf(bare.seen)
    const now = payloadOf(rich.seen)

    // Spelled out rather than derived from the code, so a key that quietly
    // stops being emitted fails here rather than agreeing with its own bug.
    const PRE_SPLAT_KEYS = [
      'scan_id',
      'session_id',
      'glb_filename',
      'glb_file_id',
      'file_ids',
      'point_count',
      'detection_count',
      'detected_labels',
      'objects',
      'object_extents',
      'location',
    ]
    assertEquals(
      Object.keys(old).sort().join(','),
      [...PRE_SPLAT_KEYS].sort().join(','),
      'a scan with none of the new stages ships the pre-splat shape and nothing else',
    )
    assertEquals(
      Object.keys(now).sort().join(','),
      [...PRE_SPLAT_KEYS, 'splat', 'spatial_frame', 'mesh_objects', 'mesh_object_frame'].sort().join(','),
      'and the new stages add exactly four top-level keys',
    )

    // Every scalar/array key survives the new stages byte-identical. The three
    // exceptions are handled below: they legitimately GAIN entries.
    for (const k of PRE_SPLAT_KEYS) {
      if (k === 'objects' || k === 'object_extents' || k === 'file_ids') continue
      assertEquals(JSON.stringify(now[k]), JSON.stringify(old[k]), `${k} must not change`)
    }
    assertEquals(
      JSON.stringify((now.file_ids as string[]).slice(0, 1)),
      JSON.stringify(old.file_ids),
      'file_ids only ever appends the new attachments',
    )

    // Per object: every key the old payload had, with the same value, plus at
    // most the three project-frame additions.
    const oldObjects = old.objects as Array<Record<string, unknown>>
    const newObjects = now.objects as Array<Record<string, unknown>>
    assertEquals(newObjects.length, oldObjects.length)
    const ADDED = ['extent_metric_m', 'position_project', 'rotation_project']
    oldObjects.forEach((o, i) => {
      for (const [k, v] of Object.entries(o)) {
        assertEquals(JSON.stringify(newObjects[i][k]), JSON.stringify(v), `object ${i} key ${k} must not change`)
      }
      const extra = Object.keys(newObjects[i]).filter((k) => !(k in o))
      assertEquals(extra.every((k) => ADDED.includes(k)), true, `object ${i} gained ${extra.join(',')}`)
    })

    // Same for the qualifying block. `convention`/`caveat` are prose that grew
    // to describe the new fields; the data-bearing keys did not move.
    for (const k of ['source', 'frame', 'units', 'world_frame_aligned', 'calibrated', 'detector']) {
      const a = (old.object_extents as Record<string, unknown>)[k]
      const b = (now.object_extents as Record<string, unknown>)[k]
      assertEquals(JSON.stringify(b), JSON.stringify(a), `object_extents.${k} must not change`)
    }
  } finally {
    await bare.close()
    await rich.close()
    await Deno.remove(bareDir, { recursive: true })
    await Deno.remove(richDir, { recursive: true })
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
