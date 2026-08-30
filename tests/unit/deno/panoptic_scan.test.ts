/**
 * Panoptic-scan driver and segment policy.
 *
 * Deliberately exercises the whole driver with NO model, venv or GPU present:
 * every guard, the worker spawn, and the read-back are covered through the
 * `_spawn` seam, so this lands and stays green before anything is downloaded.
 * The only code a real model would add coverage for is the model call itself.
 *
 * Run: deno task test
 */
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import { parseDeviceLine, resolveParams, runPanopticScan } from '../../../server/panoptic/panoptic_scan.ts'
import {
  MIN_SEGMENT_PIXELS,
  splitPanopticSegments,
} from '../../../server/panoptic/panoptic_segments.ts'

const seg = (over: Record<string, unknown> = {}) => ({
  label: 'chair',
  isThing: true,
  score: 0.9,
  areaPx: 20_000,
  centroidPx: [360, 480],
  ...over,
})

// ── segment policy ──────────────────────────────────────────────────────────

Deno.test('things and stuff are separated', () => {
  const out = splitPanopticSegments([{
    file: 'kf-00000.jpg',
    segments: [seg(), seg({ label: 'wall', isThing: false }), seg({ label: 'table' })],
  }])
  assertEquals(out.things.map((t) => t.label), ['chair', 'table'])
  assertEquals(out.stuff.map((s) => s.label), ['wall'])
})

Deno.test('an unknown isThing is treated as STUFF, not as a thing', () => {
  // The asymmetry is the point: mis-filing a chair as stuff loses one visible
  // detection, while mis-filing a wall as a thing pushes toward
  // MAX_THINGS_PER_WORLD, which throws and which nothing prunes.
  const out = splitPanopticSegments([{
    file: 'kf-00000.jpg',
    // `null` is what the worker ACTUALLY emits: verified against
    // facebook/mask2former-swin-large-ade-panoptic, whose config carries no
    // thing_ids and whose segments_info is only {id, label_id, score,
    // was_fused} — so there is nothing to derive the split from.
    segments: [seg({ isThing: null }), seg({ isThing: undefined }), seg({ isThing: 'yes' }), seg({ isThing: 1 })],
  }])
  assertEquals(out.things.length, 0)
  assertEquals(out.stuff.length, 4)
})

Deno.test('slivers below the pixel floor are dropped', () => {
  // A 30px sliver's centroid is an artefact of where two segments meet, not a
  // position — fusing on it would scatter phantom Things around the room.
  const out = splitPanopticSegments([{
    file: 'kf-00000.jpg',
    segments: [seg({ areaPx: 30 }), seg({ areaPx: MIN_SEGMENT_PIXELS })],
  }])
  assertEquals(out.things.length, 1)
  assertEquals(out.dropped, 1)
})

Deno.test('malformed segments are dropped, not coerced', () => {
  const out = splitPanopticSegments([{
    file: 'kf-00000.jpg',
    segments: [
      seg({ label: '' }),
      seg({ label: '   ' }),
      seg({ score: 'high' }),
      seg({ score: 1.4 }),
      seg({ score: -0.1 }),
      seg({ centroidPx: [360] }),
      seg({ centroidPx: 'centre' }),
      seg({ areaPx: Number.NaN }),
    ],
  }])
  assertEquals(out.things.length, 0)
  assertEquals(out.stuff.length, 0)
  assertEquals(out.dropped, 8)
})

Deno.test('a frame with no filename cannot be attributed, so its segments drop', () => {
  const out = splitPanopticSegments([{ segments: [seg(), seg()] }])
  assertEquals(out.things.length, 0)
  assertEquals(out.dropped, 2)
})

Deno.test('label whitespace is trimmed so fusion does not see two vocabularies', () => {
  const out = splitPanopticSegments([{ file: 'kf-00000.jpg', segments: [seg({ label: '  chair ' })] }])
  assertEquals(out.things[0].label, 'chair')
})

Deno.test('the mask bbox and centroid-on-mask flag are carried through when present', () => {
  // Both feed the 3-D lift: the bbox gives a tighter angular footprint for an
  // elongated mask, and the flag lets a centroid that is not on its own object
  // abstain instead of measuring whatever is behind it. See
  // docs/pipelines/panoptic-scan.md — "Lifting a segment to a world position".
  const out = splitPanopticSegments([{
    file: 'kf-00000.jpg',
    segments: [seg({ bboxPx: [10, 20, 110, 520], centroidOnMask: false })],
  }])
  assertEquals(out.things[0].bboxPx, [10, 20, 110, 520])
  assertEquals(out.things[0].centroidOnMask, false)
})

Deno.test('an absent bbox or flag stays absent — never defaulted', () => {
  // A segments file written before the worker emitted these is still a good
  // file; re-running costs a GPU pass over up to 64 frames. `undefined` means
  // "not reported", and the lift must not read that as `false`.
  const out = splitPanopticSegments([{ file: 'kf-00000.jpg', segments: [seg()] }])
  assertEquals(out.things[0].bboxPx, undefined)
  assertEquals(out.things[0].centroidOnMask, undefined)
})

Deno.test('a malformed bbox is dropped while the segment survives', () => {
  // A defective box must not take a good detection with it, and must not reach
  // the lift, where an inverted box would collapse the cone to nothing and read
  // as 'no-geometry'.
  for (const bboxPx of [[10, 10, 0, 0], [1, 2, 3], 'nope', [1, 2, 3, Number.NaN], null]) {
    const out = splitPanopticSegments([{ file: 'kf-00000.jpg', segments: [seg({ bboxPx })] }])
    assertEquals(out.things.length, 1, `bbox ${JSON.stringify(bboxPx)} dropped the segment`)
    assertEquals(out.things[0].bboxPx, undefined)
  }
})

// ── driver guards ───────────────────────────────────────────────────────────

Deno.test('a missing python is skipped with a remediation, never an error', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const m = await runPanopticScan({ sessionDir: dir, python: `${dir}/definitely-not-python` })
    assertEquals(m.status, 'skipped')
    assertStringIncludes(m.remediation ?? '', 'PANOPTIC_PYTHON')
    // The manifest must land even on the skip path — the UI reads it.
    const onDisk = JSON.parse(await Deno.readTextFile(`${dir}/panoptic.manifest.json`))
    assertEquals(onDisk.status, 'skipped')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a missing worker script is skipped with a remediation', async () => {
  const dir = await Deno.makeTempDir()
  try {
    const m = await runPanopticScan({ sessionDir: dir, python: '/bin/sh', panopticDir: `${dir}/nope` })
    assertEquals(m.status, 'skipped')
    assertStringIncludes(m.skippedReason ?? '', 'panoptic_worker.py')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a session with no keyframes is skipped, and says how to fix it', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    const m = await runPanopticScan({ sessionDir: dir, python: '/bin/sh', panopticDir: dir })
    assertEquals(m.status, 'skipped')
    assertStringIncludes(m.remediation ?? '', 'Stream keyframes')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a worker crash is an error carrying the stderr tail', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'x')
    const m = await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      _spawn: () => Promise.resolve({ code: 1, stderr: 'Traceback\ntorch.OutOfMemoryError: CUDA out of memory' }),
    })
    assertEquals(m.status, 'error')
    // A CUDA OOM and a bad model id look identical from the exit code alone.
    assertStringIncludes(m.error ?? '', 'CUDA out of memory')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('exiting 0 while writing nothing is an error, not an empty success', async () => {
  // Reporting "ok, 0 things" there would read as "this room has no objects".
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'x')
    const m = await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      _spawn: () => Promise.resolve({ code: 0, stderr: '' }),
    })
    assertEquals(m.status, 'error')
    assertStringIncludes(m.error ?? '', 'wrote no readable')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a good run counts things and stuff separately', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'x')
    const m = await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      _spawn: async () => {
        await Deno.writeTextFile(`${dir}/panoptic.segments.json`, JSON.stringify({
          frames: [{
            file: 'kf-00000.jpg',
            segments: [seg(), seg({ label: 'lamp' }), seg({ label: 'floor', isThing: false })],
          }],
        }))
        return { code: 0, stderr: '' }
      },
    })
    assertEquals(m.status, 'ok')
    assertEquals(m.framesSegmented, 1)
    assertEquals(m.thingCount, 2)
    assertEquals(m.stuffCount, 1)
    assertEquals(m.segmentsPath, 'panoptic.segments.json')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('the frame cap is honoured and passed to the worker', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(`${dir}/kf-0000${i}.jpg`, 'x')
    }
    let seenArgs: string[] = []
    await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      maxFrames: 2,
      _spawn: (_bin, args) => {
        seenArgs = args
        return Promise.resolve({ code: 1, stderr: '' })
      },
    })
    assert(seenArgs.includes('--max-frames'))
    assertEquals(seenArgs[seenArgs.indexOf('--max-frames') + 1], '2')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('explicit options beat env, and the model default is the ADE20K panoptic one', () => {
  const p = resolveParams({ sessionDir: '/tmp/x', model: 'someone/else' })
  assertEquals(p.model, 'someone/else')
  // ADE20K because its 150 classes ARE an indoor-room ontology, which is what
  // this app's domain model is about.
  assertStringIncludes(resolveParams({ sessionDir: '/tmp/x' }).model, 'ade')
})

// ── device selection ────────────────────────────────────────────────────────

Deno.test('device defaults to auto, and env loses to an explicit option', () => {
  const prev = Deno.env.get('PANOPTIC_DEVICE')
  try {
    Deno.env.delete('PANOPTIC_DEVICE')
    assertEquals(resolveParams({ sessionDir: '/tmp/x' }).device, 'auto')
    Deno.env.set('PANOPTIC_DEVICE', 'cpu')
    assertEquals(resolveParams({ sessionDir: '/tmp/x' }).device, 'cpu')
    assertEquals(resolveParams({ sessionDir: '/tmp/x', device: 'cuda' }).device, 'cuda')
  } finally {
    if (prev === undefined) Deno.env.delete('PANOPTIC_DEVICE')
    else Deno.env.set('PANOPTIC_DEVICE', prev)
  }
})

Deno.test('the default run spawns the worker with no --device at all', async () => {
  // The guarantee this option had to keep: nothing passed must produce exactly
  // the command line that shipped before it existed. `--device auto` would not
  // — the worker's own line is `device = args.device or (...)`, so it would
  // hand torch the literal string "auto".
  const prev = Deno.env.get('PANOPTIC_DEVICE')
  const dir = await Deno.makeTempDir()
  try {
    Deno.env.delete('PANOPTIC_DEVICE')
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'x')
    let seenArgs: string[] = []
    await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      _spawn: (_bin, args) => {
        seenArgs = args
        return Promise.resolve({ code: 1, stderr: '' })
      },
    })
    assert(!seenArgs.includes('--device'), `unexpected --device in ${JSON.stringify(seenArgs)}`)
  } finally {
    if (prev === undefined) Deno.env.delete('PANOPTIC_DEVICE')
    else Deno.env.set('PANOPTIC_DEVICE', prev)
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a non-auto device reaches the worker, indexed CUDA included', async () => {
  // cuda:1 is not in COMPUTE_DEVICES but panoptic_worker.py's --device is
  // free-form and _torch_device.resolve_torch_device honours an index verbatim,
  // so rejecting it here would be the driver refusing what its worker accepts.
  for (const device of ['cpu', 'cuda', 'mps', 'cuda:1'] as const) {
    const dir = await Deno.makeTempDir()
    try {
      await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
      await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'x')
      let seenArgs: string[] = []
      const m = await runPanopticScan({
        sessionDir: dir,
        python: '/bin/sh',
        panopticDir: dir,
        device,
        _spawn: (_bin, args) => {
          seenArgs = args
          return Promise.resolve({ code: 1, stderr: '' })
        },
      })
      assertEquals(m.status, 'error', `${device} was gated instead of spawned`)
      assertEquals(seenArgs[seenArgs.indexOf('--device') + 1], device)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  }
})

Deno.test('an unrecognised device is skipped with a remediation, not handed to torch', async () => {
  // A typo'd env var reaching torch comes back as a traceback tail on an
  // `error` manifest, which reads like the model broke.
  const dir = await Deno.makeTempDir()
  try {
    const m = await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      device: 'cude' as never,
    })
    assertEquals(m.status, 'skipped')
    assertStringIncludes(m.skippedReason ?? '', 'cude')
    assertStringIncludes(m.remediation ?? '', 'PANOPTIC_DEVICE')
    // The typo has to survive into the manifest or the remediation is unusable.
    assertEquals(m.params.device, 'cude')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('parseDeviceLine reads the line panoptic_worker.py actually prints', () => {
  // Verbatim from scripts/panoptic_worker.py:
  //   print(f"device: {dev.label} — {dev.reason}", file=sys.stderr)
  // with label = f"{device} ({vendor}, {'fp16' if fp16_ok else 'fp32'})".
  assertEquals(
    parseDeviceLine('kf-00000.jpg: 3 segments\ndevice: cuda (NVIDIA CUDA, fp16) — requested explicitly\n'),
    { resolvedDevice: 'cuda', deviceVendor: 'NVIDIA CUDA' },
  )
  assertEquals(
    parseDeviceLine('device: cuda:1 (AMD ROCm, fp16) — requested explicitly'),
    { resolvedDevice: 'cuda:1', deviceVendor: 'AMD ROCm' },
  )
  // Vendor is what separates AMD from NVIDIA — both run on the device string
  // "cuda", so resolvedDevice alone cannot say whose GPU it was.
  assertEquals(
    parseDeviceLine('device: mps (Apple MPS, fp16) — no CUDA; Apple MPS available')?.deviceVendor,
    'Apple MPS',
  )
  // A worker predating the parenthetical still reports something.
  assertEquals(parseDeviceLine('device: cpu'), { resolvedDevice: 'cpu' })
  assertEquals(parseDeviceLine('Traceback (most recent call last)'), undefined)
})

Deno.test('a good run records which backend actually ran', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'x')
    const m = await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      _spawn: async () => {
        await Deno.writeTextFile(`${dir}/panoptic.segments.json`, JSON.stringify({
          frames: [{ file: 'kf-00000.jpg', segments: [seg()] }],
        }))
        return { code: 0, stderr: 'device: cuda (NVIDIA CUDA, fp16) — requested explicitly\n' }
      },
    })
    assertEquals(m.status, 'ok')
    assertEquals(m.resolvedDevice, 'cuda')
    assertEquals(m.deviceVendor, 'NVIDIA CUDA')
    // Requested and resolved are different facts: 'auto' was asked for.
    assertEquals(m.params.device, 'auto')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a failed run still records the backend — that is when it matters most', async () => {
  // A CUDA OOM writes no segments JSON, so stderr is the only thing left, and
  // "was this even on the GPU?" is the first question asked about a slow or
  // dead run: 0.7 s/frame on the 4080 versus minutes per frame on CPU.
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/panoptic_worker.py`, '')
    await Deno.writeTextFile(`${dir}/kf-00000.jpg`, 'x')
    const m = await runPanopticScan({
      sessionDir: dir,
      python: '/bin/sh',
      panopticDir: dir,
      _spawn: () =>
        Promise.resolve({
          code: 1,
          stderr: 'device: cpu (CPU, fp32) — no CUDA and no MPS available\nMemoryError',
        }),
    })
    assertEquals(m.status, 'error')
    assertEquals(m.resolvedDevice, 'cpu')
    assertEquals(m.deviceVendor, 'CPU')
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
