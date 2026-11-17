/**
 * CAR4-3: isTransitioning stays true for the whole of a stop, including its finalize POST.
 *
 * A stop sets the streamer back to idle before it sends the finalize POST, so the state
 * alone reads false while that POST is pending. main.ts ignores stream-toggle taps while
 * isTransitioning is true, so during the POST a tap was not ignored. The getter also reads
 * the serialised transition promise, which settles only once the POST has. The test also
 * checks that the getter has cleared by the time an awaiting caller resumes.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-car4-keyframes-finalize.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyframeStreamer } from '../../../src/capture/keyframes.ts'
import type { ARProvider } from '../../../src/ar/provider.ts'

// ─── Browser globals the streamer touches ──────────────────────────────────

;(globalThis as { document?: unknown }).document = {
  visibilityState: 'visible',
  addEventListener(): void {},
}

interface Gate {
  promise: Promise<void>
  open(): void
}

function gate(): Gate {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** While set, the next finalize POST reports that it arrived and then waits for release. */
let heldFinalize: { arrived: Gate; release: Gate } | null = null
let failFinalize = false
let finalizePosts = 0
let sessionCounter = 0

;(globalThis as { fetch?: unknown }).fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  if (url === '/sessions' && method === 'POST') {
    sessionCounter++
    return new Response(JSON.stringify({ sessionId: `sess-${sessionCounter}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/finalize') && method === 'POST') {
    finalizePosts++
    if (failFinalize) throw new Error('network down')
    if (heldFinalize) {
      heldFinalize.arrived.open()
      await heldFinalize.release.promise
    }
  }
  return new Response('{}', { status: 200 })
}

function reset(): void {
  heldFinalize = null
  failFinalize = false
  finalizePosts = 0
  sessionCounter = 0
}

/** Poll cadence set far out, so no keyframe tick runs. The tests drive only the transitions. */
function streamer(): KeyframeStreamer {
  return new KeyframeStreamer({} as ARProvider, { pollIntervalMs: 3_600_000 })
}

test('CAR4-3: isTransitioning stays true while a stop\'s finalize POST is pending, and clears once it settles', { timeout: 5_000 }, async (t) => {
  reset()
  const held = { arrived: gate(), release: gate() }
  t.after(() => held.release.open())
  const s = streamer()
  // Registered after the release: after hooks run in the order they are added, and a stop() still
  // waiting on the held finalize can only settle once the release has opened.
  t.after(() => s.stop({}))
  await s.start()
  assert.equal(s.isTransitioning, false, 'a started streamer reads as transitioning')

  heldFinalize = held
  const stopping = s.stop({ glbFilename: 'scan.glb' })
  await held.arrived.promise
  assert.equal(s.active, false, 'the streamer is still active after stop()')
  assert.equal(s.sessionId, null, 'the session id was not cleared before the finalize POST')
  assert.equal(s.isTransitioning, true, 'the finalize POST is pending, but isTransitioning reads false')

  held.release.open()
  await stopping
  assert.equal(finalizePosts, 1, 'the finalize POST was not sent exactly once')
  assert.equal(s.isTransitioning, false, 'the stop has settled, but isTransitioning still reads true')
})

test('CAR4-3: a finalize that fails still ends the transition, and the failure is logged', { timeout: 5_000 }, async (t) => {
  reset()
  failFinalize = true
  const warnings = t.mock.method(console, 'warn', () => {})
  const s = streamer()
  await s.start()
  await s.stop({})
  assert.equal(s.isTransitioning, false, 'a failed finalize left the streamer transitioning')
  assert.ok(
    warnings.mock.calls.some((c) => String(c.arguments[0]).includes('finalize failed')),
    'the failed finalize was not logged',
  )
})
