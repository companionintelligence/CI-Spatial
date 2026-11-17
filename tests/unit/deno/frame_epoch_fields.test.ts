/**
 * frame_epoch_fields.test.ts — what a stored scan's sidecar says about the frames it was recorded in reaches the editor
 * (WP-09b, server/frame_epoch_fields.ts).
 * Run: deno test --allow-read tests/unit/deno/frame_epoch_fields.test.ts
 *
 * The gap. `src/export/gltf.ts` writes the phone's quality summary into the upload sidecar with `frameShifts` in it (how
 * many times the runtime's frame was interrupted or reported moved while the scan was recorded), and `frameEpochs`, whose
 * `mixedEpochs` says whether the point cloud holds points from more than one stretch of tracking. `qualitySummaryFromMeta`
 * (server/main.ts) rebuilt the summary field by field and dropped both, so the scan list could not say that a scan's
 * tracking was interrupted. It now adds what `frameEpochFieldsFromMeta` returns.
 *
 * What the tests hold fixed:
 *   1. It reads what a sidecar written by the current build holds, as text and not built by a helper that might move with
 *      the code, and what a sidecar written before frame epochs existed does NOT hold: no key, never 0 or false. A scan
 *      nobody counted is not a scan with no interruptions.
 *   2. A value of the wrong kind is left out, whatever else the sidecar says: it is untyped JSON that may be hand-edited.
 *   3. `server/main.ts` cannot be imported, so it is read as source: it fails if main.ts stops calling the reader, in
 *      either of the two places it builds a summary.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { fromFileUrl } from 'jsr:@std/path@^1.0.0'
import { frameEpochFieldsFromMeta } from '../../../server/frame_epoch_fields.ts'
import { REPO_ROOT } from '../../../server/repo-root.ts'

/** The relevant part of an upload sidecar as `uploadToServer` in src/export/gltf.ts writes it now. */
const SIDECAR_NOW = `{
  "pointCount": 1303,
  "qualityStatus": "needs-review",
  "qualitySummary": {
    "coverageScore": 0.74,
    "coverageText": "Good - review gaps",
    "pointCount": 1303,
    "detectionCount": 4,
    "poseCount": 212,
    "keyframeCount": 0,
    "lowLightFrames": 0,
    "driftEvents": 0,
    "fastMotionEvents": 0,
    "frameShifts": 2,
    "limitedMs": 3400,
    "reflectiveWarnings": 0,
    "missingAreas": 1,
    "trackingLost": false,
    "status": "needs-review",
    "recommendations": ["Tracking was interrupted: parts may be shifted"],
    "capturedAt": "2026-11-17T09:30:00.000Z"
  },
  "frameEpochs": {
    "version": 1,
    "baseEpoch": 0,
    "calibrationEpoch": 0,
    "currentEpoch": 2,
    "mixedEpochs": true,
    "epochCount": 3,
    "jumpCount": 2
  }
}`

/** The same part as the build before frame epochs wrote it: a summary with no `frameShifts` and no `frameEpochs` at all. */
const SIDECAR_BEFORE = `{
  "pointCount": 1303,
  "qualityStatus": "ready",
  "qualitySummary": {
    "coverageScore": 0.9,
    "coverageText": "Excellent",
    "pointCount": 1303,
    "detectionCount": 4,
    "poseCount": 212,
    "keyframeCount": 0,
    "lowLightFrames": 0,
    "driftEvents": 1,
    "reflectiveWarnings": 0,
    "missingAreas": 0,
    "trackingLost": false,
    "status": "ready",
    "recommendations": [],
    "capturedAt": "2026-08-30T09:30:00.000Z"
  }
}`

const meta = (text: string): Record<string, unknown> => JSON.parse(text)

Deno.test('a sidecar from the current build gives the interruption count and whether the cloud spans more than one stretch', () => {
  assertEquals(frameEpochFieldsFromMeta(meta(SIDECAR_NOW)), { frameShifts: 2, mixedEpochs: true })
})

Deno.test('a sidecar from before frame epochs gives nothing: no key, so the editor says nothing and not "no interruptions"', () => {
  const fields = frameEpochFieldsFromMeta(meta(SIDECAR_BEFORE))
  assertEquals(fields, {})
  assert(!('frameShifts' in fields) && !('mixedEpochs' in fields), 'never 0 and never false for a scan nobody counted')
  assertEquals(frameEpochFieldsFromMeta({}), {})
})

Deno.test('a scan that was counted and had no interruption says 0 and false, because that was measured', () => {
  const quiet = { qualitySummary: { frameShifts: 0 }, frameEpochs: { mixedEpochs: false } }
  assertEquals(frameEpochFieldsFromMeta(quiet), { frameShifts: 0, mixedEpochs: false })
})

Deno.test('the count comes from the phone\'s summary and the mixed flag from frameEpochs, each independently of the other', () => {
  assertEquals(frameEpochFieldsFromMeta({ qualitySummary: { frameShifts: 3 } }), { frameShifts: 3 })
  assertEquals(frameEpochFieldsFromMeta({ frameEpochs: { mixedEpochs: true } }), { mixedEpochs: true })
  // frameEpochs has its own jump count, which is a different number (since the scan began, not since the calibration), and is not borrowed.
  assertEquals(frameEpochFieldsFromMeta({ frameEpochs: { jumpCount: 5, mixedEpochs: true } }), { mixedEpochs: true })
})

Deno.test('a value of the wrong kind is left out, and a fraction is floored to the whole count', () => {
  for (const frameShifts of [-1, Number.NaN, Infinity, '2', null, true, [], {}]) {
    assertEquals(frameEpochFieldsFromMeta({ qualitySummary: { frameShifts } }), {}, String(frameShifts))
  }
  for (const mixedEpochs of [1, 0, 'true', null, [], {}]) {
    assertEquals(frameEpochFieldsFromMeta({ frameEpochs: { mixedEpochs } }), {}, String(mixedEpochs))
  }
  assertEquals(frameEpochFieldsFromMeta({ qualitySummary: { frameShifts: 2.9 } }), { frameShifts: 2 })
})

Deno.test('a sidecar whose summary or epoch record is not an object says nothing and does not throw', () => {
  for (const bad of [null, 'text', 7, [], [{ frameShifts: 2 }]]) {
    assertEquals(frameEpochFieldsFromMeta({ qualitySummary: bad, frameEpochs: bad }), {})
  }
})

Deno.test('the fields survive the JSON the server sends, and fit the type the editor reads them as', () => {
  const sent = JSON.parse(JSON.stringify(frameEpochFieldsFromMeta(meta(SIDECAR_NOW))))
  const received: { frameShifts?: number; mixedEpochs?: boolean } = sent
  assertEquals(received, { frameShifts: 2, mixedEpochs: true })
})

Deno.test('server/main.ts builds both its quality summaries with the frame-epoch fields', async () => {
  const source = await Deno.readTextFile(fromFileUrl(new URL('server/main.ts', REPO_ROOT)))
  assert(/import \{ frameEpochFieldsFromMeta \} from '\.\/frame_epoch_fields\.ts'/.test(source), 'main.ts imports the reader')
  const start = source.indexOf('function qualitySummaryFromMeta(')
  const end = source.indexOf('\nfunction coverageLabel(', start)
  assert(start > 0 && end > start, 'main.ts has the function this test reads')
  assertEquals(source.slice(start, end).split('...frameEpochFieldsFromMeta(meta)').length, 3, 'the summary the phone wrote, and the one rebuilt from the flat keys')
})
