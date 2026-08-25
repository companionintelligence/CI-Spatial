/**
 * Stub mode — a real, loadable sequence with no GPU.
 *
 * This is a first-class feature, not a test fixture. No host on the fleet can
 * run 4DAnyone, so without it *nothing* downstream of submission — the job, the
 * artifact routes, the viewer layer, the playback clock — could be exercised at
 * all. With it, every one of those is real.
 *
 * Mirrors `scripts/make-splat-fixture.mjs` in the main repo, whose whole point
 * is that "the served-`.ply` → `SplatMesh` data path is identical to a real
 * run". The same holds here, extended to a sequence: these are valid INRIA 3DGS
 * files that differ frame to frame, so playback genuinely animates.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Deterministic PRNG, so a stub sequence is reproducible across runs. */
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SH_C0 = 0.28209479177387814
const dc = c => (c - 0.5) / SH_C0

/**
 * A valid binary INRIA 3DGS .ply of a crude humanoid.
 *
 * `phase` shifts the figure's limbs so consecutive frames differ visibly —
 * a sequence of identical frames would "play" without proving anything about
 * the playback clock.
 */
export function buildStubPly(count, phase) {
  const props = [
    'x', 'y', 'z', 'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
  ]
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${count}`,
    ...props.map(p => `property float ${p}`),
    'end_header\n',
  ].join('\n')
  const headerBytes = Buffer.from(header, 'ascii')
  const stride = props.length * 4
  const body = Buffer.alloc(count * stride)
  const rand = mulberry32(1337)
  // Two components in quadrature, so no two phases in [0,1) produce the same
  // pose. A single sine collides at 0 and 0.5 (both zero), which made those
  // frames byte-identical and a "playing" sequence prove nothing.
  const swing = Math.sin(phase * Math.PI * 2) * 0.35
  const bob = Math.cos(phase * Math.PI * 2) * 0.06

  for (let i = 0; i < count; i++) {
    let off = i * stride
    const part = i % 6
    let x, y, z
    const j = rand()
    switch (part) {
      case 0: x = (rand() - 0.5) * 0.22; y = 1.55 + j * 0.22; z = (rand() - 0.5) * 0.22; break        // head
      case 1: case 2: x = (rand() - 0.5) * 0.36; y = 0.75 + j * 0.7; z = (rand() - 0.5) * 0.2; break  // torso
      case 3: x = -0.28 - j * 0.18 + swing; y = 0.85 + j * 0.5; z = (rand() - 0.5) * 0.14; break      // arm L
      case 4: x = 0.28 + j * 0.18 - swing; y = 0.85 + j * 0.5; z = (rand() - 0.5) * 0.14; break       // arm R
      default: x = (rand() - 0.5) * 0.3 + (i % 2 ? swing : -swing) * 0.4; y = j * 0.75; z = (rand() - 0.5) * 0.16 // legs
    }
    const writeF = v => { body.writeFloatLE(v, off); off += 4 }
    writeF(x); writeF(y + bob); writeF(z)
    writeF(0); writeF(0); writeF(1)
    writeF(dc(0.45 + rand() * 0.3))
    writeF(dc(0.4 + rand() * 0.3))
    writeF(dc(0.38 + rand() * 0.3))
    writeF(4.0)                                  // opacity logit → ≈0.98
    writeF(-3.9); writeF(-3.9); writeF(-3.9)     // log-space scale → small splats
    writeF(1); writeF(0); writeF(0); writeF(0)   // identity rotation
  }
  return Buffer.concat([headerBytes, body])
}

/**
 * Produce a complete stub sequence.
 *
 * Deliberately writes `.ply` rather than `.sog`: `.sog` is a ZIP container
 * produced by splat-transform, and a hand-rolled fake would be a fake in a way
 * a `.ply` is not. The viewer's artifact preference chain already falls back to
 * `.ply`, so the load path is the real one either way.
 */
export async function runStub({ takeId, sequenceDir, frameCount = 12, fps = 5, gaussians = 3000, clipCount = 1 }) {
  await mkdir(sequenceDir, { recursive: true })
  for (let i = 0; i < frameCount; i++) {
    const ply = buildStubPly(gaussians, i / frameCount)
    await writeFile(path.join(sequenceDir, `frame-${String(i).padStart(5, '0')}.ply`), ply)
  }
  return {
    status: 'ok',
    takeId,
    viewSource: clipCount > 1 ? 'multi-camera' : 'densified',
    clipCount,
    viewCount: clipCount > 1 ? clipCount : 6,
    frameCount,
    fps,
    durationMs: Math.round((frameCount / fps) * 1000),
    sequenceDir,
    stub: true,
  }
}
