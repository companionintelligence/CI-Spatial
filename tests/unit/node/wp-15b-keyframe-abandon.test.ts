/**
 * WP-15b: KeyframeStreamer.abandon(), the stop that a withdrawal of consent uses.
 *
 * stop() drains what is queued for up to five seconds before it closes the session, so frames would still leave the
 * phone after the person said no. abandon() sends none: from the moment it is called nothing is captured and nothing
 * new is sent, the queue is dropped, the upload in flight is cancelled and is not retried, and the session is
 * finalized (counts and a filename, no picture). It holds even when a start is still opening a session or a rotation is
 * waiting to reopen one, and a start asked for afterwards is a new yes and works.
 *
 * The streamer also records which scan a session follows: a session that ends with no export of its own, after the stream
 * exported one, is finalized as following that scan, so that deleting the scan deletes the frames taken after it.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b-keyframe-abandon.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeyframeStreamer } from '../../../src/capture/keyframes.ts'
import type { ARProvider, Pose, RawFrame } from '../../../src/ar/provider.ts'

// ─── Browser globals the streamer touches ──────────────────────────────────

;(globalThis as { document?: unknown }).document = { visibilityState: 'visible', addEventListener(): void {} }
;(globalThis as { ImageData?: unknown }).ImageData = class {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}
;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ close(): void {} })
;(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
  width: number
  height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }
  getContext(): { drawImage(): void } {
    return { drawImage(): void {} }
  }
  async convertToBlob(): Promise<Blob> {
    return new Blob(['jpeg'], { type: 'image/jpeg' })
  }
}

interface Call {
  url: string
  method: string
  signal: AbortSignal | undefined
  body: unknown
}

const calls: Call[] = []
let sessionCounter = 0
/** While set, POST /sessions waits here, as a slow server does while a start is in flight. */
let sessionOpenGate: Promise<void> | null = null
/** While true, a keyframe upload waits until released, and rejects if its request is cancelled. */
let holdingUploads = false
/** While true as well, a held upload does not notice that its request was cancelled, as a stalled connection does not. */
let ignoringCancel = false
const heldUploads: Array<() => void> = []

;(globalThis as { fetch?: unknown }).fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({ url, method, signal: init?.signal ?? undefined, body: init?.body })
  if (url === '/sessions' && method === 'POST') {
    if (sessionOpenGate) await sessionOpenGate
    sessionCounter++
    return new Response(JSON.stringify({ sessionId: `sess-${sessionCounter}` }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (url.endsWith('/keyframes') && holdingUploads) {
    await new Promise<void>((resolve, reject) => {
      heldUploads.push(resolve)
      if (!ignoringCancel) init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
  }
  return new Response('{}', { status: 200 })
}

function reset(): void {
  calls.length = 0
  sessionCounter = 0
  sessionOpenGate = null
  holdingUploads = false
  ignoringCancel = false
  heldUploads.length = 0
}

const releaseUploads = (): void => {
  holdingUploads = false
  heldUploads.splice(0).forEach((release) => release())
}
const uploads = (): Call[] => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/keyframes'))
const finalizes = (): Call[] => calls.filter((c) => c.url.endsWith('/finalize'))
/** What each finalize POST carried, in order. */
const finalizeBodies = (): Array<Record<string, unknown>> => finalizes().map((c) => JSON.parse(String(c.body)) as Record<string, unknown>)
const sessionOpens = (): Call[] => calls.filter((c) => c.url === '/sessions' && c.method === 'POST')
const settle = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface StubProvider {
  captures: number
  x: number
}

function stub(): StubProvider & ARProvider {
  const p: StubProvider = { captures: 0, x: 0 }
  return Object.assign(p, {
    isTracking: () => true,
    trackingStatus: () => 'NORMAL',
    getPose: (): Pose => ({ position: { x: p.x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    captureFrame: async (): Promise<RawFrame> => {
      p.captures++
      return { pixels: new Uint8ClampedArray(64), width: 4, height: 4, pose: { position: { x: p.x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, timestamp: 1 }
    },
    getCameraFovY: () => 60,
    getCameraAspect: () => 1,
  }) as unknown as StubProvider & ARProvider
}

function streamer(p: ARProvider): KeyframeStreamer {
  return new KeyframeStreamer(p, { minIntervalMs: 0, pollIntervalMs: 3_600_000, maxQueue: 3 })
}

const tick = (s: KeyframeStreamer): Promise<void> => (s as unknown as { _tick(): Promise<void> })._tick()

/** Moves the camera far enough that the next tick takes a keyframe. */
function step(p: StubProvider): void {
  p.x += 1
}

// ───────────────────────────────────────────────────────────────────────────

test('abandon cancels the upload in flight, drops what is queued, sends nothing more, and finalizes once', async (t) => {
  reset()
  holdingUploads = true
  const p = stub()
  const s = streamer(p)
  t.after(() => {
    releaseUploads()
    return s.stop()
  })
  await s.start()
  for (let i = 0; i < 3; i++) {
    step(p)
    await tick(s)
  }
  await settle()
  assert.equal(uploads().length, 1, 'one upload is in flight and two frames wait behind it')
  const inFlight = uploads()[0]!.signal!
  assert.equal(inFlight.aborted, false)

  await s.abandon({ glbFilename: 'a.glb' })

  assert.equal(inFlight.aborted, true, 'the request that was leaving the phone is cancelled')
  assert.equal(uploads().length, 1, 'neither of the two queued frames was sent, and the cancelled one was not retried')
  assert.equal(finalizes().length, 1)
  assert.equal(s.active, false)
  assert.equal(s.sessionId, null)
  await settle(60)
  assert.equal(uploads().length, 1, 'nothing leaves the phone after the stop either')
  assert.equal(s.isTransitioning, false)
  // The cancelled upload has ended, and did not wait out its first back-off (500 ms) before noticing.
  assert.equal((s as unknown as { _uploading: boolean })._uploading, false)
})

test('a cancelled upload is not counted as a failure, so the row does not report a fault the person caused', async (t) => {
  reset()
  holdingUploads = true
  const p = stub()
  const s = streamer(p)
  const statuses: Array<{ failed: number; sent: number }> = []
  s.onStatus = (status) => statuses.push({ failed: status.failed, sent: status.sent })
  t.after(() => {
    releaseUploads()
    return s.stop()
  })
  await s.start()
  step(p)
  await tick(s)
  await settle()
  await s.abandon()
  await settle(30)
  assert.ok(statuses.every((status) => status.failed === 0), 'no failed frame was ever reported')
})

test('abandon while a start is still opening a session: the session is closed when it opens, and no frame is taken', async (t) => {
  reset()
  let openSession!: () => void
  sessionOpenGate = new Promise<void>((resolve) => {
    openSession = resolve
  })
  const p = stub()
  const s = streamer(p)
  t.after(() => s.stop())
  const starting = s.start()
  const abandoning = s.abandon()
  openSession()
  await starting
  await abandoning
  step(p)
  await tick(s)
  assert.equal(p.captures, 0, 'nothing was captured for a stream the person had already turned off')
  assert.equal(uploads().length, 0)
  assert.equal(finalizes().length, 1, 'the session that did open was finalized')
  assert.equal(s.active, false)
})

test('a rotation waiting behind an abandon does not reopen a session', async (t) => {
  reset()
  const p = stub()
  const s = streamer(p)
  t.after(() => s.stop())
  await s.start()
  const rotating = s.rotate({ glbFilename: 'a.glb' })
  const abandoning = s.abandon({ glbFilename: 'a.glb' })
  await Promise.all([rotating, abandoning])
  assert.equal(sessionOpens().length, 1, 'only the session that was opened to begin with')
  assert.equal(s.active, false)
  assert.equal(s.isTransitioning, false)
})

test('a start asked for after an abandon is a new yes: it opens a session and keyframes again', async (t) => {
  reset()
  const p = stub()
  const s = streamer(p)
  t.after(() => s.stop())
  await s.start()
  await s.abandon()
  assert.equal(s.active, false)
  await s.start()
  assert.equal(s.active, true)
  assert.equal(sessionOpens().length, 2)
  step(p)
  await tick(s)
  assert.equal(p.captures, 1, 'frames are taken again')
})

test('abandon on a streamer that is not running is harmless, and the next start is not held back', async (t) => {
  reset()
  const p = stub()
  const s = streamer(p)
  t.after(() => s.stop())
  await s.abandon()
  assert.equal(finalizes().length, 0)
  await s.start()
  step(p)
  await tick(s)
  assert.equal(p.captures, 1)
})

test('stop() is unchanged: it still waits for what is queued, which is the whole difference from abandon()', async (t) => {
  reset()
  const p = stub()
  const s = streamer(p)
  t.after(() => s.stop())
  await s.start()
  step(p)
  await tick(s)
  await s.stop()
  assert.equal(uploads().length, 1, 'the frame that was taken is sent before the session closes')
  assert.equal(finalizes().length, 1)
})

test('abandon does not wait for an upload that will not be cancelled: nothing is drained', async (t) => {
  reset()
  holdingUploads = true
  ignoringCancel = true
  const p = stub()
  const s = streamer(p)
  t.after(() => {
    releaseUploads()
    return s.stop()
  })
  await s.start()
  step(p)
  await tick(s)
  await settle()
  assert.equal(uploads().length, 1, 'an upload is in flight')

  const started = Date.now()
  await s.abandon()
  // stop() would wait up to five seconds for this upload. A withdrawal waits for nothing.
  assert.ok(Date.now() - started < 1000, `abandon took ${Date.now() - started} ms`)
  assert.equal(finalizes().length, 1)
  assert.equal(s.active, false)
})

test('an abandon that arrives while a rotation is still waiting on its uploads refuses them, and does not call that a failure', async (t) => {
  reset()
  holdingUploads = true
  const p = stub()
  const s = streamer(p)
  const statuses: Array<{ failed: number }> = []
  s.onStatus = (status) => statuses.push({ failed: status.failed })
  t.after(() => {
    releaseUploads()
    return s.stop()
  })
  await s.start()
  for (let i = 0; i < 2; i++) {
    step(p)
    await tick(s)
  }
  await settle()
  // The export's rotation is draining: it waits for the upload in flight and the frame queued behind it.
  const rotating = s.rotate({ glbFilename: 'a.glb' })
  await settle()
  const abandoning = s.abandon({ glbFilename: 'a.glb' })
  await Promise.all([rotating, abandoning])
  await settle(700)
  assert.equal(uploads().length, 1, 'the frame behind the one in flight was never sent')
  assert.ok(statuses.every((status) => status.failed === 0), 'a frame refused because the person said no is not a fault')
  assert.equal(sessionOpens().length, 1, 'and no session was reopened')
})

// ─── The scan a session follows ────────────────────────────────────────────

test('a session that ends with no scan of its own, after the stream exported one, is finalized as following that scan', async () => {
  reset()
  const s = streamer(stub())
  await s.start()
  await s.rotate({ glbFilename: 'a.glb', pointCount: 100 })
  await s.stop({ pointCount: 120 })
  const [exported, trailing] = finalizeBodies()
  assert.equal(exported!['glbFilename'], 'a.glb')
  assert.equal(exported!['followsGlbFilename'], undefined, 'the session the export was made from is not a follower of anything')
  assert.equal(trailing!['glbFilename'], undefined, 'the trailing session has no scan of its own')
  assert.equal(trailing!['followsGlbFilename'], 'a.glb', 'it holds the frames taken after the export')
  assert.equal(trailing!['pointCount'], 120, 'what the caller sent is still sent')
})

test('the link moves with each export, and a rotation whose export failed still follows the last one that worked', async () => {
  reset()
  const s = streamer(stub())
  await s.start()
  await s.rotate({ glbFilename: 'a.glb' })
  await s.rotate({ glbFilename: 'b.glb' })
  await s.rotate({}) // an export that failed: no filename
  await s.stop({})
  const bodies = finalizeBodies()
  assert.deepEqual(bodies.map((body) => [body['glbFilename'], body['followsGlbFilename']]), [
    ['a.glb', undefined],
    ['b.glb', undefined],
    [undefined, 'b.glb'],
    [undefined, 'b.glb'],
  ])
})

test('a stream that never exported follows nothing, and a session with a scan of its own is not a follower', async () => {
  reset()
  const never = streamer(stub())
  await never.start()
  await never.stop({})
  assert.equal(finalizeBodies()[0]!['followsGlbFilename'], undefined, 'there was no scan to follow')

  reset()
  const own = streamer(stub())
  await own.start()
  await own.rotate({ glbFilename: 'a.glb' })
  await own.stop({ glbFilename: 'b.glb' })
  assert.deepEqual(finalizeBodies().map((body) => [body['glbFilename'], body['followsGlbFilename']]), [['a.glb', undefined], ['b.glb', undefined]])
})

test('the link ends with the stream: the next stream, after a stop or an abandon, follows nothing of this one', async () => {
  reset()
  const s = streamer(stub())
  await s.start()
  await s.rotate({ glbFilename: 'a.glb' })
  await s.stop({})
  await s.start()
  await s.stop({})
  assert.deepEqual(finalizeBodies().map((body) => body['followsGlbFilename']), [undefined, 'a.glb', undefined], 'the second walk is not a continuation of the first')

  reset()
  const t = streamer(stub())
  await t.start()
  await t.rotate({ glbFilename: 'c.glb' })
  await t.abandon({})
  await t.start()
  await t.abandon({})
  assert.deepEqual(finalizeBodies().map((body) => body['followsGlbFilename']), [undefined, 'c.glb', undefined], 'a withdrawal ends the walk too')
})

test('the field that links a trailing session to its scan is spelled the same in the streamer, the finalize route and the deletion', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  // A client that spelled it another way would finalize sessions the server never links, and deleting a scan would leave
  // the frames taken after its last export. Each file names it once or more; none may name a different one.
  assert.match(read('src/capture/keyframes.ts'), /body\.followsGlbFilename = this\._walkScan/)
  assert.match(read('server/main.ts'), /body\.followsGlbFilename/)
  assert.match(read('server/session_deletion.ts'), /record\['followsGlbFilename'\] === filename/)
  for (const path of ['src/capture/keyframes.ts', 'server/main.ts', 'server/session_deletion.ts']) {
    const spellings = new Set([...read(path).matchAll(/follows[A-Za-z]*Filename|followsGlb[A-Za-z]*/g)].map((match) => match[0]))
    assert.deepEqual([...spellings], ['followsGlbFilename'], `${path} spells it one way`)
  }
})
