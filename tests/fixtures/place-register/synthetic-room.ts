/**
 * Synthetic rooms for the place-register tests.
 *
 * A room is a box of floor, four walls and a ceiling, optionally with furniture
 * boxes, doorway gaps and walls left unscanned, sampled at random with a seeded
 * generator so every run produces the same points. The output is a flat
 * `Float32Array` of x, y, z triples in the frame the room is built in (Y up, the
 * floor at `floorY`), which is what a scan looks like to the matcher once its
 * `localToWorld` has been applied.
 *
 * "Two scans of one room that disagree" is built the way it happens: the same
 * room is sampled twice (different random points, different noise, furniture
 * moved) and the second cloud is carried through an injected placement error
 * with {@link misplace}. The matcher's job is to find the move that undoes it.
 *
 * Pure TypeScript with no runtime API, so Deno and Node tests both load it.
 */

/** A deterministic 32-bit generator (mulberry32), the same one scripts/make-lingbot-fixture.mjs uses. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A box of furniture standing on the floor: centre (x, z), size (w along x, d along z), height h. */
export interface Box {
  x: number
  z: number
  w: number
  d: number
  h: number
}

export type WallName = 'north' | 'south' | 'east' | 'west'

export interface RoomSpec {
  /** Side along x, metres. */
  width: number
  /** Side along z, metres. */
  depth: number
  /** Centre of the room on the floor. Defaults to the origin. */
  centre?: { x: number; z: number }
  /** Ceiling height above the floor. Default 2.6. */
  height?: number
  /** Floor height. Default 0. */
  floorY?: number
  boxes?: Box[]
  /** Walls that were not scanned: no points for them. */
  unscanned?: WallName[]
  /** Doorways: along `wall`, no points between `from` and `to` metres from the wall's start. */
  gaps?: Array<{ wall: WallName; from: number; to: number }>
  /** Per-axis Gaussian noise on every point, metres. Default 0. */
  noiseM?: number
  /** Points per square metre of surface. Default 120. */
  density?: number
  /** Points per square metre of the floor alone, to build a floor that was seen only sparsely. Default: `density`. */
  floorDensity?: number
  /** Leave the floor out. */
  noFloor?: boolean
  /** Leave the ceiling out. */
  noCeiling?: boolean
  seed: number
}

export function makeRoom(spec: RoomSpec): Float32Array {
  const random = rng(spec.seed)
  const gauss = (): number => {
    const u = Math.max(random(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
  }
  const noise = spec.noiseM ?? 0
  const density = spec.density ?? 120
  const height = spec.height ?? 2.6
  const floorY = spec.floorY ?? 0
  const cx = spec.centre?.x ?? 0
  const cz = spec.centre?.z ?? 0
  const points: number[] = []

  const add = (x: number, y: number, z: number): void => {
    points.push(x + noise * gauss(), y + noise * gauss(), z + noise * gauss())
  }
  /** `area` square metres of a rectangle spanned from `origin` by `u` and `v`, sampled uniformly. */
  const sample = (
    area: number,
    at: (a: number, b: number) => [number, number, number],
    keep: (a: number, b: number) => boolean = () => true,
    perSquareMetre: number = density,
  ): void => {
    const count = Math.round(area * perSquareMetre)
    for (let i = 0; i < count; i++) {
      const a = random()
      const b = random()
      if (!keep(a, b)) continue
      const [x, y, z] = at(a, b)
      add(x, y, z)
    }
  }

  const x0 = cx - spec.width / 2
  const z0 = cz - spec.depth / 2
  if (!spec.noFloor) {
    sample(spec.width * spec.depth, (a, b) => [x0 + a * spec.width, floorY, z0 + b * spec.depth], () => true, spec.floorDensity ?? density)
  }
  if (!spec.noCeiling) {
    sample(spec.width * spec.depth, (a, b) => [x0 + a * spec.width, floorY + height, z0 + b * spec.depth])
  }

  const gapped = (wall: WallName, along: number): boolean =>
    (spec.gaps ?? []).some((gap) => gap.wall === wall && along >= gap.from && along <= gap.to)
  const unscanned = new Set(spec.unscanned ?? [])
  const walls: Array<{ wall: WallName; length: number; at: (a: number, b: number) => [number, number, number] }> = [
    { wall: 'north', length: spec.width, at: (a, b) => [x0 + a * spec.width, floorY + b * height, z0] },
    { wall: 'south', length: spec.width, at: (a, b) => [x0 + a * spec.width, floorY + b * height, z0 + spec.depth] },
    { wall: 'west', length: spec.depth, at: (a, b) => [x0, floorY + b * height, z0 + a * spec.depth] },
    { wall: 'east', length: spec.depth, at: (a, b) => [x0 + spec.width, floorY + b * height, z0 + a * spec.depth] },
  ]
  for (const { wall, length, at } of walls) {
    if (unscanned.has(wall)) continue
    sample(length * height, at, (a) => !gapped(wall, a * length))
  }

  for (const box of spec.boxes ?? []) {
    const bx0 = box.x - box.w / 2
    const bz0 = box.z - box.d / 2
    sample(box.w * box.d, (a, b) => [bx0 + a * box.w, floorY + box.h, bz0 + b * box.d])
    sample(box.w * box.h, (a, b) => [bx0 + a * box.w, floorY + b * box.h, bz0])
    sample(box.w * box.h, (a, b) => [bx0 + a * box.w, floorY + b * box.h, bz0 + box.d])
    sample(box.d * box.h, (a, b) => [bx0, floorY + b * box.h, bz0 + a * box.d])
    sample(box.d * box.h, (a, b) => [bx0 + box.w, floorY + b * box.h, bz0 + a * box.d])
  }
  return new Float32Array(points)
}

/** Several clouds as one: a walk through several rooms is the rooms' points together. */
export function concatClouds(...clouds: ArrayLike<number>[]): Float32Array {
  const out = new Float32Array(clouds.reduce((total, cloud) => total + cloud.length, 0))
  let at = 0
  for (const cloud of clouds) {
    out.set(cloud, at)
    at += cloud.length
  }
  return out
}

/**
 * A room whose plan repeats every `360 / points` degrees: a regular polygon of `points` sides, or, with
 * `innerRadius`, a star of `points` teeth (corners alternating between `radius` and `innerRadius`), the first
 * corner on +x. Floor and ceiling as {@link makeRoom}. A 12-toothed star fits itself at every 30 degrees and
 * pins the turn within a few degrees, the shape to build when a test needs a second fit that is sharp, inside
 * the search window and beyond the correction bound. (A plain 12-sided polygon is nearly round, and a round
 * room has no turn at all.)
 */
export function makePolygonRoom(spec: {
  points: number
  radius: number
  innerRadius?: number
  centre?: { x: number; z: number }
  height?: number
  noiseM?: number
  density?: number
  seed: number
}): Float32Array {
  const random = rng(spec.seed)
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random())
  const noise = spec.noiseM ?? 0
  const density = spec.density ?? 120
  const height = spec.height ?? 2.6
  const cx = spec.centre?.x ?? 0
  const cz = spec.centre?.z ?? 0
  const corners = spec.innerRadius === undefined ? spec.points : 2 * spec.points
  const points: number[] = []
  const add = (x: number, y: number, z: number): void => {
    points.push(x + noise * gauss(), y + noise * gauss(), z + noise * gauss())
  }
  const corner = (i: number): [number, number] => {
    const reach = spec.innerRadius !== undefined && i % 2 === 1 ? spec.innerRadius : spec.radius
    return [cx + reach * Math.cos((2 * Math.PI * i) / corners), cz + reach * Math.sin((2 * Math.PI * i) / corners)]
  }
  let area = 0
  for (let i = 0; i < corners; i++) {
    const [ax, az] = corner(i)
    const [bx, bz] = corner((i + 1) % corners)
    const count = Math.round(Math.hypot(bx - ax, bz - az) * height * density)
    for (let k = 0; k < count; k++) {
      const t = random()
      add(ax + t * (bx - ax), random() * height, az + t * (bz - az))
    }
    area += 0.5 * Math.abs((ax - cx) * (bz - cz) - (bx - cx) * (az - cz))
  }
  for (const y of [0, height]) {
    // Uniform over the plan: a triangle of the fan from the centre (all equal in area here), then a point in it.
    for (let k = 0; k < Math.round(area * density); k++) {
      const i = Math.floor(random() * corners)
      const [px, pz] = corner(i)
      const [qx, qz] = corner((i + 1) % corners)
      let u = random()
      let v = random()
      if (u + v > 1) {
        u = 1 - u
        v = 1 - v
      }
      add(cx + u * (px - cx) + v * (qx - cx), y, cz + u * (pz - cz) + v * (qz - cz))
    }
  }
  return new Float32Array(points)
}

/** A placement error: turn by `yawDeg` about +Y (right-hand rule) about the origin, then move by (dx, dy, dz). */
export interface Misplacement {
  yawDeg: number
  dx: number
  dz: number
  dy?: number
}

/** The column-major matrix of {@link Misplacement}, in the layout `composeYUpTransform` uses. */
export function misplacementMatrix(error: Misplacement): number[] {
  const yaw = (error.yawDeg * Math.PI) / 180
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, error.dx, error.dy ?? 0, error.dz, 1]
}

/** The points as a scan with this placement error would show them. */
export function misplace(points: ArrayLike<number>, error: Misplacement): Float32Array {
  const m = misplacementMatrix(error)
  const out = new Float32Array(points.length)
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]!
    const y = points[i + 1]!
    const z = points[i + 2]!
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
  }
  return out
}

/** The 4x4 product `a · b`, column-major. */
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[col * 4 + row]! += a[k * 4 + row]! * b[col * 4 + k]!
    }
  }
  return out
}

/**
 * How far `correction` leaves a scan from where it should be, given the error it
 * was misplaced by: `correction · error` should be the identity. Returns the
 * farthest any of `probes` ends up from its true place, in metres, and the
 * residual turn in degrees. This is the number the brief asks for: "recovered to
 * under 5 cm and 1 degree".
 */
export function recoveryError(
  correction: readonly number[],
  error: Misplacement,
  probes: ReadonlyArray<readonly [number, number, number]>,
): { positionM: number; yawDeg: number; heightM: number } {
  const total = multiply(correction, misplacementMatrix(error))
  let worst = 0
  for (const [x, y, z] of probes) {
    const px = total[0]! * x + total[4]! * y + total[8]! * z + total[12]!
    const pz = total[2]! * x + total[6]! * y + total[10]! * z + total[14]!
    worst = Math.max(worst, Math.hypot(px - x, pz - z))
  }
  return {
    positionM: worst,
    yawDeg: (Math.atan2(-total[2]!, total[0]!) * 180) / Math.PI,
    heightM: Math.abs(total[13]!),
  }
}

/** The four floor corners of a room, as probe points for {@link recoveryError}. */
export function corners(spec: Pick<RoomSpec, 'width' | 'depth' | 'centre'>): Array<[number, number, number]> {
  const cx = spec.centre?.x ?? 0
  const cz = spec.centre?.z ?? 0
  const hw = spec.width / 2
  const hd = spec.depth / 2
  return [
    [cx - hw, 0, cz - hd],
    [cx + hw, 0, cz - hd],
    [cx + hw, 0, cz + hd],
    [cx - hw, 0, cz + hd],
  ]
}
