/**
 * WP-C / F47 and F48: keyframes gate on live tracking, and the streamer's session
 * lifecycle cannot open a second session during a start, a stop or a rotation.
 *
 * F47: isTracking() latches on the first pose, so a LIMITED session kept
 * keyframing. The keyframe gate now also asks trackingStatus(), and fails open
 * for UNKNOWN (WebXR).
 * F48: start, stop and rotate are one at a time, a frame queued for a closed
 * session is never uploaded into the next one, and the poll handle is cleared
 * before it is replaced.
 * CAR-3: a throw after the session is active does not roll the streamer back to idle.
 * CAR3-6 to CAR3-8: a throwing listener is logged, not thrown; a failed transition is
 * logged even when the caller drops the promise; isTransitioning reports a start or a
 * stop in flight.
 * WP-09: each keyframe's meta carries the frame epoch its pose was read in
 * (src/ar/frame-epoch.ts), so a session whose frames span a frame shift says so.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c-keyframes.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyframeStreamer } from '../../../src/capture/keyframes.ts'
import type { ARProvider, Pose, RawFrame } from '../../../src/ar/provider.ts'
import type { TrackingStatus } from '../../../src/ar/tracking-quality.ts'

// ─── Browser globals the streamer touches ──────────────────────────────────

const doc = {
  visibilityState: 'visible' as 'visible' | 'hidden',
  addEventListener(): void {},
}
;(globalThis as { document?: unknown }).document = doc

class FakeImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}
;(globalThis as { ImageData?: unknown }).ImageData = FakeImageData
;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ close(): void {} })

class FakeOffscreenCanvas {
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
;(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreenCanvas

interface Call {
  url: string
  method: string
}

const calls: Call[] = []
/** The `meta` field of every keyframe upload, parsed the way the server reads it. */
const uploadedMeta: Array<Record<string, unknown>> = []
let sessionCounter = 0
/** While true, keyframe uploads wait here until a test releases them. */
let holdingUploads = false
const heldUploads: Array<() => void> = []

;(globalThis as { fetch?: unknown }).fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({ url, method })
  if (url === '/sessions' && method === 'POST') {
    sessionCounter++
    return new Response(JSON.stringify({ sessionId: `sess-${sessionCounter}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/keyframes')) {
    const meta = (init?.body as FormData | undefined)?.get('meta')
    if (typeof meta === 'string') uploadedMeta.push(JSON.parse(meta) as Record<string, unknown>)
  }
  if (url.endsWith('/keyframes') && holdingUploads) {
    await new Promise<void>((resolve) => heldUploads.push(resolve))
  }
  return new Response('{}', { status: 200 })
}

function reset(): void {
  calls.length = 0
  uploadedMeta.length = 0
  sessionCounter = 0
  holdingUploads = false
  heldUploads.length = 0
  doc.visibilityState = 'visible'
}

function releaseHeldUploads(): void {
  holdingUploads = false
  heldUploads.splice(0).forEach((release) => release())
}

const postsTo = (suffix: string): number =>
  calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix)).length

const uploadsTo = (sessionId: string): number =>
  calls.filter((c) => c.url === `/sessions/${sessionId}/keyframes`).length

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

// ─── A stub provider with the tracking signals under test ──────────────────

interface StubProvider {
  tracking: boolean
  status: TrackingStatus
  captures: number
  /** Camera x position in metres. Moving it by more than 0.3 m makes the next tick keyframe. */
  x: number
  moveTo(x: number): void
  isTracking(): boolean
  trackingStatus(): TrackingStatus
  getPose(): Pose
  captureFrame(): Promise<RawFrame>
  getCameraFovY(): number
  getCameraAspect(): number
}

function stubProvider(tracking: boolean, status: TrackingStatus): StubProvider {
  const p: StubProvider = {
    tracking,
    status,
    captures: 0,
    x: 0,
    moveTo(x: number): void {
      p.x = x
    },
    isTracking: () => p.tracking,
    trackingStatus: () => p.status,
    getPose: () => ({ position: { x: p.x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }),
    captureFrame: async () => {
      p.captures++
      return { pixels: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4, pose: p.getPose(), timestamp: 1 }
    },
    getCameraFovY: () => 60,
    getCameraAspect: () => 1,
  }
  return p
}

/** Keyframes are on a 1.2 s cadence and the poll runs every 350 ms. Tests drive one tick at a time. */
function streamerFor(p: StubProvider): KeyframeStreamer {
  return new KeyframeStreamer(p as unknown as ARProvider, {
    minIntervalMs: 0,
    pollIntervalMs: 3_600_000,
  })
}

function tick(s: KeyframeStreamer): Promise<void> {
  return (s as unknown as { _tick(): Promise<void> })._tick()
}

// ─── F47: keyframes gate on the live tracking status ───────────────────────

test('F47: a LIMITED session is not keyframed, even though isTracking() has latched', async (t) => {
  reset()
  const p = stubProvider(true, 'LIMITED')
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  assert.equal(p.captures, 0)
})

test('F47: an INITIALIZING session is not keyframed', async (t) => {
  reset()
  const p = stubProvider(true, 'INITIALIZING')
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  assert.equal(p.captures, 0)
})

test('F47: NORMAL tracking is keyframed', async (t) => {
  reset()
  const p = stubProvider(true, 'NORMAL')
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  assert.equal(p.captures, 1)
})

test('F47: UNKNOWN fails open, so a WebXR-style runtime keeps keyframing', async (t) => {
  reset()
  const p = stubProvider(true, 'UNKNOWN')
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  assert.equal(p.captures, 1)
})

test('F47: before the first pose, keyframes wait, even when the status reads UNKNOWN', async (t) => {
  // The 8th Wall status reads UNKNOWN until the first reality frame, so
  // isTracking() must still gate the first keyframe.
  reset()
  const p = stubProvider(false, 'UNKNOWN')
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  assert.equal(p.captures, 0)
})

test('F47: before the first pose, keyframes wait, even when the status reads NORMAL', async (t) => {
  reset()
  const p = stubProvider(false, 'NORMAL')
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  assert.equal(p.captures, 0)
})

// ─── F48: start, stop and rotate cannot open a second session ──────────────

test('F48: two start() calls at once open one session', async (t) => {
  reset()
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => s.stop())
  await Promise.all([s.start(), s.start()])
  assert.equal(postsTo('/sessions'), 1)
  assert.equal(s.sessionId, 'sess-1')
  assert.equal(s.active, true)
})

test('F48: a stream is not reported active while its session is still starting', async (t) => {
  reset()
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => s.stop())
  const starting = s.start()
  assert.equal(s.active, false)
  await starting
  assert.equal(s.active, true)
})

test('F48: a rotation with a start() racing it leaves exactly one session open', async (t) => {
  reset()
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => s.stop())
  await s.start()
  const rotation = s.rotate({})
  const racing = s.start()
  await Promise.all([rotation, racing])
  assert.equal(postsTo('/sessions'), 2, 'the rotation opened one new session, and the racing start opened none')
  assert.equal(postsTo('/sess-1/finalize'), 1, 'the old session was finalised once')
  assert.equal(s.sessionId, 'sess-2')
  assert.equal(s.active, true)
})

test('F48: a stop() that lands during start() closes the session it opened', async (t) => {
  reset()
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => s.stop())
  await Promise.all([s.start(), s.stop({})])
  assert.equal(postsTo('/sess-1/finalize'), 1)
  assert.equal(s.active, false)
  assert.equal(s.sessionId, null)
})

test('F48: a frame captured for a closed session is never uploaded into the next one', async (t) => {
  reset()
  const p = stubProvider(true, 'NORMAL')
  const s = streamerFor(p)
  t.after(() => s.stop())

  await s.start() // sess-1
  holdingUploads = true
  await tick(s) // frame A for sess-1; its upload is now held in flight
  p.moveTo(1)
  await tick(s) // frame B for sess-1; it waits in the queue behind A
  assert.equal(p.captures, 2)
  assert.equal(uploadsTo('sess-1'), 1)

  // Close without draining, as a page going away does, and open a new session.
  doc.visibilityState = 'hidden'
  await s.stop({})
  doc.visibilityState = 'visible'
  await s.start() // sess-2
  assert.equal(s.sessionId, 'sess-2')

  // A completes now, and B was still queued. Neither may reach sess-2.
  releaseHeldUploads()
  await settle()
  assert.equal(uploadsTo('sess-2'), 0, 'a sess-1 frame reached sess-2')
  assert.equal(uploadsTo('sess-1'), 1)
})

test('F48: starting again clears the poll handle before it is replaced', async (t) => {
  reset()
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => s.stop())
  // A poll handle left from an earlier session. unref() keeps a failing run from waiting on it.
  const stale = setInterval(() => {}, 3_600_000)
  stale.unref()
  ;(s as unknown as { _pollHandle: unknown })._pollHandle = stale
  const cleared: unknown[] = []
  const realClearInterval = globalThis.clearInterval
  t.mock.method(globalThis, 'clearInterval', (handle: unknown) => {
    cleared.push(handle)
    realClearInterval(handle as ReturnType<typeof setInterval>)
  })
  await s.start()
  assert.ok(cleared.includes(stale), 'the old poll handle was replaced without being cleared')
  assert.notEqual((s as unknown as { _pollHandle: unknown })._pollHandle, stale)
})

// ─── CAR-3: a failure after activation does not undo the activation ────────

test('CAR-3, CAR3-6: a listener that throws after activation is logged, and start() still resolves', async (t) => {
  reset()
  const warnings = t.mock.method(console, 'warn', () => {})
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  s.onStatus = () => {
    throw new Error('listener failed')
  }
  t.after(() => {
    s.onStatus = null
    return s.stop()
  })
  await s.start()
  assert.equal(s.active, true, 'the streamer went back to idle while its session was live')
  assert.equal(s.sessionId, 'sess-1')
  assert.ok(
    warnings.mock.calls.some((c) => String(c.arguments[0]).includes('listener threw')),
    'the listener error was not logged',
  )
})

test('CAR3-6: a listener that throws on the session id does not fail start() or the finalize', async (t) => {
  reset()
  t.mock.method(console, 'warn', () => {})
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  s.onSessionId = () => {
    throw new Error('listener failed')
  }
  t.after(() => s.stop())
  await s.start()
  assert.equal(s.active, true)
  assert.equal(s.sessionId, 'sess-1')
  await s.stop({})
  assert.equal(postsTo('/sess-1/finalize'), 1, 'the session was not finalised after the listener threw')
  assert.equal(s.active, false)
})

test('CAR3-7: a failed start is logged even when the caller drops the promise', async (t) => {
  reset()
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }))
  const warnings = t.mock.method(console, 'warn', () => {})
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  // The caller drops the promise, as src/main.ts does for stop() and rotate().
  void s.start()
  await settle()
  assert.equal(s.active, false)
  assert.ok(
    warnings.mock.calls.some((c) => String(c.arguments[0]).includes('transition failed')),
    'the failed start was not logged',
  )
})

test('CAR3-8: isTransitioning is true only while a start or a stop is in flight', async (t) => {
  reset()
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => s.stop())
  assert.equal(s.isTransitioning, false)
  const starting = s.start()
  assert.equal(s.isTransitioning, true, 'starting')
  await starting
  await settle()
  assert.equal(s.isTransitioning, false, 'started')

  // A stop drains the frame that is still uploading, so it stays in flight until the upload lands.
  holdingUploads = true
  await tick(s)
  const stopping = s.stop({})
  assert.equal(s.isTransitioning, true, 'stopping')
  releaseHeldUploads()
  await stopping
  assert.equal(s.isTransitioning, false, 'stopped')
})

// ─── WP-09: the epoch in each keyframe's meta ──────────────────────────────

/** A stub provider that reports a frame epoch, and stamps it on the frames it hands out. */
function epochProvider(epoch: number, stampsFrames: boolean): StubProvider & { epoch: number; getFrameEpoch(): number } {
  const p = Object.assign(stubProvider(true, 'NORMAL'), {
    epoch,
    getFrameEpoch(): number {
      return p.epoch
    },
  })
  const plain = p.captureFrame
  p.captureFrame = async () => {
    const frame = await plain()
    return stampsFrames ? { ...frame, epoch: p.epoch } : frame
  }
  return p
}

test('WP-09: a keyframe\'s meta carries the epoch the provider stamped on the frame', async (t) => {
  reset()
  const p = epochProvider(3, true)
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  assert.equal(uploadedMeta.length, 1)
  assert.equal(uploadedMeta[0]['epoch'], 3)
})

test('WP-09: a frame stamped with an earlier epoch than the provider is in now keeps its own', async (t) => {
  // A frame the provider handed over after the next epoch began, as one that waited in a
  // camera queue would be. The stamp says which frame its pose is in; the provider's epoch
  // now says only where the provider has got to.
  reset()
  const p = epochProvider(2, false)
  const plain = p.captureFrame
  p.captureFrame = async () => ({ ...(await plain()), epoch: 1 })
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  assert.equal(uploadedMeta[0]['epoch'], 1)
})

test('WP-09: a frame with no stamp is labelled with the provider\'s epoch', async (t) => {
  reset()
  const p = epochProvider(2, false)
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  assert.equal(uploadedMeta[0]['epoch'], 2)
})

test('WP-09: a provider with no epoch signal writes epoch 0', async (t) => {
  reset()
  const s = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  assert.equal(uploadedMeta[0]['epoch'], 0)
})

test('WP-09: the epoch is the frame\'s own, not the one the provider has moved on to while the JPEG was encoded', async (t) => {
  reset()
  const p = epochProvider(1, true)
  // A frame shift lands between the capture and the end of the encode.
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => {
    p.epoch = 2
    return { close(): void {} }
  }
  t.after(() => {
    ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ close(): void {} })
  })
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  assert.equal(p.epoch, 2, 'the shift happened')
  assert.equal(uploadedMeta[0]['epoch'], 1, 'a frame from before the shift was labelled with the epoch after it')
})

test('WP-09: frames across a shift in one session carry their own epochs', async (t) => {
  reset()
  const p = epochProvider(0, true)
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  p.epoch = 1
  p.moveTo(1)
  await tick(s)
  await settle()
  assert.deepEqual(uploadedMeta.map((m) => m['epoch']), [0, 1])
})

test('WP-09: an epoch that is not a number is not trusted: the provider\'s is used', async (t) => {
  reset()
  const p = epochProvider(4, false)
  const plain = p.captureFrame
  p.captureFrame = async () => ({ ...(await plain()), epoch: Number.NaN })
  const s = streamerFor(p)
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  assert.equal(uploadedMeta[0]['epoch'], 4)
})

// ─── WP-09b: the run in each keyframe's meta, and recording held while a re-anchor is asked ─────────────

test('WP-09b: a keyframe\'s meta carries the AR run the scan store was in, with the epoch a re-anchored scan began in, read as the frame is taken', async (t) => {
  reset()
  const p = stubProvider(true, 'NORMAL')
  let run: string | null = 'run-a'
  const s = new KeyframeStreamer(p as unknown as ARProvider, { minIntervalMs: 0, pollIntervalMs: 3_600_000, runId: () => run })
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  await settle()
  // A re-anchor changes the run the store is in: the next frame is the next scan's.
  run = 'run-a.2'
  p.moveTo(1)
  await tick(s)
  await settle()
  assert.deepEqual(uploadedMeta.map((m) => m['arRunId']), ['run-a', 'run-a.2'])
})

test('WP-09b: with no run to name the meta has no arRunId key, so a page that stamps none writes the meta it always did', async (t) => {
  reset()
  const plain = streamerFor(stubProvider(true, 'NORMAL'))
  t.after(() => plain.stop())
  await plain.start()
  await tick(plain)
  await settle()
  assert.equal('arRunId' in uploadedMeta[0]!, false, 'no option')

  reset()
  const none = new KeyframeStreamer(stubProvider(true, 'NORMAL') as unknown as ARProvider, { minIntervalMs: 0, pollIntervalMs: 3_600_000, runId: () => null })
  t.after(() => none.stop())
  await none.start()
  await tick(none)
  await settle()
  assert.equal('arRunId' in uploadedMeta[0]!, false, 'a run that has not started')
})

test('WP-09b: no keyframe is taken while recording is held, and the stream carries on when it is let go', async (t) => {
  reset()
  const p = stubProvider(true, 'NORMAL')
  let held = true
  const s = new KeyframeStreamer(p as unknown as ARProvider, { minIntervalMs: 0, pollIntervalMs: 3_600_000, hold: () => held })
  t.after(() => s.stop())
  await s.start()
  await tick(s)
  p.moveTo(1)
  await tick(s)
  assert.equal(p.captures, 0, 'nothing is added to the scan while the choice about its frame is open')
  assert.equal(s.active, true, 'the stream itself is not ended: the scan may go on')
  held = false
  await tick(s)
  await settle()
  assert.equal(p.captures, 1)
})
