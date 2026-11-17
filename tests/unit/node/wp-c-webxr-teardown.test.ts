/**
 * WP-C / F64: a WebXR session that ends, or a start that fails after the session
 * opened, is torn down. Captures waiting on a frame are failed with a plain
 * reason, and hit tests cannot wait forever.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-c-webxr-teardown.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebXRProvider } from '../../../src/ar/webxr.ts'

// ─── Browser globals the provider touches ──────────────────────────────────

;(globalThis as { document?: unknown }).document = {
  body: {},
  visibilityState: 'visible',
  addEventListener(): void {},
  createElement: () => ({}),
}

class FakeXRRay {
  origin: unknown
  direction: unknown
  constructor(origin: unknown, direction: unknown) {
    this.origin = origin
    this.direction = direction
  }
}
;(globalThis as { XRRay?: unknown }).XRRay = FakeXRRay

interface FakeSession {
  endCalls: number
  listeners: Record<string, Array<() => void>>
  requestHitTestSource?: (options: unknown) => Promise<{ cancel(): void }>
  addEventListener(type: string, listener: () => void): void
  end(): Promise<void>
  requestAnimationFrame(callback: (time: number, frame: unknown) => void): number
  requestReferenceSpace(kind: string): Promise<object>
}

function fakeSession(): FakeSession {
  const s: FakeSession = {
    endCalls: 0,
    listeners: {},
    addEventListener(type, listener) {
      ;(s.listeners[type] ??= []).push(listener)
    },
    end: async () => {
      s.endCalls++
    },
    requestAnimationFrame: () => 0,
    requestReferenceSpace: async () => ({}),
  }
  return s
}

/** The session a start() will be handed. Tests point this at whichever session they need. */
let nextSession: FakeSession = fakeSession()
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    xr: { requestSession: async () => nextSession },
    mediaDevices: { getUserMedia: async () => { throw new Error('no camera in this test') } },
  },
})

/** A canvas with no WebGL context, so the renderer fails after the session has opened. */
function canvasWithoutWebGL(): HTMLCanvasElement {
  return {
    width: 360,
    height: 640,
    style: {},
    getContext: () => null,
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as HTMLCanvasElement
}

/** Accessors for the private state these tests set up and inspect. */
type Internals = {
  session: FakeSession | null
  captureQueue: Array<{ resolve: (f: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>
  viewerSpace: object | null
  refSpace: object | null
}
const internals = (p: WebXRProvider): Internals => p as unknown as Internals

test('F64: a session that opens registers its end listener before setup can fail', async () => {
  const session = fakeSession()
  nextSession = session
  const provider = new WebXRProvider()
  await provider.start(canvasWithoutWebGL()).catch(() => undefined)
  assert.equal(session.listeners.end?.length, 1)
})

test('F64: a failed setup after the session opened ends that session and rejects the start', async () => {
  const session = fakeSession()
  nextSession = session
  const provider = new WebXRProvider()
  await assert.rejects(provider.start(canvasWithoutWebGL()))
  assert.equal(session.endCalls, 1, 'the session was not ended')
  assert.equal(internals(provider).session, null)
  assert.equal(provider.isTracking(), false)
})

test('F64: the browser ending the session fails waiting captures and tears down', async () => {
  const session = fakeSession()
  nextSession = session
  const provider = new WebXRProvider()
  await provider.start(canvasWithoutWebGL()).catch(() => undefined)
  const endListener = session.listeners.end[0]

  // Put the provider back into a live state, with one capture waiting on a frame.
  const endsBefore = session.endCalls
  internals(provider).session = session
  const rejections: Error[] = []
  const waiting = new Promise<unknown>((resolve, reject) => {
    internals(provider).captureQueue.push({
      resolve,
      reject: (e) => {
        rejections.push(e)
        reject(e)
      },
      timeout: setTimeout(() => {}, 60_000),
    })
  })
  waiting.catch(() => undefined)

  endListener()

  assert.equal(rejections.length, 1)
  assert.match(rejections[0].message, /AR session ended/)
  assert.equal(internals(provider).captureQueue.length, 0)
  assert.equal(session.endCalls, endsBefore + 1, 'the session was not ended on teardown')
  assert.equal(internals(provider).session, null)
  assert.equal(provider.isTracking(), false)
})

test('F64: an end event for a session that was already replaced is ignored', async () => {
  const first = fakeSession()
  nextSession = first
  const provider = new WebXRProvider()
  await provider.start(canvasWithoutWebGL()).catch(() => undefined)
  const staleEnd = first.listeners.end[0]

  const second = fakeSession()
  internals(provider).session = second
  staleEnd()

  assert.equal(internals(provider).session, second, 'the replacement session was torn down by a stale end')
  assert.equal(second.endCalls, 0)
})

test('F64: a hit test whose frame never comes resolves null after the timeout', async (t) => {
  const provider = new WebXRProvider()
  const session = fakeSession()
  session.requestHitTestSource = async () => ({ cancel(): void {} })
  // requestAnimationFrame never calls back, as after the session has ended.
  internals(provider).session = session
  internals(provider).viewerSpace = {}
  internals(provider).refSpace = {}

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = provider.hitTestAsync(0.5, 0.5)
  t.mock.timers.tick(1_000)
  assert.equal(await pending, null)
})
