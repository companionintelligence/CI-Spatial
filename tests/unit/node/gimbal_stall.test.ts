/**
 * Gimbal stall detection, tested against telemetry captured from real hardware.
 *
 * Both fixtures below are verbatim pan readings from `gimbal_move_to` calls on
 * an OM6 on 2026-08-26, one wedged and one healthy. That matters: the bug this
 * guards against only shows up on tired hardware after a long session, so a
 * synthetic fixture would be testing my idea of a jam rather than a real one.
 *
 * Run: npm run test:gimbal:stall
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STALL_EPSILON_DEG,
  STALL_TICKS_LIMIT,
  movedDeg,
  foldStall,
  firstStallTick,
  createStallGuard,
  createWedgeGuard,
  STUCK_POSITIONS_LIMIT,
  NO_PROGRESS_DEG,
} from '../../../subsystems/osmo-ble/protocol/stall.mjs'

const s = (pan: number, tilt = 0) => ({ pan, tilt })

/**
 * A real jam: the axis travelled 84.7 → 75.66, hit a limit, then reported
 * *exactly* 75.66 for the next 27 seconds while still 50.7° from target. The
 * loop reported `timedOut` after burning the full 30s budget.
 */
const WEDGED = [
  84.72, 85.69, 85.69, 76.38, 76.38, 76.38, 75.65, 75.65, 75.65, 75.65, 75.65, 75.66,
  75.66, 75.66, 75.66, 75.66, 75.66, 75.66, 75.66, 75.66, 75.67, 75.67, 75.67, 75.66,
  75.66, 75.67, 75.67, 75.67, 75.67, 75.66, 75.67, 75.67, 75.67, 75.67, 75.66, 75.67,
].map((p) => s(p))

/** A healthy move from the same session: 171.8 → 100.8, crossing ±180 on the way. */
const MOVING = [
  171.76, 171.77, 171.77, -171.39, -171.39, -171.39, 179.04, 179.04, 162.30, 162.30,
  162.30, 148.20, 148.20, 131.75, 131.75, 131.75, 116.92, 116.92, 100.76, 100.76,
].map((p) => s(p))

test('a jammed axis is detected, and far sooner than the timeout', () => {
  const at = firstStallTick(WEDGED)
  assert.ok(at > 0, 'the wedged run must be flagged')
  // ~400ms per tick: this is the 30s → ~5s saving, per move, for every caller.
  assert.ok(at <= 15, `expected an early catch, got tick ${at}`)
})

test('a genuinely moving axis is never flagged', () => {
  assert.equal(firstStallTick(MOVING), -1)
})

test('crossing ±180 measures the short way round', () => {
  // 179 → -179 is 2° of travel, not 358°. It is still real motion — the point
  // is the magnitude, not the verdict. Unwrapped it would read as a 358° leap,
  // which is indistinguishable from a healthy fast sweep, so a gimbal that
  // jams right after the seam would keep looking alive.
  assert.ok(Math.abs(movedDeg(s(179), s(-179)) - 2) < 1e-9)
  assert.ok(Math.abs(movedDeg(s(-179), s(179)) - 2) < 1e-9)
  // And a seam crossing that really is a jam — no movement at all across it —
  // still registers as stalled.
  assert.ok(movedDeg(s(180), s(-180)) < STALL_EPSILON_DEG)
})

test('tilt-only motion counts as motion', () => {
  // A pan-jammed but tilt-free gimbal is still doing something; only declare a
  // stall when both axes are still.
  assert.equal(foldStall(5, { pan: 10, tilt: 0 }, { pan: 10, tilt: 8 }), 0)
})

test('the counter resets on any real movement', () => {
  let n = 0
  n = foldStall(n, s(10), s(10))      // stalled
  n = foldStall(n, s(10), s(10))      // stalled
  assert.equal(n, 2)
  n = foldStall(n, s(10), s(25))      // moved
  assert.equal(n, 0, 'a moving tick must clear the count, not decrement it')
})

test('the first sample can never be a stall', () => {
  assert.equal(foldStall(99, null, s(10)), 0)
})

test('a run shorter than the limit is not a stall', () => {
  const brief = Array.from({ length: STALL_TICKS_LIMIT - 1 }, () => s(42))
  assert.equal(firstStallTick(brief), -1)
})

// ── The stall guard ──────────────────────────────────────────────────────────
// This state machine exists because the same logic, written inline in the
// control loop, grew two control-flow bugs in one sitting. Both were invisible
// except as a nonsense number in an error string, so it is tested exhaustively.

const feed = (guard: ReturnType<typeof createStallGuard>, pan: number, n: number) =>
  Array.from({ length: n }, () => guard.observe({ pan, tilt: 0 }))

test('guard: a moving axis is always ok', () => {
  const g = createStallGuard()
  const verdicts = MOVING.map((sample) => g.observe(sample))
  assert.ok(verdicts.every((v) => v === 'ok'))
  assert.equal(g.flipped, false)
})

test('guard: a stall asks for a sign flip before ever calling it jammed', () => {
  const g = createStallGuard()
  const verdicts = feed(g, 42, STALL_TICKS_LIMIT + 1)
  assert.equal(verdicts.filter((v) => v === 'flip-sign').length, 1)
  assert.ok(!verdicts.includes('jammed'), 'must not condemn on the first stall')
  assert.equal(g.flipped, true)
})

test('guard: the flipped direction gets a full budget of its own', () => {
  const g = createStallGuard()
  feed(g, 42, STALL_TICKS_LIMIT + 1)          // first stall -> flip
  // This is the bug that shipped briefly: a leftover count condemned the
  // flipped direction immediately, reported as "0 consecutive ticks".
  const next = feed(g, 42, STALL_TICKS_LIMIT - 1)
  assert.ok(!next.includes('jammed'), 'flipped direction was condemned too early')
})

test('guard: stalling in both directions is jammed', () => {
  const g = createStallGuard()
  feed(g, 42, STALL_TICKS_LIMIT + 1)          // flip
  const after = feed(g, 42, STALL_TICKS_LIMIT + 1)
  assert.ok(after.includes('jammed'))
})

test('guard: it only ever flips once', () => {
  const g = createStallGuard()
  const all = [...feed(g, 42, STALL_TICKS_LIMIT + 1), ...feed(g, 42, STALL_TICKS_LIMIT * 3)]
  assert.equal(all.filter((v) => v === 'flip-sign').length, 1)
})

test('guard: recovering after the flip never reports jammed', () => {
  // The real 2026-08-26 recovery: stuck at -53.6, flipped, then moved away.
  const g = createStallGuard()
  feed(g, -53.6, STALL_TICKS_LIMIT + 1)       // stall -> flip-sign
  const recovery = [-59.8, -74.5, -90.9, -105.8, -122.7]
    .map((pan) => g.observe({ pan, tilt: 0 }))
  assert.ok(recovery.every((v) => v === 'ok'), 'a recovered move must not be condemned')
})

/**
 * Run-level wedge detection (createWedgeGuard).
 *
 * The fixture below is the real 2026-08-26 movement-only run: ten consecutive
 * positions that every one of them ended at pan 105.56363203199156 /
 * tilt 27.183930105588214 — bit-identical, because the gimbal had stopped
 * moving entirely. The run kept going anyway (the movement-only branch
 * `continue`d past the wedge check, which at the time lived only in the
 * photo-capture path), so the motors held against the jam for all ten
 * positions and the gimbal overheated and shut itself off mid-run.
 */
const FROZEN_POSE = { pan: 105.56363203199156, tilt: 27.183930105588214 }
const frozenMove = (over: Partial<Record<string, unknown>> = {}) => ({
  converged: false,
  stalled: false,
  finalYaw: FROZEN_POSE.pan,
  finalPitch: FROZEN_POSE.tilt,
  ...over,
})

test('wedge: the real frozen-pose run aborts instead of grinding on', () => {
  const w = createWedgeGuard()
  const verdicts = Array.from({ length: 10 }, () => w.observe(frozenMove()))
  const firstAbort = verdicts.indexOf(true)
  assert.equal(firstAbort, STUCK_POSITIONS_LIMIT - 1, 'must abort on the limit-th stuck position')
  assert.ok(firstAbort < 9, 'must not run all ten positions into the jam')
})

test('wedge: a jammed move counts on its own, without needing a repeated pose', () => {
  // moveToClosedLoop's own stall guard already probed both correction
  // directions before reporting stalled, so it is a stronger signal than
  // pose-comparison and must not require a second sample to be believed.
  const w = createWedgeGuard()
  const moving = [10, 40, 70]
  const verdicts = moving.map((pan) =>
    w.observe({ converged: false, stalled: true, finalYaw: pan, finalPitch: 0 }))
  assert.deepEqual(verdicts, [false, false, true])
})

test('wedge: a converged move clears the count', () => {
  const w = createWedgeGuard()
  w.observe(frozenMove())
  w.observe(frozenMove())
  assert.equal(w.observe({ converged: true, finalYaw: 0, finalPitch: 0 }), false)
  // Progress means the gimbal is alive, so a later jam starts a fresh budget.
  assert.equal(w.observe(frozenMove()), false)
  assert.equal(w.observe(frozenMove()), false)
  assert.equal(w.observe(frozenMove()), true)
})

test('wedge: merely falling short at DIFFERENT poses is not a wedge', () => {
  // A move can legitimately miss tolerance while still travelling. Aborting on
  // that would kill healthy runs on a tight tolerance.
  const w = createWedgeGuard()
  const verdicts = [10, 30, 55, 80, 110].map((pan) =>
    w.observe({ converged: false, stalled: false, finalYaw: pan, finalPitch: 0 }))
  assert.ok(verdicts.every((v) => v === false), 'a moving-but-short run must not abort')
})

test('wedge: a pose repeat across the ±180 seam still counts as stuck', () => {
  const w = createWedgeGuard()
  const verdicts = [179.9, -179.9, 179.95].map((pan) =>
    w.observe({ converged: false, stalled: false, finalYaw: pan, finalPitch: 0 }))
  assert.equal(verdicts[2], true, 'wrap-around must not read as a 360° leap')
})

/**
 * Pan driven into its mechanical limit, verbatim from a `gimbal_move_to` on an
 * OM6 on 2026-08-28 (target yaw -120). Pairs are [pan, |yawErr| + |pitchErr|].
 *
 * The shape is what makes it interesting: mostly flat at -145.8, with two 3.9°
 * excursions where the motor shoves against the stop and the stop springs it
 * straight back. The error never leaves 28.1 ± 0.1.
 */
const LIMIT_SPRING_BACK: Array<[number, number]> = [
  [-146.398, 28.673], [-150.024, 32.295], [-145.751, 28.023], [-145.728, 28.020],
  [-145.735, 28.050], [-145.766, 28.111], [-145.781, 28.129], [-145.788, 28.146],
  [-145.761, 28.112], [-149.695, 32.035], [-145.833, 28.170], [-145.806, 28.149],
  [-145.823, 28.162],
]

/** A healthy move from the same session — a recenter that closed 31° in 7.8s. */
const CONVERGING: Array<[number, number]> = [
  [-159.45, 182.86], [-168.32, 188.26], [-159.98, 176.96], [-152.86, 167.27],
  [-151.92, 164.14], [-150.23, 160.51], [-149.99, 158.32], [-148.52, 154.81],
  [-147.48, 151.85],
]

const replay = (samples: Array<[number, number]>) => {
  const g = createStallGuard()
  const verdicts = samples.map(([pan, err]) => g.observe({ pan, tilt: -2.3 }, err))
  return { guard: g, verdicts }
}

test('a spring-loaded limit is not caught by tick counting alone', () => {
  // Documents WHY netProgressDeg exists rather than a bigger STALL_TICKS_LIMIT.
  // The verdict machine needs 12 ticks (flip, then condemn); the two spring-back
  // excursions reset the count, so 13 real ticks still only reach 'flip-sign'.
  const { verdicts } = replay(LIMIT_SPRING_BACK)
  assert.ok(verdicts.includes('flip-sign'), 'the flat stretch must at least trip a sign flip')
  assert.ok(!verdicts.includes('jammed'), 'tick counting alone does not reach jammed here')
})

test('a move that closed no distance is jammed, however its ticks counted', () => {
  const { guard } = replay(LIMIT_SPRING_BACK)
  assert.ok(guard.netProgressDeg < NO_PROGRESS_DEG,
    `expected < ${NO_PROGRESS_DEG}°, got ${guard.netProgressDeg.toFixed(2)}°`)
})

test('a slow but genuinely converging move is never called jammed', () => {
  // The regression that matters in the other direction: this one also times out
  // without converging, and must still read as "give it longer", not "jammed".
  const { guard, verdicts } = replay(CONVERGING)
  assert.ok(guard.netProgressDeg > NO_PROGRESS_DEG,
    `expected > ${NO_PROGRESS_DEG}°, got ${guard.netProgressDeg.toFixed(2)}°`)
  assert.ok(!verdicts.includes('jammed'))
})

test('the two populations are far apart, so the threshold needs no tuning', () => {
  const jammed = replay(LIMIT_SPRING_BACK).guard.netProgressDeg
  const healthy = replay(CONVERGING).guard.netProgressDeg
  assert.ok(healthy > jammed * 20,
    `expected a wide margin, got jammed ${jammed.toFixed(2)}° vs healthy ${healthy.toFixed(2)}°`)
})

test('progress folding ignores displacement that goes nowhere', () => {
  // Same pose every tick, but oscillating well above STALL_EPSILON_DEG — the
  // exact pattern a mechanical stop produces, and the one movedDeg() reads as
  // healthy motion.
  const g = createStallGuard()
  const verdicts = []
  for (let i = 0; i < 20; i++) {
    verdicts.push(g.observe({ pan: i % 2 ? 100 : 104, tilt: 0 }, i % 2 ? 40 : 44))
  }
  // movedDeg() reads 4° of travel on every one of those ticks — 76° over the
  // run. netProgressDeg is first-minus-best, so the whole run only ever credits
  // the single 44° → 40° excursion: it is bounded by the oscillation, not by
  // how long the gimbal sits in it.
  assert.equal(g.netProgressDeg, 4)
  const longer = createStallGuard()
  for (let i = 0; i < 40; i++) {
    longer.observe({ pan: i % 2 ? 100 : 104, tilt: 0 }, i % 2 ? 40 : 44)
  }
  assert.equal(longer.netProgressDeg, 4, 'twice the ticks close no further distance')
  assert.ok(verdicts.includes('jammed'), 'and the oscillation still condemns the move')
})
