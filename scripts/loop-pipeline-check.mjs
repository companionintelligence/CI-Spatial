#!/usr/bin/env node
/**
 * Tier 4 — does a captured session actually reconstruct, and land metric?
 *
 * The unit tests prove the Umeyama fit is correct in the abstract. They cannot
 * prove that what the phone wrote to disk carries the pose and lens data the
 * fit needs, which is the seam every real failure in this pipeline has lived in
 * so far:
 *
 *   - Keyframe intrinsics carried a hardcoded 60° placeholder for months. The
 *     probe read `intr.fy` off what 8th Wall actually returns — a flat
 *     16-element projection matrix — so it never fired, and every splat trained
 *     against a lens the phone does not have. Nothing failed. The numbers were
 *     simply wrong, all the way into `fl_x`/`fl_y` in the Brush dataset.
 *   - Sessions were captured with no pose at all, so `splat-align` correctly
 *     skipped every time and the absence read as "the feature is off".
 *
 * Both are data-shape problems that only a check over real artifacts catches.
 * This asserts the properties, not exact values, so a different room or phone
 * still passes.
 *
 * Skips (exit 0) rather than fails when there is no session to check — the same
 * contract every optional GPU stage in this repo uses. A machine with no
 * captures is not a broken machine.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SESSIONS = join(ROOT, 'scans', 'sessions')

const skip = (why) => { console.log(`[pipeline-check] skipped — ${why}`); process.exit(0) }
const fail = (why) => { console.error(`[pipeline-check] FAIL — ${why}`); process.exit(1) }

if (!existsSync(SESSIONS)) skip('no scans/sessions directory on this machine')

/** Newest session that has keyframe records at all. */
const candidates = readdirSync(SESSIONS)
  .map((name) => ({ name, dir: join(SESSIONS, name) }))
  .filter(({ dir }) => {
    try { return statSync(dir).isDirectory() && existsSync(join(dir, 'keyframes.jsonl')) } catch { return false }
  })
  .sort((a, b) => statSync(b.dir).mtimeMs - statSync(a.dir).mtimeMs)

if (candidates.length === 0) skip('no session carries a keyframes.jsonl')

const { name, dir } = candidates[0]
const records = readFileSync(join(dir, 'keyframes.jsonl'), 'utf8')
  .split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)

if (records.length === 0) skip(`${name} has an empty keyframes.jsonl`)

const withPose = records.filter((r) => r.pose?.position)
console.log(`[pipeline-check] ${name}: ${records.length} keyframes, ${withPose.length} with pose`)

if (withPose.length === 0) {
  // Not a failure: a session may legitimately predate pose capture, and COLMAP
  // exists precisely to solve poses when the runtime did not supply them.
  skip(`${name} carries no AR poses (COLMAP path, not the metric path)`)
}

// ── Lens ────────────────────────────────────────────────────────────────────
// The regression that hid for months. 60.0 exactly is the placeholder value;
// a real device reads something else (64.58° measured on the Beam Pro). Guard
// the exact placeholder rather than a plausible range, so an unusual-but-real
// lens is never rejected.
const intr = withPose.map((r) => r.intrinsics).filter(Boolean)
if (intr.length === 0) fail(`${name} has poses but no intrinsics — the Brush dataset cannot be built`)

const placeholders = intr.filter((i) => Number(i.fovYDeg) === 60)
if (placeholders.length === intr.length) {
  fail(`every keyframe reports fovYDeg exactly 60 — the intrinsics probe is not firing `
     + `(see src/ar/eighthwall.ts; 8th Wall returns a projection matrix, not intr.fy)`)
}
for (const i of intr) {
  if (!Number.isFinite(i.fovYDeg) || i.fovYDeg <= 20 || i.fovYDeg >= 140) {
    fail(`implausible fovYDeg ${i.fovYDeg} — intrinsics are being written wrong`)
  }
  if (!(i.width > 0 && i.height > 0)) fail(`keyframe intrinsics missing frame size`)
}
console.log(`[pipeline-check] lens ok — fovYDeg ${intr[0].fovYDeg.toFixed(2)}, `
  + `${intr[0].width}x${intr[0].height}`)

// ── Parallax ────────────────────────────────────────────────────────────────
// A rotation-only capture cannot triangulate: 29 of 36 pairs came back
// PLANAR_OR_PANORAMIC on exactly that. Warn rather than fail — a legitimately
// small sweep is still a legitimate session, and this is the number to look at
// first when a reconstruction comes out thin.
const P = withPose.map((r) => [r.pose.position.x, r.pose.position.y, r.pose.position.z])
let baseline = 0
for (let i = 0; i < P.length; i++) {
  for (let j = i + 1; j < P.length; j++) {
    baseline = Math.max(baseline, Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]))
  }
}
console.log(`[pipeline-check] max camera baseline ${baseline.toFixed(2)} m`
  + (baseline < 0.5 ? '  ⚠ rotation-only — expect PLANAR_OR_PANORAMIC pairs' : ''))

// ── Metric carry-through ────────────────────────────────────────────────────
// The property that makes the whole thing a *spatial* memory: the trainer must
// consume the device's metric poses unchanged. If these drift apart, the splat
// is no longer in the same units as the mesh it will be shown beside.
const transforms = join(dir, 'brush-dataset', 'transforms.json')
if (!existsSync(transforms)) {
  console.log('[pipeline-check] no brush-dataset yet — capture checks passed, training not run')
  process.exit(0)
}

const t = JSON.parse(readFileSync(transforms, 'utf8'))
const frames = t.frames ?? []
if (frames.length === 0) fail('brush-dataset/transforms.json has no frames')

const byFile = new Map(withPose.map((r) => [String(r.file ?? '').split('/').pop(), r.pose.position]))
let checked = 0, worst = 0
for (const f of frames) {
  const key = String(f.file_path ?? '').split('/').pop()
  const pose = byFile.get(key)
  if (!pose) continue
  const m = f.transform_matrix
  const d = Math.hypot(m[0][3] - pose.x, m[1][3] - pose.y, m[2][3] - pose.z)
  worst = Math.max(worst, d)
  checked++
}

if (checked === 0) {
  console.log('[pipeline-check] transforms.json frames do not name keyframe files — '
    + 'solved-pose (COLMAP) dataset, metric carry-through not applicable')
  process.exit(0)
}

// 1 mm: this is a copy, not a fit. Anything above rounding means something is
// transforming poses on the way into the trainer.
if (worst > 1e-3) {
  fail(`camera centres drifted up to ${worst.toFixed(4)} m from the device poses `
     + `across ${checked} frames — the trainer is not consuming metric poses unchanged`)
}
console.log(`[pipeline-check] metric carry-through ok — ${checked} frames match device poses `
  + `to ${worst.toExponential(1)} m`)
console.log('[pipeline-check] PASS')
