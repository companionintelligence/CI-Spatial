/**
 * Deno unit tests for the 4D person driver surface.
 *
 * The real subsystem needs a CUDA GPU with ~44 GiB, which no host on this fleet
 * has — so, like `splat_train.test.ts` with the Brush binary, these cover only
 * the TS side: param precedence, request assembly, validation, and the
 * "unreachable → skipped manifest" fallback the coordinator depends on.
 *
 * The most load-bearing assertion is that an unconfigured subsystem produces
 * `skipped`, never `error`. That is what keeps the appliance working with no
 * GPU host attached.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import {
  buildSubmitRequest,
  isValidViewsPerLayer,
  resolveParams,
  runPerson4D,
} from '../../../server/person4d/person_4d.ts'

const clip = {
  clientId: 'client-a',
  url: 'https://host/sessions/sess-1/clip/clip.mp4',
  mimeType: 'video/mp4',
  poseTrackUrl: null,
  sync: null,
}

async function tmpDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: 'person4d-test-' })
}

function baseOpts(dir: string, over: Record<string, unknown> = {}) {
  return {
    takeId: 'take-abc',
    clips: [clip],
    sequenceDir: `${dir}/seq`,
    manifestPath: `${dir}/out.4d-capture.manifest.json`,
    _sleep: () => Promise.resolve(),
    ...over,
  }
}

Deno.test('views_per_layer must be divisible by 4 or 6', () => {
  for (const good of [4, 6, 8, 12, 16, 24, 48]) assert(isValidViewsPerLayer(good), `${good}`)
  for (const bad of [1, 2, 3, 5, 7, 10, 0, -6, 6.5]) assertFalse(isValidViewsPerLayer(bad), `${bad}`)
})

Deno.test('resolveParams: explicit option beats env beats default', () => {
  Deno.env.set('FDANYONE_VIEWS_PER_LAYER', '24')
  try {
    // env wins over the default
    assertEquals(resolveParams(baseOpts('/tmp') as never).viewsPerLayer, 24)
    // explicit wins over env
    assertEquals(resolveParams(baseOpts('/tmp', { viewsPerLayer: 12 }) as never).viewsPerLayer, 12)
  } finally {
    Deno.env.delete('FDANYONE_VIEWS_PER_LAYER')
  }
  // default when neither is set
  assertEquals(resolveParams(baseOpts('/tmp') as never).viewsPerLayer, 6)
})

Deno.test('resolveParams strips a trailing slash from the host', () => {
  assertEquals(resolveParams(baseOpts('/tmp', { host: 'https://gpu:9000/' }) as never).host, 'https://gpu:9000')
})

Deno.test('buildSubmitRequest assembles a stable payload without a network', () => {
  const opts = baseOpts('/tmp', { host: 'https://gpu:9000' }) as never
  const req = buildSubmitRequest(opts, resolveParams(opts))
  assertEquals(req.takeId, 'take-abc')
  assertEquals(req.clips.length, 1)
  assertEquals(req.clips[0].url, clip.url)
  assertEquals(req.params.viewsPerLayer, 6)
  assertEquals(req.params.timestepFps, 5)
})

Deno.test('an unsynced member is passed through as null, never as a fake measurement', () => {
  const opts = baseOpts('/tmp', { host: 'https://gpu:9000' }) as never
  const req = buildSubmitRequest(opts, resolveParams(opts))
  assertEquals(req.clips[0].sync, null)
})

Deno.test('FDANYONE_HOST unset → skipped with remediation, and a manifest is still written', async () => {
  const dir = await tmpDir()
  try {
    const result = await runPerson4D(baseOpts(dir) as never)
    assertEquals(result.status, 'skipped')
    assertEquals(result.manifest.status, 'skipped')
    assert(result.manifest.remediation?.includes('FDANYONE_HOST'))
    // The manifest exists on every path, including this one.
    const written = JSON.parse(await Deno.readTextFile(`${dir}/out.4d-capture.manifest.json`))
    assertEquals(written.status, 'skipped')
    assertEquals(written.tool, '4d-capture')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('an unreachable subsystem is skipped, not error — the appliance keeps working', async () => {
  const dir = await tmpDir()
  try {
    const result = await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      _fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    }) as never)
    // This is the contract that matters: no GPU host attached must never be a
    // red job, matching BRUSH_BIN and LINGBOT_MAP_*.
    assertEquals(result.status, 'skipped')
    assert(result.manifest.skippedReason?.includes('unreachable'))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a 5xx from the subsystem is an error, and writes a manifest', async () => {
  const dir = await tmpDir()
  try {
    const result = await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      _fetch: () => Promise.resolve(new Response('nope', { status: 500 })),
    }) as never)
    assertEquals(result.status, 'error')
    const written = JSON.parse(await Deno.readTextFile(`${dir}/out.4d-capture.manifest.json`))
    assertEquals(written.status, 'error')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('an invalid views_per_layer fails before any network call', async () => {
  const dir = await tmpDir()
  let called = false
  try {
    const result = await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      viewsPerLayer: 7,
      _fetch: () => { called = true; return Promise.resolve(new Response('{}')) },
    }) as never)
    assertEquals(result.status, 'error')
    assert(result.manifest.error?.includes('divisible by 4 or 6'))
    assertFalse(called, 'a bad value must be caught before spawning a 25-minute job')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a take with no clips is an error, not a skip', async () => {
  const dir = await tmpDir()
  try {
    const result = await runPerson4D(baseOpts(dir, { host: 'https://gpu:9000', clips: [] }) as never)
    assertEquals(result.status, 'error')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a completed run records viewSource and frame count', async () => {
  const dir = await tmpDir()
  try {
    let call = 0
    const result = await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      _fetch: (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/takes')) return Promise.resolve(Response.json({ attached: false }))
        // The sequence must be pulled back to the appliance before anything is
        // playable, so the driver fetches the listing and then each frame.
        if (url.endsWith('/sequence')) {
          return Promise.resolve(Response.json({ frames: ['frame-00000.ply', 'frame-00001.ply'] }))
        }
        if (url.includes('/frames/')) return Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
        call++
        if (call < 2) return Promise.resolve(Response.json({ status: 'running', progress: 0.4, stage: 'densify' }))
        return Promise.resolve(Response.json({
          status: 'ok', viewSource: 'densified', viewCount: 6, frameCount: 24, fps: 5, durationMs: 4800,
        }))
      },
    }) as never)
    assertEquals(result.status, 'ok')
    assertEquals(result.manifest.viewSource, 'densified')
    // frameCount reports what actually transferred, not what the subsystem
    // claimed — a manifest promising 24 frames when 2 landed would loop the
    // viewer over files that are not there.
    assertEquals(result.manifest.frameCount, 2)
    assertEquals(result.manifest.clipCount, 1)
    assertEquals(result.manifest.sequenceDir, `${dir}/seq`)
    // The frames are on disk where the serve route reads from.
    assertEquals([...Deno.readDirSync(`${dir}/seq`)].length, 2)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('re-attaching to a running job is reported, not treated as a fresh submit', async () => {
  const dir = await tmpDir()
  try {
    const stages: string[] = []
    await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      onProgress: (_f: number, stage: string) => stages.push(stage),
      _fetch: (input: string | URL | Request) => {
        const url = String(input)
        // Idempotent submit: the subsystem reports it already had this take.
        if (url.endsWith('/takes')) return Promise.resolve(Response.json({ attached: true }))
        if (url.endsWith('/sequence')) return Promise.resolve(Response.json({ frames: ['frame-00000.ply'] }))
        if (url.includes('/frames/')) return Promise.resolve(new Response(new Uint8Array([7])))
        return Promise.resolve(Response.json({ status: 'ok', frameCount: 3 }))
      },
    }) as never)
    assert(stages.some(s => s.includes('re-attached')), `stages were ${JSON.stringify(stages)}`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a multi-camera take records that 4DAnyone was skipped', async () => {
  const dir = await tmpDir()
  try {
    const result = await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      clips: [clip, { ...clip, clientId: 'client-b' }, { ...clip, clientId: 'client-c' }],
      _fetch: (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/takes')) return Promise.resolve(Response.json({ attached: false }))
        if (url.endsWith('/sequence')) return Promise.resolve(Response.json({ frames: ['frame-00000.sog'] }))
        if (url.includes('/frames/')) return Promise.resolve(new Response(new Uint8Array([9])))
        return Promise.resolve(Response.json({ status: 'ok', viewSource: 'multi-camera', frameCount: 24 }))
      },
    }) as never)
    assertEquals(result.manifest.viewSource, 'multi-camera')
    assertEquals(result.manifest.clipCount, 3)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a run whose sequence cannot be transferred is an error, not a green job', async () => {
  // The gap this test exists for: the driver used to record the manifest and
  // report success without pulling the frames back, so the manifest resolved
  // and every frame 404'd — a reconstruction that looked complete right up
  // until the viewer tried to play it.
  const dir = await tmpDir()
  try {
    const result = await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      _fetch: (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/takes')) return Promise.resolve(Response.json({ attached: false }))
        if (url.endsWith('/sequence')) return Promise.resolve(new Response('nope', { status: 500 }))
        return Promise.resolve(Response.json({ status: 'ok', frameCount: 24 }))
      },
    }) as never)
    assertEquals(result.status, 'error')
    assert(result.manifest.error?.includes('sequence transfer failed'))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a partial transfer reports what landed, not what was promised', async () => {
  const dir = await tmpDir()
  try {
    const result = await runPerson4D(baseOpts(dir, {
      host: 'https://gpu:9000',
      _fetch: (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/takes')) return Promise.resolve(Response.json({ attached: false }))
        if (url.endsWith('/sequence')) {
          return Promise.resolve(Response.json({ frames: ['frame-00000.ply', 'frame-00001.ply', 'frame-00002.ply'] }))
        }
        // The middle frame fails to transfer.
        if (url.includes('frame-00001')) return Promise.resolve(new Response('gone', { status: 404 }))
        if (url.includes('/frames/')) return Promise.resolve(new Response(new Uint8Array([1])))
        return Promise.resolve(Response.json({ status: 'ok', frameCount: 3 }))
      },
    }) as never)
    assertEquals(result.status, 'ok')
    assertEquals(result.manifest.frameCount, 2, 'must report the 2 that landed, not the 3 promised')
    assert(result.log.includes('did not transfer'))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
