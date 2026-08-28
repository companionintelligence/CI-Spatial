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

import { runPanopticScan, resolveParams } from '../../../server/panoptic/panoptic_scan.ts'
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
