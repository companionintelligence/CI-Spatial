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
} from './memory_push.ts'
import type { ScanManifest } from './src/world/types.ts'

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

/** A scans dir containing room.glb (+ optionally a detections sidecar). */
async function tempScans(withDetections: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: 'memory-push-test-' })
  await Deno.writeFile(`${dir}/room.glb`, new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]))
  if (withDetections) {
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
  return dir
}

// ── Integration ───────────────────────────────────────────────────────────────

Deno.test('push: uploads the GLB then records a capture.scan event with geo + detections', async () => {
  const srv = stubServer()
  const dir = await tempScans(true)
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

Deno.test('push: works with no detections sidecar', async () => {
  const srv = stubServer()
  const dir = await tempScans(false)
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
  const dir = await tempScans(false)
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
  const dir = await tempScans(false)
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
  const dir = await tempScans(false)
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
  const dir = await tempScans(false)
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
  const dir = await tempScans(false)
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
