/**
 * The calibration modal on a return visit, and the reference photos it takes (WP-07), driven end to end through
 * `runProjectCalibration` against a camera that is a perfect pinhole (./support/return-visit-driver.ts).
 *
 * What this holds, and what holds it:
 *
 *  - The copy, the distance chip, the ring on the floor, the two photos side by side and the "Wrong Place?" exit are
 *    each held to what a person would see: the strings of src/ar/return-visit-copy.ts are pinned in
 *    wp-return-visit-copy.test.ts, and here they are shown at the stage they belong to and gone from the ones they do
 *    not. A first visit gets none of it, and `?returnaids=off` gets none of it on a return visit.
 *  - The crosshair of a photo is where its marker is in that photo. The driver's camera is a pinhole, so the expected
 *    place is three.js's `Vector3.project()` of the marker from the pose the host took the frame at: not the tap, which
 *    is only right while the phone has not moved.
 *  - Each marker is photographed at its own tap (WP-04b), one frame at a time, so a visit that writes the Place's frame
 *    has its photos before Commit is pressed. What is left for Commit is a frame that is still on its way, one that was
 *    refused, or one that arrived after the phone had turned away: the tests that hold, wait or end the commit make the camera
 *    slow (`'hold'`) or busy (`'reject'`) when the heading marker is tapped, and not afterwards.
 *  - A first calibration is offered a check point once the heading marker is placed, and Commit is not on the card until that
 *    step is answered: the tests of a first visit leave the step by its own button, as a person who wants the pair does.
 *  - A landmark moved after Confirm is photographed again, so the frame is saved with both photos. That is the failure
 *    the owner's symptom names ("No photo was saved"): the old modal handed the commit one photo, and the frame was
 *    saved with none. `every new frame is saved with all its photos` runs it over a hundred random walks, and sends
 *    each frame through the real client code that saves it (src/project/frame-sync.ts) to count what the Place keeps.
 *  - A photo that cannot show its marker is said, once, before the frame is saved without it, naming the button that was
 *    pressed; and a person who presses again is not stopped.
 *  - A flow that has ended does nothing more: a commit that was waiting for its photos, or a tap waiting for its hit test,
 *    finishes into nothing when the person pressed Re-place points or Continue uncalibrated meanwhile.
 *  - A stored record this build did not write, or an older one did, opens the card all the same.
 *  - The floor grid stays after a commit and goes with a skip.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-return-visit-aids.test.ts
 * Also run by npm run test:wave, which matches tests/unit/node/wp-*.test.ts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import type { CalibrationResult } from '../../../src/ar/project-calibration.ts'
import type { PendingReferencePhoto } from '../../../src/ar/reference-photo.ts'
import type { CalibrationReferencePhoto, Project, ProjectSpatialFrame, Vec3 } from '../../../src/world/types.ts'
import { sendFrameLikeThePhone } from './support/real-writers.ts'
import {
  ASPECT,
  BUTTONS as BUTTON_IDS,
  FLOOR_Y,
  START_POSE,
  VIEW,
  openVisit,
  poseFrom,
  seenFrom,
  storedPair,
  type CameraPose,
  type Visit,
} from './support/return-visit-driver.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

function near(actual: number, expected: number, tolerance = 1e-9, what = ''): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} is not ${expected} (within ${tolerance})`)
}

/** Runs a test body against a visit and always leaves the process as it found it. */
function withVisit(name: string, setup: Parameters<typeof openVisit>[0], body: (visit: Visit) => Promise<void>): void {
  test(name, async () => {
    const visit = await openVisit(setup)
    try {
      await body(visit)
    } finally {
      await visit.dispose()
    }
  })
}

/**
 * A pair `apart` metres apart on the floor: A tapped at a pixel from where the phone starts, Confirm pressed, the phone
 * carried `apart` metres ahead with its orientation unchanged, and B tapped at the same pixel, which lands exactly
 * `apart` from A. The card is in review: on a first visit the check-point step B opens is left by its button, which skips it.
 *
 * `whileB`: the camera is that from before B is tapped, and stays so until the test sets `visit.capture.mode` again. A first visit
 * asks for B's frame at its tap (a visit to a stored pair does not), so `'hold'` is a camera that is slow to answer it, and its
 * frame waits for `visit.capture.release()`; `'reject'` is one that is busy, and B has no photo.
 */
async function placePair(
  visit: Visit,
  apart: number,
  pixel: { u: number; v: number } = { u: 0.5, v: 0.6 },
  whileB?: 'hold' | 'reject',
): Promise<{ a: Vec3; b: Vec3 }> {
  const a = await visit.tap(pixel.u, pixel.v)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: START_POSE.position.x, y: START_POSE.position.y, z: START_POSE.position.z - apart }, -35, 0)
  if (whileB) visit.capture.mode = whileB
  const b = await visit.tap(pixel.u, pixel.v)
  await visit.skipCheckPoint()
  return { a, b }
}

// A first visit is offered a check point after the heading marker (WP-04b), so it asks for three taps and counts to three.
const FIRST_VISIT_LANDMARK = "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin."
const FIRST_VISIT_HEADING = 'Step 2 of 3 — walk 3 m or more from the landmark, then tap a second ground feature. Longer is more accurate; their direction sets the heading.'
// A visit to a pair with no check point asks for two, and `?returnaids=off` leaves the copy the modal itself says.
const PAIR_VISIT_LANDMARK = "Step 1 of 2 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin."
const OLD_RETURN_HEADING = 'Step 2 of 2 — tap the heading marker from last time, about 3.2 m from the landmark. Their direction sets the heading.'

// ── The copy ─────────────────────────────────────────────────────────────────────────────────────

withVisit('a first visit gets the first-visit copy and none of the return-visit aids', {}, async (visit) => {
  assert.equal(visit.copy(), FIRST_VISIT_LANDMARK)
  const a = await visit.tap(0.5, 0.6)
  assert.ok(a)
  await visit.press('confirm')
  assert.equal(visit.copy(), FIRST_VISIT_HEADING)
  assert.deepEqual(visit.rings(), [], 'no stored pair, no ring')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.part('project-calibration-chip').hidden, true, 'no stored distance, no chip')
  assert.equal(visit.part('project-calibration-compare').hidden, true, 'no stored photos to put side by side')
  assert.deepEqual(visit.rings(), [])
})

withVisit('a return visit asks for Point A again, "last time" while its photo is not on screen', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  assert.equal(visit.copy(), "Step 1 of 2 — tap Point A again, the same spot as last time. Point A is the project's origin.")
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  // The ring is drawn the moment Point A is confirmed, so the step points at it.
  assert.equal(visit.rings().length, 1)
  // The allowance is the commit's own, 16.8 cm, which is 0.17 m: the record says 15 cm (`storedPair`), and the commit does not read it.
  assert.equal(visit.copy(), 'Step 2 of 2 — tap Point B again, the same spot as last time. Point B was 3.20 m from A (allowed ±0.17 m). The ring on the floor marks that distance.')
})

withVisit('...and "the photo" once the stored photo is on screen, for each point in its own step', { stored: storedPair({ photos: true, labels: ['north door frame', 'radiator corner'] }) }, async (visit) => {
  await visit.advance(200)
  assert.equal(visit.part('project-calibration-reference-figure').hidden, false, 'the stored photo of Point A is showing')
  assert.equal(visit.copy(), "Step 1 of 2 — tap Point A again, the same spot as the photo. Point A is the project's origin.")
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  // The reference panel is for Point B now and its photo is loading: until it is on screen the step does not claim it.
  await visit.advance(200)
  assert.equal(visit.part('project-calibration-reference-figure').hidden, false)
  assert.equal(visit.copy(), 'Step 2 of 2 — tap Point B again, the same spot as the photo. Point B was 3.20 m from A (allowed ±0.17 m). The ring on the floor marks that distance.')
})

withVisit('a stored photo that cannot be loaded is not claimed: the step says "last time" and the panel says what happened', { stored: storedPair({ photos: true }), loadReferencePhoto: async () => null }, async (visit) => {
  await visit.advance(200)
  assert.equal(visit.part('project-calibration-reference-figure').hidden, true)
  assert.match(visit.copy(), /the same spot as last time/)
  assert.match(visit.part('project-calibration-reference-note').textContent, /could not be loaded/)
})

withVisit('?returnaids=off restores the copy a return visit had before, and draws none of the aids', { stored: storedPair({ photos: true }), search: '?returnaids=off' }, async (visit) => {
  await visit.advance(200)
  assert.equal(visit.copy(), PAIR_VISIT_LANDMARK, 'the arm without the aids is the modal as it was')
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  assert.equal(visit.copy(), OLD_RETURN_HEADING)
  assert.deepEqual(visit.rings(), [], 'no ring')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.part('project-calibration-chip').hidden, true, 'no chip')
  assert.equal(visit.part('project-calibration-compare').hidden, true, 'no side-by-side photos')
  assert.match(visit.part('project-calibration-separation').textContent, /Stored pair: 3\.20 m/, 'the separation line is not an aid, and is as it was')
})

// ── The chip ─────────────────────────────────────────────────────────────────────────────────────

withVisit('the chip is live: it passes inside the tolerance and fails outside it, as the pair is moved', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  const chip = visit.part('project-calibration-chip')
  assert.equal(chip.hidden, true, 'nothing to compare before the second marker')
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  assert.equal(chip.hidden, true)

  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.25 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(chip.hidden, false)
  assert.equal(chip.dataset['state'], 'pass')
  assert.equal(chip.textContent, '✓ About as far apart as stored: 5\u00A0cm off. Direction is not checked.')

  // Select B where it is, then tap it 40 cm too far.
  await visit.tap(0.5, 0.6)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.6 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(chip.dataset['state'], 'fail')
  assert.equal(chip.textContent, '⚠ 40\u00A0cm further apart than stored. Allowed: ±17\u00A0cm.')

  await visit.tap(0.5, 0.6)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -2.9 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(chip.textContent, '⚠ 30\u00A0cm closer together than stored. Allowed: ±17\u00A0cm.')
  assert.equal(chip.dataset['state'], 'fail')
})

withVisit('the chip is the commit\'s verdict early: where it says fail, Commit goes to the mismatch screen, and where it says pass, it commits', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  await placePair(visit, 3.6)
  assert.equal(visit.part('project-calibration-chip').dataset['state'], 'fail')
  await visit.press('commit')
  assert.equal(visit.closed(), false)
  assert.equal(visit.part('project-calibration-title').textContent, 'These markers do not match the stored pair')
  assert.equal(visit.part('project-calibration-chip').hidden, true, 'the mismatch screen says it in words: the chip is for placing the pair')
})

withVisit('a pair that matches commits provisional by distance, and the chip said pass: only a fit of three points can be verified', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  await placePair(visit, 3.2)
  assert.equal(visit.part('project-calibration-chip').dataset['state'], 'pass')
  await visit.press('commit')
  const result = await visit.result()
  assert.equal(result?.calibration.status, 'provisional')
  assert.equal((result?.calibration as { checkedBy?: string }).checkedBy, 'separation')
})

// The chip's allowance is the commit's. The stored record says 15 cm (`storedPair`), the commit applies 16.8 cm at the adopted tap
// noise, and the chip is what the commit would say: a pair 16 cm off is a pass in both, and one 18 cm off a fail in both.
withVisit('the chip judges by the tolerance the commit applies, not the one the record carries: 16 cm off passes in both, 18 cm fails in both', { stored: storedPair({ separationM: 3.2, toleranceM: 0.15 }) }, async (visit) => {
  const chip = visit.part('project-calibration-chip')
  await placePair(visit, 3.2 + 0.18)
  assert.equal(chip.dataset['state'], 'fail')
  assert.equal(chip.textContent, '⚠ 18\u00A0cm further apart than stored. Allowed: ±17\u00A0cm.')
  await visit.press('commit')
  assert.equal(visit.closed(), false)
  assert.equal(visit.part('project-calibration-title').textContent, 'These markers do not match the stored pair')

  // Back to the markers ("Adjust a point"), select B where it is and bring it to 16 cm over: past the record's 15 cm, inside the commit's 16.8.
  visit.part('project-calibration-adjust').click()
  await visit.settle()
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 - 0.18 }, -35, 0)
  await visit.tap(0.5, 0.6)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 - 0.16 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(chip.dataset['state'], 'pass')
  assert.equal(chip.textContent, '✓ About as far apart as stored: 16\u00A0cm off. Direction is not checked.')
  await visit.press('commit')
  const result = await visit.result()
  assert.equal(result?.calibration.status, 'provisional')
  near(result!.calibration.method === 'two-point-ground' ? result!.calibration.residualM : Number.NaN, 0.16, 1e-6, 'the pair the commit accepted')
})

// ── A visit that re-taps a stored check point is judged by a fit, and has no distance chip ──────────

/** A Place that stores a check point 2 m off the line and 1.6 m along it. The project's +x is the session's -x here: 2 m to the right of A to B. */
const storedWithCheck = (options: Parameters<typeof storedPair>[0] = {}) => storedPair({ separationM: 3.2, checkPoints: [{ x: -2, y: 0, z: 1.6 }], ...options })

/**
 * A visit to a Place that stores a check point, re-tapping all three: A from where the phone starts, B `apart` metres on, and C where the
 * phone stands `offset` from where A was tapped (the same pixel from there lands that far from A). The card is in review.
 */
async function retapThree(visit: Visit, apart: number, offset: { x: number; z: number }): Promise<void> {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -apart }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.part('project-calibration-title').textContent, 'Tap the check point from last time')
  visit.camera.pose = poseFrom({ x: offset.x, y: 1.5, z: offset.z }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.part('project-calibration-title').textContent, 'Check the alignment')
}

// With three points the commit compares positions by a fit and not the distance between two, so a chip about the distance could say the
// opposite of the commit: fail where the fit accepts (a pair a little long, a check point that sits right), or pass where it does not.
withVisit('a pair 20 cm too long with a check point that sits right is judged by the fit, which accepts it: no distance chip says fail, and the card says it is ready', { stored: storedWithCheck() }, async (visit) => {
  await retapThree(visit, 3.4, { x: 2, z: -1.7 })
  assert.equal(visit.part('project-calibration-chip').hidden, true, 'the commit is not judging the distance')
  assert.equal(visit.status(), 'Ready to commit.')
  await visit.press('commit')
  const result = await visit.result()
  assert.equal(result?.calibration.status, 'verified')
  assert.equal((result?.calibration as { checkedBy?: string }).checkedBy, 'constellation')
})

withVisit('a pair at the stored distance with a check point 50 cm off is judged by the fit, which refuses it: no distance chip says pass', { stored: storedWithCheck() }, async (visit) => {
  await retapThree(visit, 3.2, { x: 2, z: -2.1 })
  assert.equal(visit.part('project-calibration-chip').hidden, true)
  assert.equal(visit.status(), 'These points do not match the stored ones yet.')
  await visit.press('commit')
  assert.equal(visit.closed(), false)
  assert.equal(visit.part('project-calibration-title').textContent, 'These points do not match the stored ones')
})

withVisit('a visit that skips the stored check point is judged by the distance again, and the chip is back with the commit\'s own verdict', { stored: storedWithCheck() }, async (visit) => {
  const chip = visit.part('project-calibration-chip')
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.4 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(chip.hidden, true, 'in the check step there is no chip')
  await visit.press('check')
  assert.equal(chip.hidden, false)
  assert.equal(chip.dataset['state'], 'fail', 'the pair alone is 20 cm too long')
  await visit.press('commit')
  assert.equal(visit.part('project-calibration-title').textContent, 'These markers do not match the stored pair')
})

// ── The ring ─────────────────────────────────────────────────────────────────────────────────────

withVisit('a ring at the stored distance is drawn round the landmark once it is confirmed, and not before', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  const a = await visit.tap(0.5, 0.6)
  assert.deepEqual(visit.rings(), [], 'placed but not confirmed: nothing to walk away from yet')
  await visit.press('confirm')
  const [ring, ...others] = visit.rings()
  assert.deepEqual(others, [])
  assert.ok(ring)
  near(ring.radius, 3.2, 1e-5, 'radius')
  assert.deepEqual(ring.centre, a, 'centred on the landmark, on the floor')
  assert.equal(ring.centre.y, FLOOR_Y)
})

withVisit('the ring follows a landmark that is moved after Confirm, and stays through review and the mismatch screen', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  const a = await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  assert.deepEqual(visit.rings()[0]!.centre, a)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.6 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.rings().length, 1, 'review: still there')

  // Select the landmark by tapping where it is, and put it somewhere else: the ring goes with it.
  visit.camera.pose = START_POSE
  await visit.tap(0.5, 0.6)
  const moved = await visit.tap(0.7, 0.66)
  assert.notDeepEqual(moved, a)
  assert.deepEqual(visit.rings()[0]!.centre, moved)
  assert.equal(visit.rings().length, 1, 'one ring, moved: not a second one')

  await visit.press('commit')
  assert.equal(visit.part('project-calibration-title').textContent, 'These markers do not match the stored pair')
  assert.equal(visit.rings().length, 1, 'the mismatch screen keeps it')
  await visit.press('replace')
  assert.deepEqual(visit.rings(), [], 're-placing both points: no landmark, no ring')
})

withVisit('every stored point has a ring at its own distance, in the order the points are stored', { stored: storedPair({ separationM: 3.2, checkPoints: [{ x: 2, y: 0, z: 1.5 }, { x: -1, y: 0, z: 5 }] }) }, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  const radii = visit.rings().map((ring) => ring.radius)
  assert.equal(radii.length, 3)
  near(radii[0]!, 3.2, 1e-5)
  near(radii[1]!, 2.5, 1e-5)
  near(radii[2]!, Math.hypot(-1, 5), 1e-5)
})

withVisit('the rings stay through the check step, where the stored check point is the one to walk to, and through review', { stored: storedWithCheck() }, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  assert.equal(visit.rings().length, 2, 'the heading marker\'s ring, and the check point\'s')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.part('project-calibration-title').textContent, 'Tap the check point from last time', 'the Place stores a check point: the step opens to re-tap it')
  const rings = visit.rings()
  assert.equal(rings.length, 2, 'the check step: the rings are still there')
  near(rings[0]!.radius, 3.2, 1e-5)
  near(rings[1]!.radius, Math.hypot(2, 1.6), 1e-5, 'the check point\'s own distance from A')
  await visit.press('check')
  assert.equal(visit.rings().length, 2, 'skipped: review keeps them')
})

test('the aids let go of what they hold when the flow ends: the ring\'s geometry and material, and every picture they loaded', async () => {
  let made = 0
  const loaded: string[] = []
  const revoked: string[] = []
  const realRevoke = URL.revokeObjectURL
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
  const visit = await openVisit({
    stored: storedPair({ photos: true }),
    loadReferencePhoto: async () => {
      made += 1
      loaded.push(`blob:fake/${made}`)
      return `blob:fake/${made}`
    },
  })
  try {
    await placePair(visit, 3.2)
    const ring = visit.scene.getObjectByName('calibration distance ring') as THREE.LineSegments
    assert.ok(ring)
    const disposed: string[] = []
    ring.geometry.addEventListener('dispose', () => disposed.push('geometry'))
    ;(ring.material as THREE.Material).addEventListener('dispose', () => disposed.push('material'))
    assert.ok(loaded.length >= 4, `the single-photo panel and the side-by-side one loaded: ${loaded.length}`)

    await visit.press('skip')
    assert.deepEqual(disposed.sort(), ['geometry', 'material'])
    assert.deepEqual([...revoked].sort(), [...loaded].sort(), 'every picture either panel was given is released')
  } finally {
    URL.revokeObjectURL = realRevoke
    await visit.dispose()
  }
})

withVisit('the rings go with the flow: none is left on the scene after a commit', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  await placePair(visit, 3.2)
  assert.equal(visit.rings().length, 1)
  await visit.press('commit')
  await visit.result()
  assert.deepEqual(visit.rings(), [])
})

// ── Both photos ──────────────────────────────────────────────────────────────────────────────────

withVisit('review shows both stored photos side by side, each with its crosshair on the recorded tap and its label', { stored: storedPair({ photos: true, labels: ['north door frame', 'radiator corner'] }) }, async (visit) => {
  const compare = visit.part('project-calibration-compare')
  assert.equal(compare.hidden, true, 'not while a point is being placed: the single-photo panel is for that')
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  assert.equal(compare.hidden, true)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.part('project-calibration-reference').hidden, true, 'the single-photo panel gives way')
  assert.equal(compare.hidden, false)
  for (const [slot, left, top, label] of [['a', '40px', '30px', ' “north door frame”'], ['b', '60px', '70px', ' “radiator corner”']] as const) {
    assert.equal(visit.part(`project-calibration-compare-figure-${slot}`).hidden, false, `slot ${slot} shows its photo`)
    assert.equal(visit.part(`project-calibration-compare-img-${slot}`).src, 'data:image/png;base64,AAAA')
    assert.equal(visit.part(`project-calibration-compare-cross-${slot}`).style['left'], left)
    assert.equal(visit.part(`project-calibration-compare-cross-${slot}`).style['top'], top)
    assert.equal(visit.part(`project-calibration-compare-label-${slot}`).textContent, label)
    assert.equal(visit.part(`project-calibration-compare-note-${slot}`).hidden, true)
  }
  // The single-photo panel loaded A for its step and B for its own; this panel loaded each once more.
  assert.deepEqual(visit.loads.map((photo) => photo.localKey).sort(), ['p1:headingMarker', 'p1:headingMarker', 'p1:landmark', 'p1:landmark'])
})

withVisit('the mismatch screen keeps both photos up, and re-placing the points takes them down', { stored: storedPair({ photos: true }) }, async (visit) => {
  await placePair(visit, 3.7)
  await visit.press('commit')
  assert.equal(visit.part('project-calibration-title').textContent, 'These markers do not match the stored pair')
  assert.equal(visit.part('project-calibration-compare').hidden, false)
  assert.equal(visit.part('project-calibration-compare-figure-a').hidden, false)
  assert.equal(visit.part('project-calibration-compare-figure-b').hidden, false)
  await visit.press('replace')
  assert.equal(visit.part('project-calibration-compare').hidden, true)
})

withVisit('a Place with no stored photos has nothing to put side by side: the panel stays off', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  await placePair(visit, 3.2)
  assert.equal(visit.part('project-calibration-compare').hidden, true)
})

withVisit('a photo that cannot be loaded says which kind of missing it is, in its own slot', { stored: storedPair({ photos: 'no-url' }), loadReferencePhoto: async () => null }, async (visit) => {
  await placePair(visit, 3.2)
  assert.equal(visit.part('project-calibration-compare').hidden, false)
  for (const slot of ['a', 'b']) {
    assert.equal(visit.part(`project-calibration-compare-figure-${slot}`).hidden, true)
    assert.equal(visit.part(`project-calibration-compare-note-${slot}`).hidden, false)
    assert.equal(visit.part(`project-calibration-compare-note-${slot}`).textContent, 'Photo never finished uploading')
  }
})

withVisit('a host with no way to load a photo shows no picture and no crash', { stored: storedPair({ photos: true }), loadReferencePhoto: false }, async (visit) => {
  await placePair(visit, 3.2)
  assert.equal(visit.part('project-calibration-compare-figure-a').hidden, true)
  assert.equal(visit.part('project-calibration-compare-note-a').textContent, 'Photo could not be loaded')
})

// ── "Wrong Place? Choose another" ─────────────────────────────────────────────────────────────────

withVisit('the wrong-place exit is on the mismatch screen where the host supplies it, and pressing it calls the host and closes with no calibration', { stored: storedPair({ separationM: 3.2 }), onWrongPlace: () => {} }, async (visit) => {
  await placePair(visit, 3.7)
  assert.ok(!visit.shown().includes('wrongPlace'), 'not in review')
  await visit.press('wrongPlace')
  assert.equal(visit.wrongPlaceCalls, 0, 'a click that reaches the hidden button in review is refused')
  assert.equal(visit.closed(), false)

  await visit.press('commit')
  assert.deepEqual(visit.shown(), ['replace', 'override', 'wrongPlace', 'skip'])
  assert.equal(visit.part(BUTTON_IDS.wrongPlace).textContent, 'Wrong Place? Choose another')
  await visit.press('wrongPlace')
  assert.equal(visit.wrongPlaceCalls, 1)
  assert.equal(visit.closed(), true)
  assert.equal(await visit.result(), null, 'nothing was committed')
  assert.equal(visit.scene.getObjectByName('calibration placement'), undefined, 'the flow\'s own marks went with it')
})

withVisit('without a hook from the host the button is not offered, and a script that clicks it changes nothing', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  await placePair(visit, 3.7)
  await visit.press('commit')
  assert.deepEqual(visit.shown(), ['replace', 'override', 'skip'], 'the mismatch screen as it was')
  await visit.press('wrongPlace')
  assert.equal(visit.closed(), false)
})

withVisit('the host is told once: a second click on the exit of a flow that has ended is not another exit', { stored: storedPair({ separationM: 3.2 }), onWrongPlace: () => {} }, async (visit) => {
  await placePair(visit, 3.7)
  await visit.press('commit')
  await visit.press('wrongPlace')
  await visit.press('wrongPlace')
  assert.equal(visit.wrongPlaceCalls, 1)
})

withVisit('the exit pressed while Use anyway waits for its photos ends the flow: nothing is dropped into the scene when they arrive', { stored: storedPair({ separationM: 3.2, photos: true }), onWrongPlace: () => {} }, async (visit) => {
  await placePair(visit, 3.8)
  await visit.press('commit')
  visit.capture.mode = 'hold'
  await visit.press('override')
  assert.equal(visit.status(), 'Saving reference photos…')

  await visit.press('wrongPlace')
  assert.equal(visit.wrongPlaceCalls, 1)
  assert.equal(visit.closed(), true)
  assert.equal(await visit.result(), null)
  for (let i = 0; i < 4; i++) {
    visit.capture.release()
    await visit.settle()
  }
  assert.deepEqual(visit.scene.children.map((child) => child.name), [], 'no marker, no grid and no ring is left for a flow that has ended')
})

// ── The floor grid ───────────────────────────────────────────────────────────────────────────────

withVisit('the floor grid stays on the scene after a commit, where the landmark is, with the markers it sits beside', {}, async (visit) => {
  const a = await visit.tap(0.5, 0.6)
  assert.ok(visit.scene.getObjectByName('calibration placement')!.getObjectByName('calibration floor plane'), 'while the flow runs it is the flow\'s')
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.ok(await visit.result())
  const grid = visit.scene.getObjectByName('calibration floor plane') as THREE.GridHelper
  assert.ok(grid, 'the grid is still there')
  assert.equal(grid.parent, visit.scene, 'it belongs to the scene now, not to the flow\'s group')
  assert.equal(visit.scene.getObjectByName('calibration placement'), undefined, 'the flow\'s own group is gone')
  assert.deepEqual([grid.position.x, grid.position.y, grid.position.z], [a.x, a.y, a.z], 'centred on the landmark, on the floor')
  assert.equal((grid.material as THREE.Material).opacity, 0.25)
  assert.ok(visit.scene.getObjectByName('calibration anchor landmark'))
  assert.ok(visit.scene.getObjectByName('calibration anchor heading'))
})

withVisit('the one-point tier keeps the grid too', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('fallback')
  assert.ok(await visit.result())
  assert.ok(visit.scene.getObjectByName('calibration floor plane'))
})

withVisit('continuing uncalibrated commits nothing, and takes the grid with the flow', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  assert.ok(visit.scene.getObjectByName('calibration floor plane'))
  await visit.press('skip')
  assert.equal(await visit.result(), null)
  assert.equal(visit.scene.getObjectByName('calibration floor plane'), undefined)
  assert.equal(visit.scene.getObjectByName('calibration placement'), undefined)
})

withVisit('a return visit that commits keeps the grid beside the stored pair it draws', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  await placePair(visit, 3.2)
  await visit.press('commit')
  assert.equal((await visit.result())?.calibration.status, 'provisional', 'a pair compares a distance: only three points can be verified')
  assert.ok(visit.scene.getObjectByName('calibration floor plane'))
  assert.ok(visit.scene.getObjectByName('calibration stored reference'))
})

// ── The crosshair ────────────────────────────────────────────────────────────────────────────────

function photosOf(result: CalibrationResult | null): { landmark: PendingReferencePhoto; heading: PendingReferencePhoto } {
  const photos = result?.referencePhotos ?? []
  const landmark = photos.find((photo) => photo.role === 'landmark')
  const heading = photos.find((photo) => photo.role === 'headingMarker')
  assert.ok(landmark && heading, `a photo of each point: got ${photos.map((photo) => photo.role).join(', ') || 'none'}`)
  return { landmark, heading }
}

withVisit('the landmark\'s crosshair is where the landmark is in the photo: the phone turned 7 degrees between the tap and Confirm', {}, async (visit) => {
  const tap = { u: 0.5, v: 0.6 }
  const a = await visit.tap(tap.u, tap.v)
  visit.camera.pose = poseFrom(START_POSE.position, -35, -7)
  await visit.press('confirm')
  // The heading marker's hit snaps 25 cm along the floor off the ray through the pixel, as a feature-point hit does, so a
  // crosshair worked out from the marker's position and one that is the tapped pixel are told apart.
  const second = { u: 0.4137, v: 0.6291 }
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  const b = await visit.tap(second.u, second.v, { x: 0.25 })
  await visit.skipCheckPoint()
  await visit.press('commit')
  const { landmark, heading } = photosOf(await visit.result())
  const markerPixel = seenFrom(b, heading.pose)!
  assert.ok(Math.abs(markerPixel.x - second.u) > 0.02, `the marker is ${(Math.abs(markerPixel.x - second.u) * VIEW.width).toFixed(0)} px from where it was tapped`)

  const expected = seenFrom(a, landmark.pose)!
  near(landmark.tapPoint.x, expected.x, 1e-9, 'x')
  near(landmark.tapPoint.y, expected.y, 1e-9, 'y')
  // The raw tap was (0.5, 0.6): a 7 degree turn moves a marker about 79 px across a 640 px view, so the tap would have been that far off.
  assert.ok(Math.abs(landmark.tapPoint.x - tap.u) * VIEW.width > 40, `the crosshair moved ${(Math.abs(landmark.tapPoint.x - tap.u) * VIEW.width).toFixed(1)} px from the tap`)
  near(heading.tapPoint.x, second.u, 1e-9, 'the phone had not moved since B was tapped: the crosshair is the tapped pixel, x')
  near(heading.tapPoint.y, second.v, 1e-9, 'y')
})

// B is photographed at its tap (WP-04b), so what can move between the tap and the photo is the phone while the camera answers. A name typed
// after the tap is typed in review (the check step has no label field: it would name a point that is not there), and is put on the photo
// when the commit collects it.
withVisit('the heading marker\'s crosshair is where it is in the frame that arrives after the phone turned, and a label typed after its tap is on the photo', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  visit.capture.mode = 'hold'
  const b = await visit.tap(0.5, 0.6)
  // The camera is slow: the phone has turned and moved by the time B's frame is taken.
  visit.camera.pose = poseFrom({ x: 0.1, y: 1.5, z: -3 }, -33, 12)
  visit.capture.release()
  await visit.settle()
  visit.capture.mode = 'ok'
  await visit.skipCheckPoint()
  await visit.type('radiator corner')
  await visit.press('commit')
  const { heading } = photosOf(await visit.result())
  const expected = seenFrom(b, heading.pose)!
  near(heading.tapPoint.x, expected.x, 1e-9, 'x')
  near(heading.tapPoint.y, expected.y, 1e-9, 'y')
  assert.ok(Math.abs(heading.tapPoint.x - 0.5) * VIEW.width > 40, 'the phone turned: the crosshair is not the tapped pixel')
  assert.equal(heading.label, 'radiator corner')
})

for (const frame of [{ width: 1080, height: 1440 }, { width: 1920, height: 1080 }]) {
  withVisit(`the crosshair is in the photo's own coordinates when the frame is ${frame.width} x ${frame.height} and the canvas covers it`, { frame }, async (visit) => {
    const a = await visit.tap(0.5, 0.6)
    visit.camera.pose = poseFrom(START_POSE.position, -35, -5)
    await visit.press('confirm')
    visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
    await visit.tap(0.5, 0.6)
    await visit.skipCheckPoint()
    await visit.press('commit')
    const { landmark } = photosOf(await visit.result())
    const inView = seenFrom(a, landmark.pose)!
    const scale = Math.max(VIEW.width / frame.width, VIEW.height / frame.height)
    const offsetX = (VIEW.width - frame.width * scale) / 2
    const offsetY = (VIEW.height - frame.height * scale) / 2
    near(landmark.tapPoint.x, (inView.x * VIEW.width - offsetX) / (frame.width * scale), 1e-9, 'x')
    near(landmark.tapPoint.y, (inView.y * VIEW.height - offsetY) / (frame.height * scale), 1e-9, 'y')
  })
}

withVisit('a runtime that cannot say its lens keeps the tap as the crosshair, as before', { lens: false }, async (visit) => {
  await visit.tap(0.4, 0.6)
  visit.camera.pose = poseFrom(START_POSE.position, -35, -7)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.6, 0.62)
  await visit.skipCheckPoint()
  await visit.press('commit')
  const { landmark, heading } = photosOf(await visit.result())
  assert.deepEqual(landmark.tapPoint, { x: 0.4, y: 0.6 })
  assert.deepEqual(heading.tapPoint, { x: 0.6, y: 0.62 })
})

/**
 * The person has tapped A and confirmed it. B is tapped from 3 m on while the camera is slow to answer, and the person turns right
 * round before it does, so B's frame, taken from where the phone is then, does not show B. The camera answers normally from then on,
 * and the check step is left by its button. Returns where B is.
 */
async function placeBWhileTurning(visit: Visit): Promise<Vec3> {
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  visit.capture.mode = 'hold'
  const b = await visit.tap(0.5, 0.6)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 160)
  visit.capture.release()
  await visit.settle()
  visit.capture.mode = 'ok'
  await visit.skipCheckPoint()
  return b
}

// ── A moved landmark is photographed again ────────────────────────────────────────────────────────

withVisit('a landmark moved after Confirm is photographed again, and the frame has both photos (the old modal gave the commit one)', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  assert.equal(visit.capture.calls, 1, 'the landmark, at Confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.capture.calls, 2, 'the heading marker, at its tap')

  // Back where the landmark can be seen: select it where it is, and put it somewhere else.
  visit.camera.pose = START_POSE
  await visit.tap(0.5, 0.6)
  assert.equal(visit.capture.calls, 2, 'selecting a marker takes no photo')
  const moved = await visit.tap(0.68, 0.64)
  assert.equal(visit.capture.calls, 3, 'a landmark that moved is photographed again')

  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.skipCheckPoint()
  await visit.press('commit')
  const { landmark, heading } = photosOf(await visit.result())
  assert.equal(visit.capture.calls, 3, 'Commit asks for no frame: each marker has the one it was tapped in front of')
  const expected = seenFrom(moved, landmark.pose)!
  near(landmark.tapPoint.x, expected.x, 1e-9, 'the new photo is of the moved landmark: x')
  near(landmark.tapPoint.y, expected.y, 1e-9, 'y')
  assert.deepEqual([landmark.role, heading.role], ['landmark', 'headingMarker'])
})

withVisit('a landmark moved before Confirm costs no extra photo: it is photographed once, at Confirm', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.tap(0.5, 0.6)
  await visit.tap(0.7, 0.66)
  assert.equal(visit.capture.calls, 0)
  await visit.press('confirm')
  assert.equal(visit.capture.calls, 1)
})

// ── What is said when a photo cannot show its marker ──────────────────────────────────────────────

// A first visit photographs B at its tap, so a point has no photo that shows it at Commit only when its frame was refused, or came after
// the phone had turned away from it: these make the camera slow (`'hold'`) or busy (`'reject'`) while B is tapped.
withVisit('a heading marker whose frame arrives after the person turned away holds the commit once, names it, and the next press saves without its photo', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  // B is tapped while the camera is slow to answer, and the person turns right round before it does: B is not in the frame that arrives, nor in front of them when Commit asks again.
  await placeBWhileTurning(visit)
  await visit.press('commit')
  assert.equal(visit.closed(), false, 'held')
  assert.equal(
    visit.status(),
    'Point B is not in the camera view. Aim at it, then press Use this alignment again. If a photo is still missing, the alignment is saved without reference photos.',
  )
  assert.ok(visit.shown().includes('commit'), 'the button is still there to press')

  await visit.press('commit')
  assert.equal(visit.closed(), true, 'the second press goes on')
  const result = await visit.result()
  assert.deepEqual(result?.referencePhotos?.map((photo) => photo.role), ['landmark'], 'with the photo it has: the frame keeps both or none, which is the saving side\'s rule')
})

withVisit('aiming at the missing point and pressing again saves both photos, and keeps the first photo it had', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  const b = await placeBWhileTurning(visit)
  await visit.press('commit')
  assert.equal(visit.closed(), false)
  const before = visit.capture.calls

  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, -6)
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  const { landmark, heading } = photosOf(await visit.result())
  assert.equal(visit.capture.calls - before, 1, 'only B was photographed again: A\'s good photo was kept')
  const expected = seenFrom(b, heading.pose)!
  near(heading.tapPoint.x, expected.x, 1e-9)
  assert.ok(landmark)
})

withVisit('a camera that gives no frame holds the commit with its own sentence, once, and the next press saves without photos', {}, async (visit) => {
  visit.capture.mode = 'reject'
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.equal(visit.closed(), false)
  assert.equal(
    visit.status(),
    'The camera gave no photo of Points A and B. Press Use this alignment again to try once more. If a photo is still missing, the alignment is saved without reference photos.',
  )
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  assert.deepEqual((await visit.result())?.referencePhotos, [])
})

withVisit('a camera that mends before the second press saves both photos, with the landmark\'s kept from Confirm', {}, async (visit) => {
  // A's frame is taken at Confirm. B's is refused at its tap, and still is when Commit asks again.
  await placePair(visit, 3, undefined, 'reject')
  await visit.press('commit')
  assert.equal(visit.closed(), false)
  assert.match(visit.status(), /^The camera gave no photo of Point B\./)
  visit.capture.mode = 'ok'
  const before = visit.capture.calls
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  photosOf(await visit.result())
  assert.equal(visit.capture.calls - before, 1, 'only B is photographed again')
})

withVisit('a landmark whose photo failed at Confirm needs the phone aimed at it again at Commit, and says so', {}, async (visit) => {
  visit.capture.mode = 'reject'
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.capture.mode = 'ok'
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.equal(visit.closed(), false)
  assert.match(visit.status(), /^Point A is not in the camera view\. Aim at it/, 'the person is standing at B, with A behind them')
  // They turn round and look at A from where they are: it is in view, and the photo is of it.
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 180)
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  photosOf(await visit.result())
})

withVisit('a photo taken again at the commit waits for the frame already on its way, and is not asked for while it is pending (a provider refuses a second request)', {}, async (visit) => {
  // Point A's frame is refused at Confirm. Point B's is asked for at its tap, and the camera is slow to give it.
  visit.capture.mode = 'reject'
  await placePair(visit, 3, undefined, 'hold')
  await visit.press('commit')
  assert.equal(visit.capture.calls, 2, 'Point A\'s frame failed at Confirm, and Point B\'s is on its way')
  assert.equal(visit.status(), 'Saving reference photos…')

  visit.capture.release()
  await visit.settle()
  assert.equal(visit.capture.calls, 3, 'Point A is asked for again once Point B\'s frame has arrived, and not before')
  visit.capture.release()
  await visit.settle()
  assert.match(visit.status(), /^Point A is not in the camera view\./, 'the person is at B: the answer is that A is behind them, not that the camera failed')
})

withVisit('frames asked for at the taps are asked for one at a time: B\'s waits for A\'s, and neither is asked for again at Commit', {}, async (visit) => {
  visit.capture.mode = 'hold'
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  assert.equal(visit.capture.calls, 1, 'A, at Confirm')
  // B is tapped from where A was, a long way up the floor, while A's frame is still on its way: the phone has not moved, so both are in view.
  await visit.tap(0.5, 0.35)
  assert.equal(visit.capture.calls, 1, 'the camera is not asked for a second frame while the first is pending')
  visit.capture.release()
  await visit.settle()
  assert.equal(visit.capture.calls, 2, 'B\'s is asked for as soon as A\'s has arrived')
  visit.capture.release()
  await visit.settle()
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  assert.equal(visit.capture.calls, 2, 'both points have a photo that shows them: nothing is asked for at Commit')
  photosOf(await visit.result())
})

withVisit('a host with no frame to give is not held for: the commit goes through with no photos and no sentence', { capture: true }, async (visit) => {
  visit.capture.mode = 'null'
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  assert.deepEqual((await visit.result())?.referencePhotos, [])
})

withVisit('a host that cannot take photos at all is not held for either, and is never asked', { capture: false }, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  assert.deepEqual((await visit.result())?.referencePhotos, [])
  assert.equal(visit.capture.calls, 0)
})

withVisit('a return visit that is verified takes no photos and holds for none: the stored ones stay', { stored: storedPair({ separationM: 3.2, photos: true }) }, async (visit) => {
  await placePair(visit, 3.2)
  const before = visit.capture.calls
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 }, -35, 160)
  await visit.press('commit')
  assert.equal(visit.closed(), true)
  assert.equal(visit.capture.calls, before, 'no frame is taken for a frame that is not changed')
  assert.ok(!('referencePhotos' in ((await visit.result()) ?? {})))
})

withVisit('nothing is moved while a commit waits for its photos: a tap then changes neither the markers nor the photos asked for', {}, async (visit) => {
  visit.capture.mode = 'hold'
  const a = await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.equal(visit.status(), 'Saving reference photos…')
  assert.equal(visit.capture.calls, 1, 'the landmark\'s frame, at Confirm, is on its way; the heading marker\'s waits for it')

  // Select the landmark and move it, as a person might while the card says it is saving.
  visit.camera.pose = START_POSE
  await visit.tap(0.5, 0.6)
  await visit.tap(0.7, 0.66)
  assert.equal(visit.status(), 'Saving reference photos…', 'the card is not disturbed')
  assert.equal(visit.capture.calls, 1, 'and no photo is taken for a marker that did not move')

  // The frames arrive late, taken from wherever the phone is now: back where it started, both points are in view. The second is asked for when the first is.
  visit.capture.release()
  await visit.settle()
  visit.capture.release()
  await visit.settle()
  assert.equal(visit.closed(), true)
  const result = await visit.result()
  assert.equal(result?.calibration.method, 'two-point-ground')
  assert.equal(visit.capture.calls, 2, 'one frame for each of the two points, and nothing at Commit')
  const landmarkMarker = visit.scene.getObjectByName('calibration anchor landmark')!
  assert.deepEqual([landmarkMarker.position.x, landmarkMarker.position.z], [a.x, a.z], 'the landmark is where it was when Commit was pressed')
})

// ── The hold names the button that is on the card ─────────────────────────────────────────────────

/**
 * The commit is pressed as "Use this alignment" in review and as "Replace this Place's reference" on the mismatch screen, where the first is
 * not on the card. A hold that told the person to press a button that is not there left them nothing to press.
 */
for (const via of ['review', 'mismatch'] as const) {
  for (const problem of ['out-of-view', 'failed'] as const) {
    withVisit(`a hold from the ${via} screen for a point that is ${problem === 'failed' ? 'refused by the camera' : 'out of view'} names a button the card shows`, { stored: via === 'mismatch' ? storedPair({ separationM: 3.2, photos: true }) : undefined }, async (visit) => {
      const pressed = via === 'review' ? 'commit' : 'override'
      if (via === 'review') {
        // A first visit photographs B at its tap: its frame is refused then, or comes after the person turned away from B.
        if (problem === 'failed') {
          await placePair(visit, 3, undefined, 'reject')
        } else {
          await visit.tap(0.5, 0.6)
          await visit.press('confirm')
          await placeBWhileTurning(visit)
        }
      } else {
        // A stored pair photographs B only when "Use anyway" keeps its points, at that press, so the trouble is made after the mismatch screen.
        await placePair(visit, 3.7)
        await visit.press('commit')
        assert.equal(visit.part('project-calibration-title').textContent, 'These markers do not match the stored pair')
        assert.ok(!visit.shown().includes('commit'), '"Use this alignment" is not on the mismatch screen')
        if (problem === 'failed') visit.capture.mode = 'reject'
        else visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.7 }, -35, 160)
      }
      const label = visit.part(BUTTON_IDS[pressed]).textContent
      assert.equal(label, via === 'review' ? 'Use this alignment' : "Replace this Place's reference", 'the card\'s own name for it')
      await visit.press(pressed)
      assert.equal(visit.closed(), false, 'held')
      const said = visit.status()
      assert.ok(said.includes(`press ${label} again`) || said.includes(`Press ${label} again`), said)
      assert.ok(visit.shown().includes(pressed), `${label} is on the card, for the person to press`)
      for (const other of ['commit', 'override'] as const) {
        if (other !== pressed) assert.ok(!said.includes(visit.part(BUTTON_IDS[other]).textContent), `the sentence does not name "${visit.part(BUTTON_IDS[other]).textContent}"`)
      }
      // The press it asks for goes on, and saves what there is.
      await visit.press(pressed)
      assert.equal(visit.closed(), true)
      assert.ok(await visit.result())
    })
  }
}

// ── A flow that has ended, or been sent back, does nothing more ──────────────────────────────────

// B's frame is asked for at its tap (a first visit) and the camera is slow to give it, so Commit has a photo to wait for.
withVisit('Re-place points pressed while the commit waits for its photos stands: the pair it was pressed for is not committed when the frame arrives', {}, async (visit) => {
  await placePair(visit, 3, undefined, 'hold')
  await visit.press('commit')
  assert.equal(visit.status(), 'Saving reference photos…')

  await visit.press('replace')
  assert.equal(visit.copy(), FIRST_VISIT_LANDMARK, 'back at step 1')
  visit.capture.release()
  await visit.settle()
  assert.equal(visit.closed(), false, 'the person asked to place the points again, and the old pair was not committed')
  assert.equal(visit.scene.getObjectByName('calibration anchor landmark'), undefined, 'and none of it was dropped into the scene')
  assert.equal(visit.copy(), FIRST_VISIT_LANDMARK)
  assert.notEqual(visit.status(), 'Saving reference photos…')

  // They go on from there, and what is committed is the new pair.
  visit.capture.mode = 'ok'
  visit.camera.pose = START_POSE
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.5 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  const result = await visit.result()
  const frame = result!.spatialFrame as Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>
  near(frame.separationM, 3.5, 1e-6, 'the new pair, not the old one (3 m)')
  photosOf(result)
})

withVisit('anything that takes the flow to another step while the commit waits for its photos ends that commit, not only Re-place points', {}, async (visit) => {
  await placePair(visit, 3, undefined, 'hold')
  await visit.press('commit')
  assert.equal(visit.status(), 'Saving reference photos…')
  // A script's click on Confirm, which a person cannot make in review (the card hides it), puts the flow back at step 2 with both markers where they were.
  await visit.press('confirm')
  assert.match(visit.copy(), /^Step 2 of 3/)
  visit.capture.release()
  await visit.settle()
  assert.equal(visit.closed(), false, 'the flow is at another step: the commit that was waiting is not carried out')
  assert.equal(visit.scene.getObjectByName('calibration anchor landmark'), undefined)
})

withVisit('a tap that was on its way when Commit was pressed moves a marker under the commit: that commit is not carried out, and the pair on the card is what the next press commits', {}, async (visit) => {
  const { a } = await placePair(visit, 3, undefined, 'hold')
  // Select B where it is, so that the next tap moves it; that tap's hit test has not answered when Commit is pressed.
  await visit.tap(0.5, 0.6)
  visit.hits.mode = 'hold'
  const moved = await visit.tap(0.7, 0.6)
  await visit.press('commit')
  assert.equal(visit.status(), 'Saving reference photos…')

  // The tap lands under the commit, and asks for a frame of B where it is now, behind the one the commit waits for. Both arrive.
  visit.hits.release()
  await visit.settle()
  visit.capture.release()
  await visit.settle()
  visit.capture.release()
  await visit.settle()
  assert.equal(visit.closed(), false, 'the pair the commit was pressed for is not the pair on the card')
  assert.equal(visit.scene.getObjectByName('calibration anchor landmark'), undefined, 'and none of it was dropped into the scene')
  assert.notEqual(visit.status(), 'Saving reference photos…')

  visit.hits.mode = 'ok'
  visit.capture.mode = 'ok'
  await visit.press('commit')
  const frame = (await visit.result())!.spatialFrame as Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>
  near(frame.separationM, Math.hypot(moved.x - a.x, moved.z - a.z), 1e-6, 'what is committed is the pair as it was moved to')
})

for (const via of ['a first visit', 'a return visit that uses the pair anyway'] as const) {
  withVisit(`Continue uncalibrated pressed while ${via === 'a first visit' ? 'the commit' : 'Use anyway'} waits for its photos ends the flow: nothing is dropped into the scene when they arrive`, { stored: via === 'a first visit' ? undefined : storedPair({ separationM: 3.2, photos: true }) }, async (visit) => {
    const mismatch = via !== 'a first visit'
    if (mismatch) {
      await placePair(visit, 3.8)
      await visit.press('commit')
    } else {
      await placePair(visit, 3, undefined, 'hold')
    }
    visit.capture.mode = 'hold'
    await visit.press(mismatch ? 'override' : 'commit')
    assert.equal(visit.status(), 'Saving reference photos…')

    await visit.press('skip')
    assert.equal(visit.closed(), true)
    assert.equal(await visit.result(), null)
    for (let i = 0; i < 4; i++) {
      visit.capture.release()
      await visit.settle()
    }
    assert.deepEqual(visit.scene.children.map((child) => child.name), [], 'no marker, no grid, no ring and no placement group is left for a flow that has ended')
  })
}

withVisit('a commit that was waiting when the flow ended, and would have ended in a hold, redraws nothing: the card is gone, and so is what it drew', {}, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  // B's frame is asked for at its tap and the camera is slow; the person turns right round before it comes, so B is not in it, nor in front of them when Commit asks again.
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  visit.capture.mode = 'hold'
  await visit.tap(0.5, 0.6)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 160)
  await visit.skipCheckPoint()
  await visit.press('commit')
  assert.equal(visit.status(), 'Saving reference photos…')
  await visit.press('skip')
  for (let i = 0; i < 4; i++) {
    visit.capture.release()
    await visit.settle()
  }
  assert.deepEqual(visit.scene.children.map((child) => child.name), [])
})

withVisit('a tap whose hit test answers after Continue uncalibrated was pressed places nothing', {}, async (visit) => {
  visit.hits.mode = 'hold'
  await visit.tap(0.5, 0.6)
  await visit.press('skip')
  assert.equal(visit.closed(), true)
  visit.hits.release()
  await visit.settle()
  assert.deepEqual(visit.scene.children.map((child) => child.name), [], 'no marker, and no placement group attached again')
})

withVisit('a record whose points and length disagree gets a ring for its points and no sentence that says the ring marks the length', { stored: { ...storedPair({ separationM: 3.2 }), headingMarker: { x: 0, y: 0, z: 2.5 } } }, async (visit) => {
  await visit.tap(0.5, 0.6)
  await visit.press('confirm')
  const [ring, ...others] = visit.rings()
  assert.ok(ring)
  assert.deepEqual(others, [])
  near(ring.radius, 2.5, 1e-5, 'the ring is where the stored point is')
  assert.equal(visit.copy(), 'Step 2 of 2 — tap Point B again, the same spot as last time. Point B was 3.20 m from A (allowed ±0.17 m).', 'the ring is not 3.20 m, so the step does not say it marks that distance')
})

// ── The status line does not contradict the chip ──────────────────────────────────────────────────

withVisit('while the chip fails the status line does not say "Ready to commit."; when the pair is the stored distance it does', { stored: storedPair({ separationM: 3.2 }) }, async (visit) => {
  await placePair(visit, 3.7)
  assert.equal(visit.part('project-calibration-chip').dataset['state'], 'fail')
  assert.equal(visit.status(), 'Not the stored distance yet.')

  // Select B where it is, and put it where it was stored.
  await visit.tap(0.5, 0.6)
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 }, -35, 0)
  await visit.tap(0.5, 0.6)
  assert.equal(visit.part('project-calibration-chip').dataset['state'], 'pass')
  assert.equal(visit.status(), 'Ready to commit.')
})

withVisit('without the aids, and on a first visit, the status line says what it always said', { stored: storedPair({ separationM: 3.2 }), search: '?returnaids=off' }, async (visit) => {
  await placePair(visit, 3.7)
  assert.equal(visit.status(), 'Ready to commit.', 'no chip, so nothing to contradict')
})

withVisit('on a first visit there is no stored distance to miss: the status line says it is ready', {}, async (visit) => {
  await placePair(visit, 3.7)
  assert.equal(visit.status(), 'Ready to commit.')
})

// ── A stored record this build did not write ─────────────────────────────────────────────────────

/**
 * Records an older build, a hand edit or a failed migration can leave. The aids read the stored points, the labels and the
 * photos when the card opens, which the card never did before: each of these opened it, and runs it, as the card as it was.
 * `rings`: how many rings the points that can be read give.
 */
const damaged: Array<{ name: string; make: (frame: Record<string, unknown>) => Record<string, unknown>; rings: number }> = [
  { name: 'no heading marker', make: ({ headingMarker, ...rest }) => (void headingMarker, rest), rings: 0 },
  { name: 'a heading marker that is null', make: (frame) => ({ ...frame, headingMarker: null }), rings: 0 },
  { name: 'no landmark', make: ({ landmark, ...rest }) => (void landmark, rest), rings: 0 },
  { name: 'a landmark that is not a point', make: (frame) => ({ ...frame, landmark: 'origin' }), rings: 0 },
  { name: 'a heading marker with no ground position', make: (frame) => ({ ...frame, headingMarker: { y: 0 } }), rings: 0 },
  { name: 'a list of check points with a null in it', make: (frame) => ({ ...frame, checkPoints: [null] }), rings: 1 },
  { name: 'check points that are not a list', make: (frame) => ({ ...frame, checkPoints: { x: 1 } }), rings: 1 },
  { name: 'labels that are not a list', make: (frame) => ({ ...frame, pointLabels: 'north door' }), rings: 1 },
  { name: 'photos that are not records', make: (frame) => ({ ...frame, referencePhotos: 'none' }), rings: 1 },
]
for (const { name, make, rings } of damaged) {
  withVisit(`a stored frame with ${name} opens the card and carries the return visit through, with the aids it can still give`, { stored: make(storedPair({ separationM: 3.2, photos: true, labels: ['north door frame', 'radiator corner'] })) }, async (visit) => {
    await visit.advance(200)
    assert.match(visit.copy(), /^Step 1 of 2 — tap Point A again, the same spot as (the photo|last time)\./, 'the landmark step')
    await visit.tap(0.5, 0.6)
    await visit.press('confirm')
    assert.equal(visit.rings().length, rings)
    assert.match(visit.copy(), /^Step 2 of 2 — tap Point B again, the same spot as (the photo|last time)\. Point B was 3\.20 m from A \(allowed ±0\.17 m\)\./)
    assert.equal(visit.copy().includes('The ring on the floor marks that distance.'), rings > 0, 'the step points at a ring only if there is one')
    visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3.2 }, -35, 0)
    await visit.tap(0.5, 0.6)
    assert.equal(visit.part('project-calibration-chip').dataset['state'], 'pass', 'the chip needs only the stored length')
    assert.ok(visit.shown().includes('commit'))
    await visit.press('commit')
    assert.equal((await visit.result())?.calibration.status, 'provisional', 'a pair compares a distance: only three points can be verified')
  })
}

// ── The floor, and the phone, are not where the other tests put them ─────────────────────────────

withVisit('with the floor 1.4 m below the session origin the ring, the kept grid and the markers are on the floor, and each crosshair is where its marker is', { floorY: -1.4, pose: poseFrom({ x: 0, y: 0, z: 0 }, -35, 0), stored: storedPair({ separationM: 3.2, photos: true }) }, async (visit) => {
  const a = await visit.tap(0.5, 0.6)
  assert.equal(a.y, -1.4, 'the landmark is on the floor')
  await visit.press('confirm')
  const [ring] = visit.rings()
  assert.ok(ring)
  assert.equal(ring.centre.y, -1.4, 'the ring lies on the floor, not on the session origin\'s plane')
  assert.deepEqual(ring.centre, a)

  visit.camera.pose = poseFrom({ x: 0, y: 0, z: -3.7 }, -35, 0)
  const b = await visit.tap(0.5, 0.6)
  assert.equal(visit.rings()[0]!.centre.y, -1.4)
  await visit.press('commit')
  assert.equal(visit.part('project-calibration-title').textContent, 'These markers do not match the stored pair')
  await visit.press('override')
  const result = await visit.result()
  const { landmark, heading } = photosOf(result)
  for (const [photo, marker] of [[landmark, a], [heading, b]] as const) {
    const expected = seenFrom(marker, photo.pose)!
    near(photo.tapPoint.x, expected.x, 1e-9, `${photo.role} x`)
    near(photo.tapPoint.y, expected.y, 1e-9, `${photo.role} y`)
  }
  const grid = visit.scene.getObjectByName('calibration floor plane')!
  assert.equal(grid.position.y, -1.4, 'the kept grid is on the floor')
  assert.equal(visit.scene.getObjectByName('calibration anchor landmark')!.position.y, -1.4)
  assert.equal(visit.scene.getObjectByName('calibration anchor heading')!.position.y, -1.4)
})

withVisit('a phone that has not moved since the tap gives the tap itself as the crosshair, through the cover-crop of a 1080 x 1440 frame on a 360 x 640 view', { frame: { width: 1080, height: 1440 } }, async (visit) => {
  // The view is narrower than the frame: the frame is scaled to the view's height and loses the same width off both sides.
  const scale = Math.max(VIEW.width / 1080, VIEW.height / 1440)
  const lostX = (1080 * scale - VIEW.width) / 2
  const intoPhoto = (u: number, v: number) => ({ x: (u * VIEW.width + lostX) / (1080 * scale), y: v })
  await visit.tap(0.25, 0.6)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.7, 0.62)
  await visit.skipCheckPoint()
  await visit.press('commit')
  const { landmark, heading } = photosOf(await visit.result())
  near(landmark.tapPoint.x, intoPhoto(0.25, 0.6).x, 1e-9, 'landmark x, in the photo\'s own coordinates')
  near(landmark.tapPoint.y, 0.6, 1e-9, 'landmark y')
  near(heading.tapPoint.x, intoPhoto(0.7, 0.62).x, 1e-9, 'heading x')
  assert.ok(Math.abs(landmark.tapPoint.x - 0.25) > 0.04, 'it is not the raw tap, which is a point in another coordinate system')
})

withVisit('a provider that hands back one pose object, changed in place, does not make a phone that turned look as if it had not', { reusePose: true }, async (visit) => {
  const a = await visit.tap(0.5, 0.6)
  visit.camera.pose = poseFrom(START_POSE.position, -35, -7)
  await visit.press('confirm')
  visit.camera.pose = poseFrom({ x: 0, y: 1.5, z: -3 }, -35, 0)
  await visit.tap(0.5, 0.6)
  await visit.skipCheckPoint()
  await visit.press('commit')
  const { landmark } = photosOf(await visit.result())
  const expected = seenFrom(a, landmark.pose)!
  near(landmark.tapPoint.x, expected.x, 1e-9, 'x')
  near(landmark.tapPoint.y, expected.y, 1e-9, 'y')
  assert.ok(Math.abs(landmark.tapPoint.x - 0.5) * VIEW.width > 40, 'the turn moved the marker in the photo: the tap would have been that far off')
})

// ── Every new frame is saved with all its photos ──────────────────────────────────────────────────

/** mulberry32: a seeded generator, so a failing walk is the same walk on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Where a marker's pixel is from the camera now: what a person would tap to select it. Null when it is out of view. */
const pixelOf = (marker: Vec3, pose: CameraPose): { u: number; v: number } | null => {
  const seen = seenFrom(marker, pose)
  return seen ? { u: seen.x, v: seen.y } : null
}

test('every new frame is saved with all its photos, each crosshair on its marker, however the markers were moved first (a hundred random walks)', async () => {
  const rand = rng(20260716)
  const pick = (low: number, high: number) => low + rand() * (high - low)
  /** Where the phone stands and which way it faces; the walk moves it along its own heading. */
  interface Stance { x: number; z: number; yaw: number }
  const pose = (stance: Stance, turn = 0, shift = 0): CameraPose => poseFrom({ x: stance.x + shift, y: 1.5, z: stance.z }, -35, stance.yaw + turn)
  /** Jitter that is either nothing at all or plainly a move: never the 2 cm and 2 degrees in between, where the tap and the marker part by a few pixels. */
  const jitter = (stance: Stance): CameraPose =>
    rand() < 0.4 ? pose(stance) : pose(stance, (rand() < 0.5 ? -1 : 1) * pick(4, 6), (rand() < 0.5 ? -1 : 1) * pick(0.06, 0.1))
  const pixel = () => ({ u: pick(0.36, 0.64), v: pick(0.56, 0.7) })
  let frames = 0
  let withMoves = 0
  const roles = new Set<string>()

  for (let walk = 0; walk < 100; walk++) {
    let stance: Stance = { x: pick(-1, 1), z: pick(-1, 1), yaw: pick(-20, 20) }
    const visit = await openVisit({ pose: pose(stance) })
    try {
      const first = pixel()
      let a = await visit.tap(first.u, first.v)
      // Moved before Confirm, sometimes: select it where it is, tap it somewhere else.
      for (let i = 0, n = Math.floor(rand() * 3); i < n; i++) {
        const seen = pixelOf(a, visit.camera.pose)!
        await visit.tap(seen.u, seen.v)
        const next = pixel()
        a = await visit.tap(next.u, next.v)
      }
      visit.camera.pose = jitter(stance)
      await visit.press('confirm')

      // Moved after Confirm, from where it can be seen.
      let moves = 0
      for (let i = 0, n = Math.floor(rand() * 3); i < n; i++) {
        visit.camera.pose = jitter(stance)
        const seen = pixelOf(a, visit.camera.pose)
        if (!seen) continue
        await visit.tap(seen.u, seen.v)
        const next = pixel()
        visit.camera.pose = jitter(stance)
        a = await visit.tap(next.u, next.v)
        moves++
      }

      // Walk 2 to 4 m along the heading to the second marker and tap it. Sometimes tap it again somewhere else first.
      const apart = pick(2, 4)
      stance = { x: stance.x - Math.sin(stance.yaw * Math.PI / 180) * apart, z: stance.z - Math.cos(stance.yaw * Math.PI / 180) * apart, yaw: stance.yaw }
      visit.camera.pose = pose(stance)
      const second = pixel()
      let b = await visit.tap(second.u, second.v)
      if (rand() < 0.4) {
        const seen = pixelOf(b, visit.camera.pose)!
        await visit.tap(seen.u, seen.v)
        const next = pixel()
        b = await visit.tap(next.u, next.v)
      }
      await visit.skipCheckPoint()
      visit.camera.pose = jitter(stance)
      await visit.press('commit')
      if (!visit.closed()) await visit.press('commit')
      assert.equal(visit.closed(), true, `walk ${walk}: the commit went through`)

      const result = await visit.result()
      const { landmark, heading } = photosOf(result)
      for (const [photo, marker] of [[landmark, a], [heading, b]] as const) {
        const expected = seenFrom(marker, photo.pose)
        assert.ok(expected, `walk ${walk}: the ${photo.role} is in its own photo`)
        near(photo.tapPoint.x, expected.x, 1e-6, `walk ${walk} ${photo.role} x`)
        near(photo.tapPoint.y, expected.y, 1e-6, `walk ${walk} ${photo.role} y`)
        roles.add(photo.role)
      }

      // And through the code that saves them: the Place keeps both photos, and both are uploaded.
      const project = { projectId: 'p1', name: 'Room', createdAt: 0, updatedAt: 0, floors: [] } as unknown as Project
      const sent = await sendFrameLikeThePhone(project, result!.spatialFrame as ProjectSpatialFrame, result!.referencePhotos ?? [])
      const photos = (sent.body.frame as Extract<ProjectSpatialFrame, { method: 'two-point-ground' }>).referencePhotos as { landmark: CalibrationReferencePhoto; headingMarker: CalibrationReferencePhoto } | undefined
      assert.ok(photos?.landmark && photos.headingMarker, `walk ${walk}: the saved frame carries both photo records`)
      assert.deepEqual([...sent.uploads].sort(), ['headingMarker', 'landmark'], `walk ${walk}: both photos are uploaded`)
      frames++
      if (moves > 0) withMoves++
    } finally {
      await visit.dispose()
    }
  }
  assert.equal(frames, 100)
  assert.ok(withMoves >= 25, `the walks include a landmark moved after Confirm: ${withMoves} of ${frames}`)
  assert.deepEqual([...roles].sort(), ['headingMarker', 'landmark'])
})
