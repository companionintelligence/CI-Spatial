/**
 * COLMAP_E2E: the joint solve and the Sim(3) chain against the real COLMAP binary, on a rendered room.
 *
 * Runs ONLY with COLMAP_E2E=1, and only when a `colmap` binary is found (COLMAP_BIN, then PATH, then the sudo-less
 * install in docs/operations/COLMAP_SETUP.md). With the flag set and no binary it says so and skips; it never fails for
 * a missing tool, and it installs nothing. Stubbed spawns cannot catch a changed command-line option or a camera that
 * COLMAP does not give a session, which is what this exists for (the same reasoning as BRUSH_E2E in
 * splat_train.test.ts).
 *
 * The data is synthetic and made here: three sessions of a rendered room (tests/unit/deno/toy_sfm_scene.ts), each with
 * its own lens, its own image size, its own AR frame, one of them with its own unit. No real user data is ever given to
 * COLMAP by any test. SIFT only, CPU only, as in production. About half a minute a test on a 32-thread box; the room is easy
 * (no blur, no lighting change, no moved furniture), so what passing shows is that the plumbing and the algebra are
 * right, not that a real room will register.
 *
 *   COLMAP_E2E=1 deno test --allow-read --allow-write --allow-env --allow-run --allow-ffi \
 *     --filter COLMAP_E2E tests/unit/deno/colmap_toy_sfm.test.ts
 *
 * What it checks, in the order a registration depends on it:
 *   1. every frame of every session registers in ONE model, each session on a camera of its own, and each fitted
 *      lens is close to the lens the frames were rendered with (the prior was right but the fit is COLMAP's);
 *   2. matching was done through a pair list from the AR poses, which is fewer pairs than matching everything;
 *   3. each new session's frame is recovered in the Place frame: its own camera centres land on the true Place-frame
 *      centres, its unit mismatch with the reference comes back as the scale ratio, and the correction against the
 *      calibration the app would have stored matches the correction the truth implies;
 *   4. the negative control: a session whose pictures are mirrored (its AR poses are right and its images cannot match
 *      the others') is not registered by the chain, although COLMAP's relaxed thresholds put a few of its frames in the
 *      model.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'

import { runColmapJointPoses } from '../../../server/colmap/colmap_joint.ts'
import { locateColmapBin } from '../../../server/colmap/colmap_poses.ts'
import { exhaustivePairCount } from '../../../server/register/pair_list.ts'
import { chooseSessionEpoch, sessionCentres } from '../../../server/register/session_priors.ts'
import {
  applySim3,
  describeCorrection,
  fitSessionToSolver,
  registerSessionsToReference,
  type Sim3,
  sim3ToColumnMajor,
} from '../../../server/register/sim3_chain.ts'
import { type Vec3Tuple, sfmCentresFromPoses } from '../../../server/splat/splat_align.ts'
import { readKeyframes, readSolvedPoses } from '../../../server/splat/splat_train_dataset.ts'
import { ringViews, rotY, sessionTruth, type ToySessionSpec, writeToySession } from './toy_sfm_scene.ts'

const wanted = Deno.env.get('COLMAP_E2E') === '1'
const located = wanted
  ? await locateColmapBin(Deno.env.get('COLMAP_BIN') ?? 'colmap')
  : { bin: null, pathProbe: 'not-tried' as const }
if (wanted && !located.bin) {
  console.warn('[colmap-e2e] COLMAP_E2E=1 but no colmap binary was found (COLMAP_BIN, PATH, ~/.local/micromamba/envs/colmap/bin); the toy SfM test is skipped.')
}

/** The room's middle, which the rings are walked round. */
const MIDDLE: Vec3Tuple = [2.5, 0, 2.0]
const VIEWS = 14

/** The three sessions: three lenses, two image sizes, three AR frames, and one runtime whose unit is 12% bigger. */
const SPECS: ToySessionSpec[] = [
  {
    sessionId: 'sess-toy-ref', width: 640, height: 480, focalPx: 520, unit: 1, yawDeg: 0, origin: [0, 0, 0],
    views: ringViews(MIDDLE, [1.3, 1.0], VIEWS, 0, 1.45, 11), positionNoise: 0.01, seed: 101,
  },
  {
    sessionId: 'sess-toy-a', width: 800, height: 600, focalPx: 640, unit: 1, yawDeg: 25, origin: [1.2, 0, -0.7],
    views: ringViews(MIDDLE, [1.0, 1.2], VIEWS, 10, 1.35, 12), positionNoise: 0.01, seed: 102,
  },
  {
    sessionId: 'sess-toy-b', width: 640, height: 480, focalPx: 450, unit: 1.12, yawDeg: -40, origin: [-0.5, 0, 0.9],
    views: ringViews(MIDDLE, [1.4, 0.9], VIEWS, 5, 1.55, 13), positionNoise: 0.01, seed: 103,
  },
]

/**
 * What the app would hold for each session: `sessionToProject`, rigid, built from two taps. The reference's is
 * exact, because it defines the Place frame here. The others are a few decimetres and a few degrees off, which is the
 * size of error this registration exists to find. A rigid matrix has no unit in it, so the unit mismatch of the last
 * session is in none of them.
 */
const CALIBRATION_ERROR: Record<string, { yawDeg: number; shift: Vec3Tuple }> = {
  'sess-toy-ref': { yawDeg: 0, shift: [0, 0, 0] },
  'sess-toy-a': { yawDeg: 4, shift: [0.35, 0, -0.25] },
  'sess-toy-b': { yawDeg: -3, shift: [0.2, 0, 0.3] },
  'sess-toy-m': { yawDeg: -3, shift: [0.2, 0, 0.3] },
}

function storedCalibration(spec: ToySessionSpec): Sim3 {
  const truth = sessionTruth(spec)
  const error = CALIBRATION_ERROR[spec.sessionId]!
  return {
    rotation: rotY(spec.yawDeg + error.yawDeg),
    translation: [truth.translation[0] + error.shift[0], truth.translation[1] + error.shift[1], truth.translation[2] + error.shift[2]],
    scale: 1,
  }
}

Deno.test({
  name: 'COLMAP_E2E: three rendered sessions solve into one model with a camera each, and the Sim(3) chain recovers their frames',
  ignore: !wanted || !located.bin,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'colmap-toy-' })
    try {
      const sessionDirs: Record<string, string> = {}
      for (const spec of SPECS) sessionDirs[spec.sessionId] = (await writeToySession(`${dir}/sessions`, spec)).sessionDir

      const outDir = `${dir}/joint`
      const result = await runColmapJointPoses({
        outDir,
        sessions: SPECS.map((spec) => ({
          sessionDir: sessionDirs[spec.sessionId]!,
          placement: { sessionToProject: sim3ToColumnMajor(storedCalibration(spec)), epoch: 0 },
        })),
        colmapBin: located.bin!,
      })
      assertEquals(result.status, 'ok', result.manifest.error ?? result.manifest.skippedReason)

      // 1. One model, one camera per session, lenses near the truth.
      assertEquals(result.registeredImages, SPECS.length * VIEWS)
      assertEquals(result.manifest.models?.length, 1, 'no session was left as a model of its own')
      const cameraIds = new Set<number>()
      for (const spec of SPECS) {
        const report = result.sessions.find((s) => s.sessionId === spec.sessionId)!
        assertEquals([report.offered, report.registered, report.inOtherModels, report.unregistered], [VIEWS, VIEWS, 0, 0], spec.sessionId)
        assertEquals(report.cameraIds.length, 1, `${spec.sessionId} has exactly one camera`)
        cameraIds.add(report.cameraIds[0]!)
        // The prior was the field of view the keyframes reported, which is the true one up to rounding.
        assert(Math.abs(report.prior.params![0] - spec.focalPx) < 1e-6, `${spec.sessionId} prior ${report.prior.params![0]}`)
        assertEquals([report.solvedCamera!.width, report.solvedCamera!.height], [spec.width, spec.height])
        // The fit is COLMAP's own. Two runs of this scene measured 0.03% at worst, so 1% is slack for this room and
        // says nothing about the tolerance to expect on a real lens.
        const error = Math.abs(report.solvedCamera!.fx / spec.focalPx - 1)
        assert(error < 0.01, `${spec.sessionId}: fitted focal ${report.solvedCamera!.fx} against ${spec.focalPx}`)
      }
      assertEquals(cameraIds.size, SPECS.length, 'three sessions, three distinct cameras')

      // 2. Matched through a pair list, not every pair.
      const matching = result.manifest.matching!
      assertEquals(matching.kind, 'pairs')
      assert(matching.pairCount < exhaustivePairCount(SPECS.length * VIEWS), `${matching.pairCount} pairs`)
      assert((result.manifest.pairStats?.crossSessionPairs ?? 0) > 0, 'the sessions were tied by cross-session pairs')

      // 3. The chain.
      const solved = await readSolvedPoses(outDir)
      assert(solved)
      const solverCentres = sfmCentresFromPoses(solved)
      const fits = []
      for (const spec of SPECS) {
        const records = await readKeyframes(sessionDirs[spec.sessionId]!)
        const choice = chooseSessionEpoch(records, 0)
        const centres = sessionCentres(records, spec.sessionId, choice.epoch)
        assertEquals(centres.size, VIEWS)
        fits.push({ spec, centres, fit: fitSessionToSolver({ sessionId: spec.sessionId, sessionCentres: centres, solverCentres }) })
      }
      for (const { spec, fit } of fits) assert(fit.ok, `${spec.sessionId}: ${fit.ok ? '' : fit.message}`)

      const [reference, ...others] = fits
      const registrations = registerSessionsToReference(
        { sessionId: reference!.spec.sessionId, sessionToProject: sim3ToColumnMajor(storedCalibration(reference!.spec)), fit: reference!.fit },
        others.map((o) => ({ sessionId: o.spec.sessionId, fit: o.fit })),
      )

      for (let i = 0; i < others.length; i++) {
        const { spec, centres } = others[i]!
        const registration = registrations[i]!
        assert(registration.ok, registration.ok ? '' : registration.message)
        const truth = sessionTruth(spec)
        const truthSim: Sim3 = { rotation: truth.rotation, translation: truth.translation, scale: truth.unit }

        // The session's own recorded camera centres, carried by the recovered transform, against where they really were.
        let sum = 0
        let n = 0
        spec.views.forEach((view, k) => {
          const recorded = centres.get(`${spec.sessionId}/kf-${String(k).padStart(5, '0')}.jpg`)!
          const here = applySim3(registration.sessionToPlace, recorded)
          sum += (here[0] - view.position[0]) ** 2 + (here[1] - view.position[1]) ** 2 + (here[2] - view.position[2]) ** 2
          n++
        })
        const rms = Math.sqrt(sum / n)
        // Two runs of this scene measured 1.5 cm and 2.0 cm (with 1 cm of noise on the recorded positions). Three times that.
        assert(rms < 0.06, `${spec.sessionId}: recovered centres are ${rms} m from the truth`)

        // The unit mismatch: Place metres per unit of the session. Measured 0.3% off for both (1.0028 for 1, 1.117 for 1.12).
        assert(Math.abs(registration.scaleRatioToReference / truth.unit - 1) < 0.015, `${spec.sessionId}: scale ratio ${registration.scaleRatioToReference} for a true ${truth.unit}`)
        assert(registration.residualPlaceM < 0.05, `${spec.sessionId}: residual ${registration.residualPlaceM}`)
        // The two sessions' up axes through the solve: measured 0.33 and 0.43 degrees, against a limit of 5 at which the chain refuses.
        assert(registration.tiltDeg < 1.5, `${spec.sessionId}: up axes ${registration.tiltDeg} degrees apart`)

        // What it would change: the same correction the true frame implies, against the stored calibration.
        const stored = sim3ToColumnMajor(storedCalibration(spec))
        const arCentres = [...centres.values()]
        const measured = describeCorrection(registration.sessionToPlace, stored, arCentres)!
        const expected = describeCorrection(truthSim, stored, arCentres)!
        // Measured: yaw within 0.25 degrees of the truth's, the shift within 3 mm, the tilt (which should be nil) 0.3 to 0.4 degrees.
        assert(Math.abs(measured.bounded.yawDeg - expected.bounded.yawDeg) < 1, `${spec.sessionId}: yaw ${measured.bounded.yawDeg} against ${expected.bounded.yawDeg}`)
        assert(Math.abs(measured.bounded.translationM - expected.bounded.translationM) < 0.05, `${spec.sessionId}: shift ${measured.bounded.translationM} against ${expected.bounded.translationM}`)
        assert(measured.tiltDeg < 1, `${spec.sessionId}: up axis tipped by ${measured.tiltDeg} degrees`)
        // And the correction found is the calibration error that was injected, which is what the exercise is for.
        assert(Math.abs(Math.abs(measured.bounded.yawDeg) - Math.abs(CALIBRATION_ERROR[spec.sessionId]!.yawDeg)) < 1)
      }
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  name: 'COLMAP_E2E: a session COLMAP cannot tie to the others is not registered, whatever few of its frames land in the model',
  ignore: !wanted || !located.bin,
  fn: async () => {
    // The third session's pictures are the other room-views flipped left to right: its AR poses are right and its images
    // cannot match anything. Measured twice in the review and once here: COLMAP's relaxed mapper thresholds put 3 of its 14
    // frames into the model that holds the other two sessions, with poses that are nowhere near where the cameras were
    // (2.2 to 2.6 m), and the report says registered 3, unregistered 11. A report of "registered" is not "joined":
    // the fit to the session's own recorded poses is what has to refuse it, and this test is the check that it does.
    const dir = await Deno.makeTempDir({ prefix: 'colmap-toy-neg-' })
    try {
      const [ref, a, base] = SPECS
      const mirrored: ToySessionSpec = { ...base!, sessionId: 'sess-toy-m' }
      const specs = [ref!, a!, mirrored]
      const sessionDirs: Record<string, string> = {}
      for (const spec of specs) {
        sessionDirs[spec.sessionId] = (await writeToySession(`${dir}/sessions`, spec, { mirrorImages: spec === mirrored })).sessionDir
      }
      const result = await runColmapJointPoses({
        outDir: `${dir}/joint`,
        sessions: specs.map((spec) => ({
          sessionDir: sessionDirs[spec.sessionId]!,
          placement: { sessionToProject: sim3ToColumnMajor(storedCalibration(spec)), epoch: 0 },
        })),
        colmapBin: located.bin!,
      })
      assertEquals(result.status, 'ok', result.manifest.error ?? result.manifest.skippedReason)

      const report = result.sessions.find((s) => s.sessionId === 'sess-toy-m')!
      assertEquals(report.registered + report.inOtherModels + report.unregistered, VIEWS, 'every frame is somewhere')
      assert(report.registered < VIEWS, `${report.registered} of ${VIEWS} mirrored frames registered: they cannot match`)

      const solved = await readSolvedPoses(`${dir}/joint`)
      assert(solved)
      const solverCentres = sfmCentresFromPoses(solved)
      const fits = []
      for (const spec of specs) {
        const records = await readKeyframes(sessionDirs[spec.sessionId]!)
        const centres = sessionCentres(records, spec.sessionId, chooseSessionEpoch(records, 0).epoch)
        fits.push({ spec, fit: fitSessionToSolver({ sessionId: spec.sessionId, sessionCentres: centres, solverCentres }) })
      }
      const [reference, joined, stranger] = fits
      assert(reference!.fit.ok, 'the reference fits')
      assert(joined!.fit.ok, 'so does the session that matched')
      const registrations = registerSessionsToReference(
        { sessionId: reference!.spec.sessionId, sessionToProject: sim3ToColumnMajor(storedCalibration(reference!.spec)), fit: reference!.fit },
        [joined!, stranger!].map((s) => ({ sessionId: s.spec.sessionId, fit: s.fit })),
      )
      assert(registrations[0]!.ok, 'the session that matched is registered')
      assert(!registrations[1]!.ok, `the session of mirrored pictures was registered: ${registrations[1]!.ok ? 'sessionToPlace given' : ''}`)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})
