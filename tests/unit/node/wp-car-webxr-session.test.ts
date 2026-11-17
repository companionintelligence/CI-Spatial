/**
 * CAR-5 and CAR-6: a WebXR session that ends while setup is still waiting is not
 * used after the end, and a capture after the end fails at once.
 *
 * setUpSession() waits on the companion camera prompt before it touches the
 * session. If the browser ends the session while that prompt is open, stop() has
 * already run, so setup must throw and start() must reject. It must not resolve
 * or dereference a null session. A camera stream that arrives after the teardown
 * must be released, because stop() never saw it.
 *
 * CAR3-9: a session that ends while renderer.xr.setSession() is pending is handled the
 * same way. The waits that depend on a fix are bounded by settledWithin(), so a
 * regression fails the test instead of hanging the run.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-car-webxr-session.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebXRProvider } from '../../../src/ar/webxr.ts'

// ─── Browser globals the provider touches ──────────────────────────────────

;(globalThis as { document?: unknown }).document = {
  body: {},
  visibilityState: 'visible',
  addEventListener(): void {},
  createElement: () => ({ play: async () => {} }),
}

interface FakeSession {
  endCalls: number
  listeners: Record<string, Array<() => void>>
  addEventListener(type: string, listener: () => void): void
  removeEventListener(): void
  end(): Promise<void>
  requestAnimationFrame(callback: (time: number, frame: unknown) => void): number
  updateRenderState(): void
  requestReferenceSpace(kind: string): Promise<object>
}

function fakeSession(): FakeSession {
  const s: FakeSession = {
    endCalls: 0,
    listeners: {},
    addEventListener(type, listener) {
      ;(s.listeners[type] ??= []).push(listener)
    },
    removeEventListener(): void {},
    end: async () => {
      s.endCalls++
    },
    requestAnimationFrame: () => 0,
    updateRenderState(): void {},
    requestReferenceSpace: async () => ({}),
  }
  return s
}

interface CameraPrompt {
  resolve: (stream: unknown) => void
  reject: (error: unknown) => void
}

/** The session a start() will be handed, and the camera prompt setup is waiting on. */
const world: { session: FakeSession; cameraAsked: number; prompt: CameraPrompt | null } = {
  session: fakeSession(),
  cameraAsked: 0,
  prompt: null,
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    xr: { requestSession: async () => world.session },
    mediaDevices: {
      // The prompt stays open until the test answers it.
      getUserMedia: () => {
        world.cameraAsked++
        return new Promise<unknown>((resolve, reject) => {
          world.prompt = { resolve, reject }
        })
      },
    },
  },
})

function canvas(): HTMLCanvasElement {
  return {
    width: 360,
    height: 640,
    style: {},
    getContext: () => null,
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as HTMLCanvasElement
}

type Internals = {
  session: FakeSession | null
  captureQueue: Array<{ resolve: (f: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>
}
const internals = (p: WebXRProvider): Internals => p as unknown as Internals

function reset(): void {
  world.session = fakeSession()
  world.cameraAsked = 0
  world.prompt = null
}

/** Lets the queued promise callbacks run until setup has asked for the camera. */
async function untilCameraAsked(): Promise<CameraPrompt> {
  for (let i = 0; i < 200 && world.cameraAsked === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.ok(world.prompt, 'setup never asked for the camera')
  return world.prompt
}

// Real timers, read before any test mocks setTimeout, so the bound below cannot be mocked away.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/**
 * Waits for the promise, or fails the test after about 2 s. Without the bound, a
 * regression that never settles the promise would hang the whole run.
 */
async function settledWithin<T>(promise: Promise<T>, what: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    realClearTimeout(timer)
  }
}

// three.js builds an XRWebGLLayer for the session when the browser has no XR binding, as Node has not.
;(globalThis as { XRWebGLLayer?: unknown }).XRWebGLLayer = class {
  framebufferWidth = 640
  framebufferHeight = 480
  ignoreDepthValues = false
}

/** Values three.js reads back when it builds a renderer. Everything else is a stand-in. */
const glValues: Record<string, unknown> = {
  getParameter: (p: unknown) => (p === 'VERSION' ? 'WebGL 2.0 (test stub)' : 0),
  getSupportedExtensions: () => [],
  getContextAttributes: () => ({ xrCompatible: true, antialias: false, depth: true, stencil: false, alpha: true }),
  getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
  getExtension: () => null,
  getError: () => 0,
  checkFramebufferStatus: () => 0x8cd5,
}

/** A WebGL2 stand-in: any call returns another stand-in, and a GL constant reads back as its own name. */
function glStandIn(): unknown {
  const target = function (): void {}
  const stand: unknown = new Proxy(target, {
    get(_target, prop) {
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === Symbol.iterator) return function* () {}
        return undefined
      }
      if (prop === 'then') return undefined
      if (Object.hasOwn(glValues, prop)) return glValues[prop]
      if (/^[A-Z0-9_]+$/.test(prop)) return prop
      return stand
    },
    apply: () => stand,
    construct: () => stand as object,
  })
  return stand
}

/** A canvas whose WebGL context is good enough for setUpSession() to reach renderer.xr.setSession(). */
function canvasWithGl(): HTMLCanvasElement {
  return {
    width: 360,
    height: 640,
    style: {},
    getContext: () => glStandIn(),
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as HTMLCanvasElement
}

// ─── CAR-5: the session ends while the camera prompt is open ───────────────

test('CAR-5: a session that ends while the camera prompt is open makes start() reject, not resolve', async () => {
  reset()
  const session = world.session
  const provider = new WebXRProvider()
  const starting = provider.start(canvas())
  const prompt = await untilCameraAsked()

  // The browser ends the session while the prompt is still on screen.
  session.listeners.end[0]()
  assert.equal(internals(provider).session, null)

  // The prompt is answered after the teardown, with a stream that stop() never saw.
  let released = false
  prompt.resolve({ getTracks: () => [{ stop: () => { released = true } }] })

  await assert.rejects(settledWithin(starting, 'start()'), /AR session ended during setup/)
  assert.equal(released, true, 'the camera stream that arrived after teardown was left running')
})

test('CAR-5: a session that ends while the prompt is open still rejects when the camera is then refused', async () => {
  reset()
  const session = world.session
  const provider = new WebXRProvider()
  const starting = provider.start(canvas())
  const prompt = await untilCameraAsked()

  session.listeners.end[0]()
  // A refused camera is non-fatal on a live session, so what fails start() here
  // is the session having ended.
  prompt.reject(new Error('NotAllowedError'))

  await assert.rejects(settledWithin(starting, 'start()'), /AR session ended during setup/)
  assert.equal(internals(provider).session, null)
})

test('CAR3-9: a session that ends during renderer.xr.setSession() makes start() reject with the setup error', async () => {
  reset()
  const session = fakeSession()
  let refused = false
  session.requestReferenceSpace = async () => {
    // The first reference-space request is three.js's, made inside renderer.xr.setSession().
    // The browser ends the session as it refuses that request.
    if (refused) return {}
    refused = true
    for (const listener of session.listeners.end ?? []) listener()
    throw new Error('session ended')
  }
  world.session = session
  const provider = new WebXRProvider()
  const starting = provider.start(canvasWithGl())
  const prompt = await untilCameraAsked()

  let released = false
  prompt.resolve({ getTracks: () => [{ stop: () => { released = true } }] })

  // setUpSession() retries setSession() after the refusal. The liveSession() guard
  // throws the setup error there, so setSession() is never handed a null session.
  await assert.rejects(settledWithin(starting, 'start()'), /AR session ended during setup/)
  assert.equal(internals(provider).session, null)
  assert.equal(session.endCalls, 1, 'the session was not ended once, by the teardown')
  assert.equal(released, true, 'the camera stream was left running')
})

// ─── CAR-6: captures after the session has ended ───────────────────────────

test('CAR-6: captureFrame fails at once when there is no live session', async (t) => {
  reset()
  const provider = new WebXRProvider()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // No timer is ticked. A capture that waited for its timeout could not settle.
  await assert.rejects(settledWithin(provider.captureFrame(8_000), 'captureFrame'), /No AR session/)
  assert.equal(internals(provider).captureQueue.length, 0)
})

test('CAR-6: stop() fails a capture that is still waiting, without waiting out its timeout', async (t) => {
  reset()
  const provider = new WebXRProvider()
  internals(provider).session = world.session
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = provider.captureFrame(8_000)
  provider.stop()
  // No timer is ticked, so only the teardown can settle this capture.
  await assert.rejects(settledWithin(waiting, 'the capture waiting on stop()'), /AR session ended/)
  assert.equal(internals(provider).captureQueue.length, 0)
})
