/**
 * Exact WGS-84 geodetic ⇄ local ENU, and the right-handed scene frame built on
 * it.
 *
 * Nothing places a scan with this module yet. `geoToEnu` / `enuToGeo` in
 * ./geo.ts stay as they are for the legacy GPS placement. They are an
 * equirectangular approximation on a sphere of the WGS-84 equatorial radius,
 * which sits off the ellipsoid by up to about 0.7 %, depending on latitude and
 * direction: 0.67 m in 100 m going north on the equator, 0.30 m at San
 * Francisco, 13 m in 2 km (tests/unit/deno/enu.test.ts measures it). This
 * module is the conversion the georeference work builds on, kept apart so it can
 * be checked on its own against numbers that do not come from it.
 *
 * ADR 0001 note: this is a second earth model beside geo.ts's sphere, on
 * purpose — the sphere is wrong by metres at the scales a map overlay needs and
 * must not change under placements already stored. Once placement moves here,
 * `geoToEnu` can be retired, and the repo is back to one.
 *
 * ## The scene frame (proposed: x east, y up, z south)
 *
 * (east, up, north) — the frame `LocalFrame` has always declared — is a
 * **left-handed** set of axes: east × up points south. Every AR session is
 * right-handed, and `composeYUpTransform` is a pure rotation, so a session
 * placed in (east, up, north) by compass and GPS comes out mirrored east–west,
 * however good the compass and the GPS are: a feature 4 m from the session origin
 * can land 8 m from where it is (tests/unit/deno/world_registration.test.ts).
 * No rotation can fix a mirror.
 *
 * The right-handed choice is **x east, y up, z south**. Like three.js, WebXR
 * and the AR session frames it is right-handed with +Y up, and a camera
 * looking along −z faces north with east on its right. So a session whose +Z
 * has true bearing `B` is carried into it by a rotation alone: `Ry(180° − B)`
 * ({@link sceneYawForBearingDeg}). A Place frame whose +Z has bearing `β` goes
 * in the same way, after its own `sessionToProject`.
 *
 * Whether the scene becomes this one is an owner decision that has not been
 * made. Until it is, this module only provides the arithmetic: the worlds the
 * server writes still declare `z: 'north'` and keep their placement, and the
 * editor's compass follows whichever a world declares ({@link compassNeedleRad}).
 *
 * ## Heights
 *
 * `altitudeM` is height above the WGS-84 ellipsoid. A source that reports height
 * above mean sea level instead differs from it by tens of metres, but by nearly
 * the same amount at both ends of a short baseline, so ENU *differences* are
 * unaffected.
 *
 * Browser-safe on purpose (ADR 0002): no Deno or DOM references.
 */
import { normaliseBearingDeg } from './geo.ts'
import type { LocalFrame, Vec3 } from './types.ts'

/** WGS-84 semi-major axis, metres. A defining constant of the ellipsoid, not a measurement. */
export const WGS84_A_M = 6_378_137
/** WGS-84 flattening. A defining constant of the ellipsoid: 1 / 298.257223563. */
export const WGS84_F = 1 / 298.257223563
/** First eccentricity squared, `f(2 − f)`. */
const WGS84_E2 = WGS84_F * (2 - WGS84_F)

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/**
 * A position on the ellipsoid: degrees, and metres above it. Every field is
 * required here: unlike `GeoPose`, a null height is not quietly read as 0, so
 * the caller's choice is visible where it is made. A `GeoPose` narrowed by
 * `hasGeoPose()` fits once `altitudeM` is given a number.
 */
export interface Geodetic {
  lat: number
  lng: number
  altitudeM: number
}

/**
 * Local east / north / up offsets in metres, from an origin. Named axes, not a
 * `Vec3`: whether `z` is north or south is exactly what went wrong, so the names
 * are the point. {@link sceneFromEnu} is the only way across to scene axes.
 */
export interface Enu {
  east: number
  north: number
  up: number
}

/** Earth-centred, earth-fixed coordinates, metres, as a plain `Vec3` (x towards 0°N 0°E, z towards the pole). */
export function geodeticToEcef(g: Geodetic): Vec3 {
  const lat = g.lat * DEG_TO_RAD
  const lng = g.lng * DEG_TO_RAD
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  // Radius of curvature in the prime vertical.
  const n = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  return {
    x: (n + g.altitudeM) * cosLat * Math.cos(lng),
    y: (n + g.altitudeM) * cosLat * Math.sin(lng),
    z: (n * (1 - WGS84_E2) + g.altitudeM) * sinLat,
  }
}

/**
 * The inverse of {@link geodeticToEcef}, to double precision.
 *
 * Fixed-point iteration on the latitude, with the height read from a form that
 * stays stable at the poles. It stops when a step moves the latitude by less
 * than 1e-15 rad (about 6 nm on the ground), or after 12 steps. Both limits are
 * adopted, not measured (ADR 0005 rule 5). What was measured: over 20 000
 * random points at any latitude and heights from -500 m to 19.5 km it stopped
 * within 6 steps, and the round-trip test in tests/unit/deno/enu.test.ts
 * measures the result to about 5 nm (worst of 2000 random origins) and holds it
 * under 20 nm.
 */
export function ecefToGeodetic(p: Vec3): Geodetic {
  const lng = Math.atan2(p.y, p.x)
  const rho = Math.hypot(p.x, p.y)
  let lat = Math.atan2(p.z, rho * (1 - WGS84_E2))
  for (let i = 0; i < 12; i++) {
    const sinLat = Math.sin(lat)
    const n = WGS84_A_M / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
    const next = Math.atan2(p.z + WGS84_E2 * n * sinLat, rho)
    const done = Math.abs(next - lat) < 1e-15
    lat = next
    if (done) break
  }
  const sinLat = Math.sin(lat)
  const altitudeM = rho * Math.cos(lat) + p.z * sinLat - WGS84_A_M * Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  return { lat: lat * RAD_TO_DEG, lng: lng * RAD_TO_DEG, altitudeM }
}

/** The east, north and up unit vectors at an origin, in ECEF axes. */
function enuBasis(origin: Geodetic) {
  const lat = origin.lat * DEG_TO_RAD
  const lng = origin.lng * DEG_TO_RAD
  const sinLat = Math.sin(lat)
  const cosLat = Math.cos(lat)
  const sinLng = Math.sin(lng)
  const cosLng = Math.cos(lng)
  return {
    east: { x: -sinLng, y: cosLng, z: 0 },
    north: { x: -sinLat * cosLng, y: -sinLat * sinLng, z: cosLat },
    up: { x: cosLat * cosLng, y: cosLat * sinLng, z: sinLat },
  }
}

/** Where `point` is, in metres east, north and up of `origin`. Exact on the ellipsoid. */
export function geodeticToEnu(origin: Geodetic, point: Geodetic): Enu {
  const o = geodeticToEcef(origin)
  const p = geodeticToEcef(point)
  const dx = p.x - o.x
  const dy = p.y - o.y
  const dz = p.z - o.z
  const b = enuBasis(origin)
  return {
    east: b.east.x * dx + b.east.y * dy + b.east.z * dz,
    north: b.north.x * dx + b.north.y * dy + b.north.z * dz,
    up: b.up.x * dx + b.up.y * dy + b.up.z * dz,
  }
}

/** The inverse of {@link geodeticToEnu}: the position `enu` metres from `origin`. */
export function enuToGeodetic(origin: Geodetic, enu: Enu): Geodetic {
  const o = geodeticToEcef(origin)
  const b = enuBasis(origin)
  return ecefToGeodetic({
    x: o.x + b.east.x * enu.east + b.north.x * enu.north + b.up.x * enu.up,
    y: o.y + b.east.y * enu.east + b.north.y * enu.north + b.up.y * enu.up,
    z: o.z + b.east.z * enu.east + b.north.z * enu.north + b.up.z * enu.up,
  })
}

/**
 * Local ENU into the right-handed scene: `x` east, `y` up, `z` **south**.
 *
 * The one place `north` changes sign. `0 -` rather than a bare minus so a zero
 * stays a zero and not `-0`.
 */
export function sceneFromEnu(enu: Enu): Vec3 {
  return { x: enu.east, y: enu.up, z: 0 - enu.north }
}

/** The inverse of {@link sceneFromEnu}. */
export function enuFromScene(v: Vec3): Enu {
  return { east: v.x, north: 0 - v.z, up: v.y }
}

/**
 * The yaw, in degrees, that carries a right-handed frame whose **+Z has true
 * bearing `bearingDeg`** into the scene: hand it to `composeYUpTransform` (a
 * rotation about +Y), after the frame's own `sessionToProject` where there is
 * one.
 *
 * `Ry(θ)` takes +Z to scene `(sin θ, 0, cos θ)`. A direction at bearing `B` is
 * `(sin B, 0, −cos B)` in the scene (east `sin B`, north `cos B`, `z` = −north),
 * so `sin θ = sin B` and `cos θ = −cos B`: `θ = 180° − B`. The frame's +X, which
 * a right-handed frame fixes as +Y × +Z, lands where the physical east–west of
 * the room says it should — a mirror cannot do that, which is why the scene
 * is this one and not (east, up, north).
 */
export function sceneYawForBearingDeg(bearingDeg: number): number {
  return normaliseBearingDeg(180 - bearingDeg)
}

/**
 * The editor compass needle's rotation, in radians clockwise on screen, for a
 * camera looking along `direction` (only its horizontal part is read).
 *
 * The needle points where the scene's **north axis** lies on screen. Screen
 * right for a camera heading `(dx, dz)` is `(−dz, dx)`, and north is `+z` or
 * `−z`, so with `s = +1 | −1` the needle angle from the heading is
 * `atan2(s·dx, s·dz)`.
 *
 *  - A world that declares `z: 'south'` (the right-handed scene above) has north
 *    at `−z`: `s = −1`, and the needle is the usual compass needle.
 *  - Anything else — every world file written so far declares `'north'`, and an
 *    older one may declare nothing — keeps its label, north at `+z`.
 *
 * The earlier dial turned by `−atan2(dx, dz)` with north at `+z`. A camera
 * looking along +x sees +z on its *right*, and that dial pointed left: it
 * mirrored the axis it called north. The needle now follows the scene it sits on.
 */
export function compassNeedleRad(
  direction: { x: number; z: number },
  zAxis?: LocalFrame['axes']['z'] | null,
): number {
  const s = zAxis === 'south' ? -1 : 1
  return Math.atan2(s * direction.x, s * direction.z)
}
