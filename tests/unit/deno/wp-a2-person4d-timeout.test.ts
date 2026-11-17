/**
 * WP-A2 (F12): every request to the 4D subsystem carries a budget. A submit or
 * poll that never answers ends as a skip or an error inside that budget, and
 * does not hold the job slot open.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-a2-person4d-timeout.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import { runPerson4D } from '../../../server/person4d/person_4d.ts'

/** Never answers, and gives up only when its signal aborts. */
function hangUntilAborted(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
  })
}

async function withTake(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'wp-a2-person4d-' })
  try {
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const CLIP = {
  clientId: null,
  url: 'https://phone.example.test/clip.mp4',
  mimeType: 'video/mp4',
  poseTrackUrl: null,
  sync: null,
}

Deno.test('runPerson4D: a submit that never answers is skipped inside its request budget', async () => {
  await withTake(async (dir) => {
    const started = performance.now()
    const result = await runPerson4D({
      takeId: 'take-wp-a2-1',
      clips: [CLIP],
      sequenceDir: `${dir}/seq`,
      manifestPath: `${dir}/manifest.json`,
      host: 'http://gpu-box.example.test:9040',
      requestTimeoutMs: 50,
      _fetch: hangUntilAborted as unknown as typeof fetch,
      _sleep: async () => {},
    })
    const took = performance.now() - started

    assertEquals(result.status, 'skipped')
    assertStringIncludes(result.manifest.skippedReason ?? '', 'unreachable')
    assert(took < 5_000, `took ${took}ms; the submit was not bounded`)
  })
})

Deno.test('runPerson4D: a poll that never answers ends the run as an error, not a hang', async () => {
  await withTake(async (dir) => {
    let calls = 0
    const fetchStub = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++
      if (String(url).endsWith('/takes')) {
        // The submit is accepted, so the run reaches the poll loop.
        return Promise.resolve(new Response(JSON.stringify({ attached: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      }
      return hangUntilAborted(url, init)
    }

    const started = performance.now()
    const result = await runPerson4D({
      takeId: 'take-wp-a2-2',
      clips: [CLIP],
      sequenceDir: `${dir}/seq`,
      manifestPath: `${dir}/manifest.json`,
      host: 'http://gpu-box.example.test:9040',
      requestTimeoutMs: 50,
      maxWaitMs: 60_000,
      _fetch: fetchStub as unknown as typeof fetch,
      _sleep: async () => {},
    })
    const took = performance.now() - started

    assertEquals(result.status, 'error')
    assertStringIncludes(result.manifest.error ?? '', 'lost contact with the subsystem mid-run')
    assert(calls >= 2, 'the poll was never attempted')
    assert(took < 5_000, `took ${took}ms; the poll was not bounded`)
  })
})

Deno.test('runPerson4D: every request, including the sequence download, is sent with a timeout signal', async () => {
  // Drives the ok branch end to end: submit, one poll, the sequence listing and
  // one request per frame. Each of those five requests must carry a signal.
  await withTake(async (dir) => {
    const signalled: boolean[] = []
    const fetchStub = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      signalled.push(init?.signal instanceof AbortSignal)
      const path = String(url)
      if (path.endsWith('/takes')) {
        return Promise.resolve(new Response(JSON.stringify({ attached: true }), { status: 200 }))
      }
      if (path.endsWith('/sequence')) {
        const frames = ['frame-00000.sog', 'frame-00001.sog']
        return Promise.resolve(new Response(JSON.stringify({ frames }), { status: 200 }))
      }
      if (path.includes('/frames/')) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      }
      // The poll: the subsystem reports the take finished.
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'ok', frameCount: 2, viewSource: 'densified' }), { status: 200 }),
      )
    }
    const result = await runPerson4D({
      takeId: 'take-wp-a2-3',
      clips: [CLIP],
      sequenceDir: `${dir}/seq`,
      manifestPath: `${dir}/manifest.json`,
      host: 'http://gpu-box.example.test:9040',
      requestTimeoutMs: 5_000,
      _fetch: fetchStub as unknown as typeof fetch,
      _sleep: async () => {},
    })

    assertEquals(result.status, 'ok', `expected ok, got ${result.status}: ${result.log}`)
    assertEquals(result.manifest.frameCount, 2)
    assertEquals(signalled.length, 5, 'submit, poll, sequence listing and two frames')
    assert(signalled.every(Boolean), 'a request went out with no timeout signal')
  })
})
