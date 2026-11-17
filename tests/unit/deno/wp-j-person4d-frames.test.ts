/**
 * WP-J (J4, J5): the 4D request budget read from the environment is capped at
 * the longest timer, so an oversized value cannot abort every request at once;
 * and a frame whose body read runs out of time is skipped with its name and the
 * reason logged, while the manifest keeps the shortfall count.
 *
 * Run: deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit/deno/wp-j-person4d-frames.test.ts
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'
import { resolveParams, runPerson4D } from '../../../server/person4d/person_4d.ts'

const CLIP = {
  clientId: null,
  url: 'https://phone.example.test/clip.mp4',
  mimeType: 'video/mp4',
  poseTrackUrl: null,
  sync: null,
}

const TAKE_OPTS = {
  takeId: 'take-wp-j-1',
  clips: [CLIP],
  host: 'http://gpu-box.example.test:9040',
}

/** The largest delay a timer accepts. A larger request budget is capped at this. */
const MAX_TIMER_MS = 2_147_483_647

Deno.test('resolveParams: an oversized FDANYONE_REQUEST_TIMEOUT_MS is capped at the longest timer', () => {
  const name = 'FDANYONE_REQUEST_TIMEOUT_MS'
  const previous = Deno.env.get(name)
  try {
    Deno.env.set(name, '99999999999')
    assertEquals(resolveParams({ ...TAKE_OPTS, sequenceDir: '/x', manifestPath: '/x/m.json' }).requestTimeoutMs, MAX_TIMER_MS)

    Deno.env.set(name, '5000')
    assertEquals(resolveParams({ ...TAKE_OPTS, sequenceDir: '/x', manifestPath: '/x/m.json' }).requestTimeoutMs, 5000)

    Deno.env.set(name, 'not-a-number')
    assertEquals(resolveParams({ ...TAKE_OPTS, sequenceDir: '/x', manifestPath: '/x/m.json' }).requestTimeoutMs, 2 * 60 * 1000)
  } finally {
    if (previous === undefined) Deno.env.delete(name)
    else Deno.env.set(name, previous)
  }
})

Deno.test('runPerson4D: an oversized request budget does not abort the submit at once', async () => {
  const name = 'FDANYONE_REQUEST_TIMEOUT_MS'
  const previous = Deno.env.get(name)
  const dir = await Deno.makeTempDir({ prefix: 'wp-j-person4d-' })
  try {
    Deno.env.set(name, '99999999999')
    const abortedLater: boolean[] = []
    const fetchStub = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      // Let a fired timer, if any, have its turn before reading the signal.
      await new Promise((resolve) => setTimeout(resolve, 20))
      abortedLater.push(init?.signal?.aborted === true)
      if (String(url).endsWith('/takes')) {
        return new Response(JSON.stringify({ attached: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'skipped', remediation: 'stop here' }), { status: 200 })
    }
    const result = await runPerson4D({
      ...TAKE_OPTS,
      sequenceDir: `${dir}/seq`,
      manifestPath: `${dir}/manifest.json`,
      _fetch: fetchStub as unknown as typeof fetch,
      _sleep: async () => {},
    })

    assertEquals(result.status, 'skipped', 'the run reached the poll, not an unreachable skip')
    assertEquals(abortedLater[0], false, 'the submit was aborted by an oversized timer')
  } finally {
    if (previous === undefined) Deno.env.delete(name)
    else Deno.env.set(name, previous)
    await Deno.remove(dir, { recursive: true })
  }
})

/** A body that never finishes, and fails with the signal's reason when the signal aborts, as a stalled download does. */
function stalledResponse(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason))
    },
  })
  return new Response(body, { status: 200 })
}

Deno.test('runPerson4D: a frame whose body read times out is skipped, named and logged, and the shortfall is kept', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wp-j-person4d-' })
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '))
  }
  try {
    const fetchStub = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(url)
      if (path.endsWith('/takes')) {
        return Promise.resolve(new Response(JSON.stringify({ attached: true }), { status: 200 }))
      }
      if (path.endsWith('/sequence')) {
        const frames = ['frame-00000.sog', 'frame-00001.sog', 'frame-00002.sog']
        return Promise.resolve(new Response(JSON.stringify({ frames }), { status: 200 }))
      }
      if (path.endsWith('/frames/frame-00000.sog')) return Promise.resolve(stalledResponse(init?.signal))
      if (path.endsWith('/frames/frame-00001.sog')) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      }
      if (path.endsWith('/frames/frame-00002.sog')) return Promise.resolve(new Response('gone', { status: 404 }))
      // The poll: the take finished with three frames.
      return Promise.resolve(
        new Response(JSON.stringify({ status: 'ok', frameCount: 3, viewSource: 'densified' }), { status: 200 }),
      )
    }

    const result = await runPerson4D({
      ...TAKE_OPTS,
      sequenceDir: `${dir}/seq`,
      manifestPath: `${dir}/manifest.json`,
      requestTimeoutMs: 50,
      _fetch: fetchStub as unknown as typeof fetch,
      _sleep: async () => {},
    })

    assertEquals(result.status, 'ok', `expected ok, got ${result.status}: ${result.log}`)
    assertEquals(result.manifest.frameCount, 1, 'the manifest reports what landed')
    assertStringIncludes(result.log, '(2 frame(s) did not transfer)')

    const joined = warnings.join('\n')
    assertStringIncludes(joined, 'skipped frame-00000.sog: timed out after 50 ms')
    assertStringIncludes(joined, 'skipped frame-00002.sog: subsystem returned HTTP 404')
    assert(!joined.includes('frame-00001.sog'), 'a frame that landed was reported as skipped')

    const landed = [...Deno.readDirSync(`${dir}/seq`)].map((e) => e.name).sort()
    assertEquals(landed, ['frame-00001.sog'])
  } finally {
    console.warn = realWarn
    await Deno.remove(dir, { recursive: true })
  }
})
