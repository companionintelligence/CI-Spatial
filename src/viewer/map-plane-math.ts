/**
 * Pure maths for the 1:1 map plane (WP-13): Web-Mercator XYZ tiles, laid out in the scene.
 *
 * The plane itself (meshes, textures, requests: `src/viewer/map-plane.ts`) is not here. This is the part that can
 * be checked on its own, against numbers that do not come from it: which tile holds a point, where a tile's corners
 * are in the scene, how wide a tile is on the ground, which tiles a camera can see and how many of them to ask for.
 * No DOM, no three.js, no Deno API (ADR 0002): plain numbers in, plain numbers out.
 *
 * ## Tile addressing
 *
 * Standard XYZ: `2^z` tiles a side, tile `x` counted east from longitude -180, tile `y` counted south from the
 * Web-Mercator limit (latitude 85.0511287798, where the square ends). A tile is `MAP_TILE_PX` pixels a side.
 *
 * ## Two sizes for a tile, and which one places it
 *
 * The usual formula, `2 pi a cos(lat) / 2^z`, is the width of a tile on the sphere Web Mercator is defined on:
 * 47.6 m at z19 and 51.5 N, 63.7 m at 33.5 N ({@link tileWidthM}). On the WGS-84 ellipsoid the same tile is 47.68 m
 * east-west and 47.56 m north-south at 51.5 N, because the ellipsoid is not that sphere: 0.2 % wider one way, 0.05 %
 * narrower the other, and up to 0.7 % north-south at the equator. A tile is therefore never placed by its nominal
 * width. {@link tileCornersScene} puts each corner where the ellipsoid says it is, through the exact ENU in
 * `src/world/enu.ts`, and the nominal width is for choosing a zoom and for the resolution table only.
 *
 * ## The scene, and a frame that is not the scene
 *
 * `x` east, `y` up, `z` south, as `sceneFromEnu` defines it: right-handed, so a plane laid out here is never
 * mirrored. Its origin is the {@link MapPlaneFrame} origin, and each corner is taken at that origin's own height:
 * `y` is then only the fall of the Earth away from the origin's tangent plane (0.8 mm at 100 m, 20 mm at 500 m),
 * and the caller lowers the plane under the floor (WP-13 asks for -0.03 m plus the user's offset) on the group.
 * `zAxisBearingDeg` lays the same tiles out in a frame whose +Z axis has that true bearing (a Place frame), by the
 * convention `sceneYawForBearingDeg` already owns; left out, the frame is the scene.
 *
 * ## What a four-corner quad costs
 *
 * One quad per tile, its corners exact. Between the corners the quad is not the exact surface, and
 * {@link quadDeviation} measures by how much: horizontally 56 microns at z19 and 51.5 N and 3.6 mm at z16 (the
 * figures the WP-13 spec quotes, reproduced by tests/unit/node/map_plane_math.test.ts against a 70-digit reference,
 * and equal to `M (2 pi)^2 sin(lat) cos(lat) / (8 4^z)`, `M` the meridional radius of curvature, which is the
 * northing's own curvature across the tile). Vertically, the Earth's curvature across the tile gives 89 microns and
 * 5.7 mm (`W^2 / (4 R)`). A GPU draws the quad as two triangles, which add the quad's twist: 0.14 mm and 9.1 mm in
 * all three axes. All of it is far below the 3.5 m accuracy floor of a georeference set by a map click; none of it is
 * a reason to subdivide.
 *
 * ## Which tiles to ask for
 *
 * {@link selectVisibleTiles} answers with the tiles that cover the ground the camera can see inside a square window
 * about the origin, one zoom for all of them, nearest the camera first, and never more than
 * {@link MAP_PLANE_MAX_TILES}, none of them coarser than {@link MAP_PLANE_COARSEST_ZOOM}. A tile that no part of the
 * picture shows is not in the answer: the OSMF tile policy
 * (https://operations.osmfoundation.org/policies/tiles/, read 2026-11-17) counts fetching any tile other than those a
 * user is actively viewing as bulk downloading, so there is no ring of neighbours, no parent level and no tile for
 * the direction the camera might turn to. The part of the window the camera sees is an exact convex polygon, so a
 * tile that no part of it touches is out and one that does is in. "Touches" is exact geometry and not a pixel count:
 * a tile that shows a sliver of ground smaller than one screen pixel is asked for, at the price of one request, and
 * where the cap truncates the answer the sliver can take the place of a tile that shows more. A picture that reaches
 * past the north or south limit of the square asks for the tiles inside the limit and for none beyond it.
 *
 * ## The picture and the plane
 *
 * The plane is one-sided and faces up, which is what {@link visibleGroundPolygon} assumes: a camera at or below it
 * sees nothing of it, and so asks for nothing. {@link tileCornersScene} names the corners clockwise as seen from
 * above, so the index list of the front face a one-sided material draws is `(0, 2, 1)` and `(0, 3, 2)`; the list that
 * reads like the corners, `(0, 1, 2)` and `(0, 2, 3)`, faces down and is culled from above. A camera with a far plane
 * (the editor's is 800 m) draws nothing beyond it; pass it as `farM` and no tile that only lies beyond it is asked for.
 *
 * ## The depth buffer
 *
 * The plane sits 0.03 m under the floor, and a camera with a near plane of 0.01 m has depth steps of 60 mm at 100 m
 * ({@link depthStepM}), twice that. While the plane is visible the near plane is at least
 * {@link MAP_PLANE_MIN_NEAR_M}.
 */
import {
  enuFromScene,
  enuToGeodetic,
  geodeticToEnu,
  sceneFromEnu,
  sceneYawForBearingDeg,
  WGS84_A_M,
  type Geodetic,
} from '../world/enu.ts'
import type { RayCamera } from '../ar/ground-gate.ts'
import type { Vec3 } from '../world/types.ts'

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/**
 * Metres round the equator on the sphere Web Mercator (EPSG:3857) is drawn on: `2 pi` times the WGS-84
 * semi-major axis, 40 075 016.6856 m. A defining constant, not a measurement.
 */
export const WEB_MERCATOR_CIRCUMFERENCE_M = 2 * Math.PI * WGS84_A_M

/** Where the Web-Mercator square ends: `atan(sinh(pi))` in degrees, 85.0511287798066. A definition. */
export const WEB_MERCATOR_MAX_LATITUDE_DEG = Math.atan(Math.sinh(Math.PI)) * RAD_TO_DEG

/** Pixels along one side of a standard XYZ tile; a provider with 512 px tiles passes its own where one is taken. */
export const MAP_TILE_PX = 256

/** The deepest zoom these functions take: a bound on the arithmetic, not a provider's range, which is passed in. */
export const MAP_TILE_MAX_ZOOM = 30

/**
 * The most tiles one selection may ask for.
 *
 * Adopted, not measured (ADR 0005 rule 5). It is the spec's cap, and what it protects is the oldest phone's texture
 * memory: 64 tiles of 256 x 256 RGBA8 with a full mip chain are 64 x 341.3 KiB = 21.3 MiB (calculated, not measured
 * on a device; WP-13's device check measures the frame time and memory), provided the plane drops the textures of
 * tiles a selection no longer names. Revisit when that check names the oldest phone's limit.
 */
export const MAP_PLANE_MAX_TILES = 64

/**
 * The coarsest zoom a plane is made of, whatever the provider offers (z14).
 *
 * Adopted, not measured (ADR 0005 rule 5). A tile is one flat quad through four exact corners, and the quad's distance
 * from the ground it stands for grows with the square of the tile's width ({@link quadDeviation}): 57 mm east-west
 * and north-south at z14 and 51.5 N, 0.23 m at z13, metres and then kilometres above that, and at z1 and z0 four
 * corners are not a quad at all. z14 keeps every tile within centimetres of the exact surface, against a georeference
 * that is good to 3.5 m. Revisit when device experiment DX7 shows a map click that is better placed than that.
 */
export const MAP_PLANE_COARSEST_ZOOM = 14

/**
 * The most candidate tiles {@link selectVisibleTiles} will examine at one zoom before it calls that zoom too fine.
 *
 * Adopted, not measured (ADR 0005 rule 5). It bounds one selection to a few thousand corner conversions, so a radius
 * that is wrong for the provider's coarsest zoom costs milliseconds, not a frozen page: 7 ms for 3 600 candidates on
 * the development machine (a 1.4 km window at z20), which is not a phone. A zoom that needs more candidates than this
 * to be examined cannot have shown fewer than {@link MAP_PLANE_MAX_TILES} tiles except for a view so thin and so
 * slanted that no real camera makes it. Revisit if a selection ever reports `truncated` for a view that fits the cap,
 * or when the oldest phone's time for a selection is known.
 */
export const MAX_SCANNED_TILES_PER_ZOOM = 4096

/**
 * How far from 0 a frame's origin longitude may be, in degrees: a turn and a half either way, so a record written as
 * 190 or -190 is still the place it names.
 *
 * Adopted, not measured (ADR 0005 rule 5), and a bound on the arithmetic and not on the world. At the finest zoom the
 * tile column of such a longitude is under 2.7e9, far inside the 2^53 where a float counts whole numbers. Beyond that a
 * loop that steps a tile column by one stops moving and never ends; an origin a million turns round the Earth is a
 * corrupt record and not a place, and {@link selectVisibleTiles} answers it as one.
 */
export const MAX_ORIGIN_LONGITUDE_DEG = 540

/**
 * The nearest the camera's near plane may be, in metres, while the plane is visible.
 *
 * Adopted, not measured (ADR 0005 rule 5): the figure the WP-13 spec gives, from the depth-buffer arithmetic of
 * {@link depthStepM}, calculated and not measured on a device. The plane is drawn 0.03 m under the floor. With a near
 * plane of 0.01 m a 24-bit depth buffer cannot tell surfaces 60 mm apart at 100 m, so the plane fights the floor; at
 * 0.1 m it can tell 6 mm apart. Revisit when the oldest phone's depth buffer is known (a 16-bit one steps 256 times
 * further).
 */
export const MAP_PLANE_MIN_NEAR_M = 0.1

/**
 * Intervals along a side of the grid {@link quadDeviation} samples unless told otherwise: 16, a 17 by 17 grid, the one
 * the quoted figures were sampled on.
 *
 * Adopted, not measured (ADR 0005 rule 5). Away from the equator a grid of 2 intervals finds the same worst point as 16
 * does, the middle of the tile (the unit tests check four latitudes at z16 and z19). The finer grid is for the edges,
 * where the quad's own edges part from the curved ones, and which set the east-west figure near the equator, where it
 * is below a micron.
 */
export const QUAD_DEVIATION_STEPS = 16

/**
 * Overlap, in metres, that two ground polygons must exceed to count as touching (one micron).
 *
 * Adopted, not measured (ADR 0005 rule 5). It is a rounding guard, not a tolerance on the world: a tile whose edge
 * lies on the edge of the view, to within floating-point noise, is not on screen.
 */
const OVERLAP_EPS_M = 1e-6

/** The true bearing, in degrees, of the +Z axis of the scene `sceneFromEnu` builds: it points south. */
export const SCENE_Z_BEARING_DEG = 180

/** One XYZ tile. */
export interface TileId {
  z: number
  x: number
  y: number
}

/** A position on the ground plane of the frame, in metres. */
export interface GroundPoint {
  x: number
  z: number
}

/** The frame a plane is laid out in: where its origin is on Earth, and which way its +Z axis points. */
export interface MapPlaneFrame {
  /**
   * The frame's origin on the ellipsoid. `altitudeM` is the height the plane is drawn at, normally the Place's floor;
   * pass 0 where the georeference has no height, as `enu.ts` asks the caller to say it.
   */
  origin: Geodetic
  /**
   * True bearing, degrees clockwise from north, of the frame's +Z axis. Left out, the frame is the north-aligned
   * scene of `enu.ts` (x east, y up, z south), whose +Z axis has bearing {@link SCENE_Z_BEARING_DEG}.
   */
  zAxisBearingDeg?: number
}

/** The corners of a tile in a frame: north-west, north-east, south-east, south-west. */
export type TileCorners = readonly [Vec3, Vec3, Vec3, Vec3]

function isZoom(z: number): boolean {
  return Number.isInteger(z) && z >= 0 && z <= MAP_TILE_MAX_ZOOM
}

// ── Tile addressing ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a position falls on the tile grid at zoom `z`, as fractional tile coordinates: the integer parts are the
 * tile, the fractions the position inside it, `y` down from the north edge. Not wrapped, so a longitude outside
 * -180..180 gives an `x` outside `0..2^z`.
 *
 * Null for a position or zoom that is not a number, a zoom that is not a whole number from 0 to
 * {@link MAP_TILE_MAX_ZOOM}, and a latitude beyond {@link WEB_MERCATOR_MAX_LATITUDE_DEG}, where the projection has
 * no tile.
 */
export function latLngToTileFraction(lat: number, lng: number, z: number): { x: number; y: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isZoom(z)) return null
  if (Math.abs(lat) > WEB_MERCATOR_MAX_LATITUDE_DEG) return null
  const n = 2 ** z
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.asinh(Math.tan(lat * DEG_TO_RAD)) / Math.PI) / 2) * n,
  }
}

/**
 * The tile that holds a position. A longitude outside -180..180 wraps round the world; a latitude on the south
 * limit belongs to the last row. Null for the inputs {@link latLngToTileFraction} refuses.
 */
export function latLngToTile(lat: number, lng: number, z: number): TileId | null {
  const f = latLngToTileFraction(lat, lng, z)
  if (!f) return null
  const n = 2 ** z
  return { z, x: wrapTileX(Math.floor(f.x), n), y: Math.min(n - 1, Math.max(0, Math.floor(f.y))) }
}

function wrapTileX(x: number, n: number): number {
  return ((x % n) + n) % n
}

/**
 * The position of the grid point `(x, y)` at zoom `z`: the north-west corner of tile `(x, y)`, the south-east corner
 * of tile `(x - 1, y - 1)`. Fractions are allowed, so this is also the inverse of {@link latLngToTileFraction}.
 */
export function tilePointLatLng(z: number, x: number, y: number): { lat: number; lng: number } {
  const n = 2 ** z
  return {
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * RAD_TO_DEG,
    lng: (x / n) * 360 - 180,
  }
}

// ── Sizes ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The nominal ground width of a tile, in metres: `2 pi a cos(lat) / 2^z`, 47.6 m at z19 and 51.5 N, 63.7 m at 33.5 N.
 * The width on the sphere Web Mercator is defined on, to size and to choose zooms by. On the ellipsoid the tile is up
 * to 0.7 % off this, one way east-west and the other north-south (see the module note), so no tile is placed by it.
 */
export function tileWidthM(latDeg: number, z: number): number {
  return (WEB_MERCATOR_CIRCUMFERENCE_M * Math.cos(latDeg * DEG_TO_RAD)) / 2 ** z
}

/** Metres of ground per tile pixel, {@link tileWidthM} over the tile's pixels. */
export function groundResolutionM(latDeg: number, z: number, tilePx = MAP_TILE_PX): number {
  return tileWidthM(latDeg, z) / tilePx
}

// ── The depth buffer ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * How far apart in depth, in metres, two surfaces `distanceM` from the camera must be for a `bits`-bit depth buffer to
 * tell them apart: one step of the buffer there.
 *
 * A perspective camera stores `(1 / near - 1 / z) / (1 / near - 1 / far)` of the distance `z` along its axis, in
 * `bits` bits, so one step is `z^2 (1 / near - 1 / far) / 2^bits`: it grows with the square of the distance and falls
 * with the near plane. With 24 bits and a near plane of 0.01 m it is 60 mm at 100 m, 0.37 m at 250 m and 3.8 m at
 * 800 m (research note R4's figures), and a near plane of 0.1 m makes each a tenth of that. A fixed-point buffer is
 * assumed, as three.js uses by default; a logarithmic or reversed one has other steps. `farM` is the far plane; left
 * out it is infinite, the limit a far plane much further than the distance approaches.
 *
 * Not a number for anything that is not a camera range: a near plane that is not above 0, a far plane that is not
 * above it, a distance below 0, or a number of bits that is not a whole number from 1 to 32.
 */
export function depthStepM(nearM: number, distanceM: number, bits = 24, farM = Infinity): number {
  const usable = Number.isFinite(nearM) && nearM > 0 && farM > nearM && Number.isFinite(distanceM) && distanceM >= 0
    && Number.isInteger(bits) && bits >= 1 && bits <= 32
  return usable ? (distanceM * distanceM * (1 / nearM - 1 / farM)) / 2 ** bits : Number.NaN
}

// ── Tiles in a frame ─────────────────────────────────────────────────────────────────────────────────────────

function frameYawRad(frame: MapPlaneFrame): number {
  return sceneYawForBearingDeg(frame.zAxisBearingDeg ?? SCENE_Z_BEARING_DEG) * DEG_TO_RAD
}

/**
 * Where a position is in the frame, in metres: exact ENU from the frame's origin (taken at the origin's height),
 * then `sceneFromEnu`, then, if the frame has a bearing, the turn that puts its +Z axis at that bearing. Not a
 * number in, not a number out.
 */
export function latLngToScene(frame: MapPlaneFrame, lat: number, lng: number): Vec3 {
  const s = sceneFromEnu(geodeticToEnu(frame.origin, { lat, lng, altitudeM: frame.origin.altitudeM }))
  const t = frameYawRad(frame)
  const c = Math.cos(t)
  const sn = Math.sin(t)
  // Ry(-t): the scene back to the frame whose scene yaw is t.
  return { x: s.x * c - s.z * sn, y: s.y, z: s.x * sn + s.z * c }
}

/**
 * The inverse of {@link latLngToScene} for a point on the frame's ground plane, the origin's own height: the
 * latitude and longitude of the position `(x, z)` metres from the origin.
 */
export function sceneToLatLng(frame: MapPlaneFrame, x: number, z: number): { lat: number; lng: number } {
  const t = frameYawRad(frame)
  const c = Math.cos(t)
  const sn = Math.sin(t)
  // Ry(t): the frame to the scene.
  const g = enuToGeodetic(frame.origin, enuFromScene({ x: x * c + z * sn, y: 0, z: -x * sn + z * c }))
  return { lat: g.lat, lng: g.lng }
}

function gridPointScene(frame: MapPlaneFrame, z: number, gx: number, gy: number): Vec3 {
  const p = tilePointLatLng(z, gx, gy)
  return latLngToScene(frame, p.lat, p.lng)
}

/**
 * The four corners of a tile in a frame, each through exact ENU: north-west, north-east, south-east, south-west.
 * The quad they make is the plane's tile; see the module note for what it costs between the corners.
 *
 * The order is clockwise seen from above (+Y), the way the map is read. A one-sided material draws the face whose
 * indices run counter-clockwise, so the faces that point up are `(0, 2, 1)` and `(0, 3, 2)`; `(0, 1, 2)` and `(0, 2, 3)`
 * point down and are culled from above.
 */
export function tileCornersScene(tile: TileId, frame: MapPlaneFrame): TileCorners {
  const { z, x, y } = tile
  return [
    gridPointScene(frame, z, x, y),
    gridPointScene(frame, z, x + 1, y),
    gridPointScene(frame, z, x + 1, y + 1),
    gridPointScene(frame, z, x, y + 1),
  ]
}

/** How far a tile's quad is from the exact surface it stands for, in metres, worst over the samples. */
export interface QuadDeviation {
  /**
   * East-west and north-south only: the bilinear patch through the four exact corners against the exact positions
   * inside the tile. The figure the WP-13 spec quotes.
   */
  horizontalM: number
  /** Up only: the Earth's curvature across the tile, which a flat patch cannot follow. */
  verticalM: number
  /** All three axes, for the quad drawn as two triangles split along the north-west to south-east diagonal. */
  triangulatedM: number
}

/**
 * Measures {@link QuadDeviation} for a tile in a frame, on a `(steps + 1)` by `(steps + 1)` grid of positions
 * inside it (17 by 17 by default, the grid the quoted figures were sampled on). The exact position of a sample is
 * the inverse Mercator of its tile coordinates through exact ENU; the quad's is interpolated from the four exact
 * corners. The frame's bearing turns both alike, so only the origin matters.
 *
 * `steps` is a whole number of at least 2, and anything else is {@link QUAD_DEVIATION_STEPS}. A grid of the four
 * corners alone has no deviation by construction, which would read as a perfect quad, and a step count that is not a
 * whole number never reaches the far edge of the tile.
 */
export function quadDeviation(tile: TileId, frame: MapPlaneFrame, steps = QUAD_DEVIATION_STEPS): QuadDeviation {
  const { z, x, y } = tile
  const [nw, ne, se, sw] = tileCornersScene(tile, frame)
  const n = Number.isInteger(steps) && steps >= 2 ? steps : QUAD_DEVIATION_STEPS
  let horizontalM = 0
  let verticalM = 0
  let triangulatedM = 0
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const u = i / n
      const v = j / n
      const exact = gridPointScene(frame, z, x + u, y + v)
      const wNw = (1 - u) * (1 - v)
      const wNe = u * (1 - v)
      const wSe = u * v
      const wSw = (1 - u) * v
      const bilinear = {
        x: wNw * nw.x + wNe * ne.x + wSe * se.x + wSw * sw.x,
        y: wNw * nw.y + wNe * ne.y + wSe * se.y + wSw * sw.y,
        z: wNw * nw.z + wNe * ne.z + wSe * se.z + wSw * sw.z,
      }
      // Triangle (nw, ne, se) above the diagonal u = v, triangle (nw, se, sw) below it.
      const tri = u >= v
        ? {
            x: nw.x + u * (ne.x - nw.x) + v * (se.x - ne.x),
            y: nw.y + u * (ne.y - nw.y) + v * (se.y - ne.y),
            z: nw.z + u * (ne.z - nw.z) + v * (se.z - ne.z),
          }
        : {
            x: nw.x + v * (sw.x - nw.x) + u * (se.x - sw.x),
            y: nw.y + v * (sw.y - nw.y) + u * (se.y - sw.y),
            z: nw.z + v * (sw.z - nw.z) + u * (se.z - sw.z),
          }
      horizontalM = Math.max(horizontalM, Math.hypot(exact.x - bilinear.x, exact.z - bilinear.z))
      verticalM = Math.max(verticalM, Math.abs(exact.y - bilinear.y))
      triangulatedM = Math.max(triangulatedM, Math.hypot(exact.x - tri.x, exact.y - tri.y, exact.z - tri.z))
    }
  }
  return { horizontalM, verticalM, triangulatedM }
}

// ── What a camera can see ────────────────────────────────────────────────────────────────────────────────────

/** The rotation `floorRayPoint` (src/ar/ground-gate.ts) applies to a ray, which that module keeps to itself. */
function rotateByUnitQuat(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  // v' = v + w t + q x t, with t = 2 q x v, q the vector part.
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/**
 * Whether a camera is one: a pose of numbers whose rotation has a length (to a billionth), a vertical field of view
 * that is a lens, from 0 to 180 degrees exclusive, and a width over height above 0.
 */
function isCamera(camera: RayCamera): boolean {
  const { position: p, rotation: q, fovYDeg, aspect } = camera
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, fovYDeg, aspect].every(Number.isFinite)
    && fovYDeg > 0 && fovYDeg < 180 && aspect > 0 && Math.hypot(q.x, q.y, q.z, q.w) > 1e-9
}

/** Keeps the part of a convex polygon where `a x + b z + k >= 0` (Sutherland-Hodgman against one half-plane). */
function clipToHalfPlane(poly: readonly GroundPoint[], a: number, b: number, k: number): GroundPoint[] {
  const out: GroundPoint[] = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!
    const q = poly[(i + 1) % poly.length]!
    const vp = a * p.x + b * p.z + k
    const vq = a * q.x + b * q.z + k
    if (vp >= 0) out.push(p)
    if ((vp >= 0) !== (vq >= 0)) {
      const t = vp / (vp - vq)
      out.push({ x: p.x + t * (q.x - p.x), z: p.z + t * (q.z - p.z) })
    }
  }
  return out
}

/**
 * The ground the camera can see, inside a square window about the frame's origin: the polygon where the camera's
 * four side planes, cut by the plane `y = planeY`, meet the window `|x| <= halfSideM`, `|z| <= halfSideM`. Convex,
 * its vertices in cyclic order, and exact, not a bounding box.
 *
 * Empty when nothing of the plane is in view: a camera at or below the plane (the plane is one-sided and faces up,
 * so its underside shows nothing), a view that looks away from the window, or an input that is not a number or not
 * a camera. The plane is taken as flat: the Earth's fall away from it is 78 mm at 1 km.
 *
 * `farM` is the camera's far plane, in metres along its view direction: nothing beyond it is drawn, so the polygon
 * stops there. The editor's camera has one at 800 m (`src/viewer/viewer.ts`) and a capture camera at 1000 m
 * (`src/main.ts`). Left out, the view has no far limit, which overstates what such a camera shows once the window
 * reaches past it. The near plane is not modelled: both of those cameras have it at 0.01 m, so it clips only ground
 * within a centimetre of the lens.
 *
 * The camera is the one the AR providers publish and `main.ts` builds a capture camera from, which is also the
 * shape of the editor's: a pose, a vertical field of view in degrees and width over height, looking down -Z.
 */
export function visibleGroundPolygon(camera: RayCamera, planeY: number, halfSideM: number, farM?: number): GroundPoint[] {
  if (!isCamera(camera) || !Number.isFinite(planeY) || !Number.isFinite(halfSideM) || !(halfSideM > 0)) return []
  if (farM !== undefined && !(Number.isFinite(farM) && farM > 0)) return []
  const { position: p, rotation: q, fovYDeg, aspect } = camera
  if (!(p.y > planeY)) return []
  const norm = Math.hypot(q.x, q.y, q.z, q.w)
  const unit = { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm }

  const right = rotateByUnitQuat(unit, { x: 1, y: 0, z: 0 })
  const up = rotateByUnitQuat(unit, { x: 0, y: 1, z: 0 })
  const forward = rotateByUnitQuat(unit, { x: 0, y: 0, z: -1 })
  const tanY = Math.tan((fovYDeg * Math.PI) / 360)
  const tanX = aspect * tanY

  // A point is in view where |right . d| <= tanX (forward . d) and |up . d| <= tanY (forward . d), d the offset from
  // the camera. Together the four inequalities also put it in front of the camera. Each is a half-space with
  // normal n, and on the plane y = planeY a half-plane in (x, z).
  const sides: Vec3[] = [
    { x: tanX * forward.x + right.x, y: tanX * forward.y + right.y, z: tanX * forward.z + right.z },
    { x: tanX * forward.x - right.x, y: tanX * forward.y - right.y, z: tanX * forward.z - right.z },
    { x: tanY * forward.x + up.x, y: tanY * forward.y + up.y, z: tanY * forward.z + up.z },
    { x: tanY * forward.x - up.x, y: tanY * forward.y - up.y, z: tanY * forward.z - up.z },
  ]
  let poly: GroundPoint[] = [
    { x: -halfSideM, z: -halfSideM },
    { x: halfSideM, z: -halfSideM },
    { x: halfSideM, z: halfSideM },
    { x: -halfSideM, z: halfSideM },
  ]
  for (const n of sides) {
    poly = clipToHalfPlane(poly, n.x, n.z, n.y * (planeY - p.y) - n.x * p.x - n.z * p.z)
    if (poly.length < 3) return []
  }
  if (farM !== undefined) {
    // The far plane keeps the points whose depth along the view direction is at most farM: forward . d <= farM.
    poly = clipToHalfPlane(poly, -forward.x, -forward.z, farM - forward.y * (planeY - p.y) + forward.x * p.x + forward.z * p.z)
    if (poly.length < 3) return []
  }
  return poly
}

/** The smallest distance from `(px, pz)` to a convex polygon: 0 inside it. */
function distanceToPolygon(px: number, pz: number, poly: readonly GroundPoint[]): number {
  let positive = false
  let negative = false
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const ex = b.x - a.x
    const ez = b.z - a.z
    const cross = ex * (pz - a.z) - ez * (px - a.x)
    if (cross > 0) positive = true
    if (cross < 0) negative = true
    const len2 = ex * ex + ez * ez
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - a.x) * ex + (pz - a.z) * ez) / len2)) : 0
    best = Math.min(best, Math.hypot(px - (a.x + t * ex), pz - (a.z + t * ez)))
  }
  return positive && negative ? best : 0
}

/** Whether two convex polygons overlap by more than a rounding guard: the separating-axis test over their edges. */
function polygonsOverlap(a: readonly GroundPoint[], b: readonly GroundPoint[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!
      const q = poly[(i + 1) % poly.length]!
      const len = Math.hypot(q.x - p.x, q.z - p.z)
      if (!(len > 0)) continue
      const nx = (q.z - p.z) / len
      const nz = -(q.x - p.x) / len
      let minA = Infinity
      let maxA = -Infinity
      let minB = Infinity
      let maxB = -Infinity
      for (const v of a) {
        const d = v.x * nx + v.z * nz
        minA = Math.min(minA, d)
        maxA = Math.max(maxA, d)
      }
      for (const v of b) {
        const d = v.x * nx + v.z * nz
        minB = Math.min(minB, d)
        maxB = Math.max(maxB, d)
      }
      if (Math.min(maxA, maxB) - Math.max(minA, minB) <= OVERLAP_EPS_M) return false
    }
  }
  return true
}

/** What {@link zoomForCameraDistance} needs. */
export interface ZoomRequest {
  /** Camera to the ground it is showing, in metres. */
  distanceM: number
  latDeg: number
  /** The camera's vertical field of view, degrees. */
  fovYDeg: number
  /** The height of the picture in pixels; physical pixels for the sharpest plane, CSS pixels to spend less memory. */
  viewportHeightPx: number
  /** Pixels along a tile; {@link MAP_TILE_PX} when left out. */
  tilePx?: number
  /** The provider's coarsest zoom. */
  minZoom: number
  /** The provider's finest zoom. */
  maxZoom: number
}

/**
 * The zoom whose tile pixels are about as big on the screen as the screen's own at that distance: the ground a
 * screen pixel covers is `2 d tan(fovY / 2) / height`, and the zoom whose {@link groundResolutionM} equals it is
 * `log2(2 pi a cos(lat) / (tilePx x that))`, rounded to the nearest whole zoom (adopted, not measured: ADR 0005
 * rule 5; trilinear filtering of the mip chain hides a mismatch of a level either way) and held to the provider's
 * range. Twice the distance is one zoom coarser.
 *
 * `minZoom` for a request it cannot make sense of (no distance, a view of no height, a latitude beyond the
 * projection): the coarsest tiles are the cheapest wrong answer.
 */
export function zoomForCameraDistance(request: ZoomRequest): number {
  const { distanceM, latDeg, fovYDeg, viewportHeightPx, minZoom, maxZoom } = request
  const tilePx = request.tilePx ?? MAP_TILE_PX
  const usable = [distanceM, latDeg, fovYDeg, viewportHeightPx, tilePx].every(Number.isFinite)
    && distanceM > 0 && viewportHeightPx > 0 && tilePx > 0 && fovYDeg > 0 && fovYDeg < 180
    && Math.abs(latDeg) <= WEB_MERCATOR_MAX_LATITUDE_DEG
  if (!usable) return minZoom
  const metresPerScreenPx = (2 * distanceM * Math.tan(fovYDeg * DEG_TO_RAD / 2)) / viewportHeightPx
  const exact = Math.log2((WEB_MERCATOR_CIRCUMFERENCE_M * Math.cos(latDeg * DEG_TO_RAD)) / (tilePx * metresPerScreenPx))
  return Math.min(maxZoom, Math.max(minZoom, Math.round(exact)))
}

/** What {@link selectVisibleTiles} needs. */
export interface TileSelectionInput {
  frame: MapPlaneFrame
  /** The camera in the frame. */
  camera: RayCamera
  /** The height of the picture in pixels; see {@link ZoomRequest}. */
  viewportHeightPx: number
  /**
   * Half the side of the square window, in metres, about the frame's origin. Nothing beyond it is asked for, however
   * much of it the camera sees: the plane is a map of the Place and its surroundings, not of the horizon.
   */
  radiusM: number
  /** The provider's coarsest zoom; nothing coarser than {@link MAP_PLANE_COARSEST_ZOOM} is used whatever it is. */
  minZoom: number
  /** The provider's finest zoom. */
  maxZoom: number
  /** Pixels along a tile; {@link MAP_TILE_PX} when left out. */
  tilePx?: number
  /** Height of the plane in the frame, in metres; 0 when left out. The caller's floor offset goes here. */
  planeY?: number
  /**
   * Fewer tiles than {@link MAP_PLANE_MAX_TILES}, never more; at least 1, or the input is unusable. A number that is not
   * whole is rounded down.
   */
  maxTiles?: number
  /**
   * The camera's far plane, in metres along its view direction: no tile that lies only beyond it is asked for. The
   * editor's is 800 (`src/viewer/viewer.ts`). Left out, the view has no far limit. See {@link visibleGroundPolygon}.
   */
  farM?: number
}

/** Why a selection names no tile. */
export type EmptySelectionReason =
  /**
   * The camera sees none of the window: it looks away, at the sky, or from at or below the plane, or at ground that
   * lies wholly beyond the north or south limit of the Web-Mercator square, where there are no tiles.
   */
  | 'nothing-in-view'
  /** A number that is not one, a camera that is not a lens, a frame outside the projection, or a range of zooms that is not one. */
  | 'unusable-input'
  /** The provider has nothing as fine as {@link MAP_PLANE_COARSEST_ZOOM}, so no plane can be made of its tiles. */
  | 'zoom-range'
  /** The view is so wide for the coarsest zoom in use that its tiles could not be examined; `truncated` is true too. */
  | 'too-large'

/** The tiles to show. */
export interface TileSelection {
  /**
   * The zoom of every tile in `tiles`. When there are none: the coarsest zoom in use for a camera that sees none of the
   * window or a view too large to examine, and the provider's `minZoom` (the coarsest zoom if that is not a zoom) for an
   * input that cannot be used or a provider that cannot supply one.
   */
  zoom: number
  /** Nearest the camera first. */
  tiles: TileId[]
  /**
   * True when the view needed more tiles than the cap even at the coarsest zoom in use, and `tiles` is the nearest of
   * them; or when the window is so large for that zoom that none could be examined. The plane is partly bare.
   */
  truncated: boolean
  /**
   * Why `tiles` is empty: set exactly when it is, null when it is not. The four causes call for four different things
   * from a caller (draw nothing and wait, report a bug, disable the toggle, say the plane is partial), and the answer
   * for each is otherwise the same empty list.
   */
  emptyReason: EmptySelectionReason | null
}

interface Candidate {
  tile: TileId
  distanceM: number
}

/** What is wrong with the input, if anything: a value that cannot be used, or a provider too coarse to make a plane of. */
function inputProblem(
  input: TileSelectionInput,
  tilePx: number,
  planeY: number,
  maxTiles: number,
): 'unusable-input' | 'zoom-range' | null {
  const { frame, camera, viewportHeightPx, radiusM, minZoom, maxZoom, farM } = input
  const o = frame.origin
  const usable = isCamera(camera)
    && [o.lat, o.lng, o.altitudeM, viewportHeightPx, radiusM, tilePx, planeY, maxTiles, frameYawRad(frame)]
      .every(Number.isFinite)
    && Math.abs(o.lat) <= WEB_MERCATOR_MAX_LATITUDE_DEG
    && Math.abs(o.lng) <= MAX_ORIGIN_LONGITUDE_DEG
    && viewportHeightPx > 0 && radiusM > 0 && tilePx > 0 && maxTiles >= 1
    && (farM === undefined || (Number.isFinite(farM) && farM > 0))
    && isZoom(minZoom) && isZoom(maxZoom) && minZoom <= maxZoom
  if (!usable) return 'unusable-input'
  return maxZoom < MAP_PLANE_COARSEST_ZOOM ? 'zoom-range' : null
}

function noTiles(zoom: number, emptyReason: EmptySelectionReason, truncated = false): TileSelection {
  return { zoom, tiles: [], truncated, emptyReason }
}

/** The tiles of one zoom whose quad meets the polygon, or null when there are too many candidates to examine. */
function visibleAtZoom(
  z: number,
  polygon: readonly GroundPoint[],
  frame: MapPlaneFrame,
  camera: RayCamera,
): Candidate[] | null {
  const n = 2 ** z
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const v of polygon) {
    const ll = sceneToLatLng(frame, v.x, v.z)
    // Longitude carried on from the origin's, not folded into -180..180: a window across the antimeridian is then
    // one run of columns (some past the last, which are named by their wrapped column below) and not the whole world.
    const lng = frame.origin.lng + ((((ll.lng - frame.origin.lng + 180) % 360) + 360) % 360) - 180
    // A picture can reach past the north or south limit of the square, where there is no tile. The part of it inside the
    // limit still has tiles, so a vertex beyond it is taken to the limit: that is the edge of the square, and the rows
    // between it and the other vertices are examined as any others are.
    const lat = Math.max(-WEB_MERCATOR_MAX_LATITUDE_DEG, Math.min(WEB_MERCATOR_MAX_LATITUDE_DEG, ll.lat))
    const f = latLngToTileFraction(lat, lng, z)
    if (!f) return []
    minX = Math.min(minX, f.x)
    maxX = Math.max(maxX, f.x)
    minY = Math.min(minY, f.y)
    maxY = Math.max(maxY, f.y)
  }
  const x0 = Math.floor(minX)
  const x1 = Math.floor(maxX)
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(n - 1, Math.floor(maxY))
  if (y1 < y0) return []
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_SCANNED_TILES_PER_ZOOM) return null

  // A grid point is shared by up to four tiles: convert each once. `x` is not wrapped here: the position of a point
  // past the antimeridian is the same through ECEF, and only the tile's name needs the wrap.
  const points = new Map<string, Vec3>()
  const at = (gx: number, gy: number): Vec3 => {
    const key = `${gx}/${gy}`
    let point = points.get(key)
    if (!point) {
      point = gridPointScene(frame, z, gx, gy)
      points.set(key, point)
    }
    return point
  }
  const found: Candidate[] = []
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const corners = [at(gx, gy), at(gx + 1, gy), at(gx + 1, gy + 1), at(gx, gy + 1)]
      if (!polygonsOverlap(polygon, corners)) continue
      const tile = { z, x: wrapTileX(gx, n), y: gy }
      const cx = (corners[0]!.x + corners[2]!.x) / 2
      const cy = (corners[0]!.y + corners[2]!.y) / 2
      const cz = (corners[0]!.z + corners[2]!.z) / 2
      found.push({
        tile,
        distanceM: Math.hypot(cx - camera.position.x, cy - camera.position.y, cz - camera.position.z),
      })
    }
  }
  return found
}

function nearestFirst(found: Candidate[]): TileId[] {
  return found
    .sort((a, b) => a.distanceM - b.distanceM || a.tile.y - b.tile.y || a.tile.x - b.tile.x)
    .map((c) => c.tile)
}

/**
 * The tiles to show for a camera: those that cover the ground it can see inside the window, at the zoom its distance
 * to that ground asks for, coarsened until they fit the cap.
 *
 * In order: the view of the ground inside the window ({@link visibleGroundPolygon}); the zoom for the distance from
 * the camera to the nearest part of it ({@link zoomForCameraDistance}, the zoom that needs the sharpest tile); the
 * tiles of that zoom whose quads touch it; and if they are more than the cap, the same at the next coarser zoom,
 * down to the coarser of the provider's `minZoom` and {@link MAP_PLANE_COARSEST_ZOOM}, where the nearest are kept and
 * `truncated` says so. Every tile in the answer is one a part of the picture shows, so the caller asks the provider
 * for these and for nothing else.
 *
 * An empty answer says why in `emptyReason`: the camera sees none of the window, the input cannot be a camera, a frame
 * or a provider, the provider has nothing as fine as {@link MAP_PLANE_COARSEST_ZOOM}, or the view is too wide to
 * examine ({@link EmptySelectionReason}). The `zoom` of such an answer is told with each reason in {@link TileSelection}.
 *
 * Nothing here remembers the last answer. A caller that selects on every frame will see the zoom change each time the
 * camera crosses a rounding boundary of {@link zoomForCameraDistance}, and a request for each change: it chooses when
 * to ask, for instance when the camera has stopped moving.
 */
export function selectVisibleTiles(input: TileSelectionInput): TileSelection {
  const { frame, camera, viewportHeightPx, radiusM, minZoom, maxZoom, farM } = input
  const tilePx = input.tilePx ?? MAP_TILE_PX
  const planeY = input.planeY ?? 0
  const requested = input.maxTiles ?? MAP_PLANE_MAX_TILES
  const problem = inputProblem(input, tilePx, planeY, requested)
  if (problem) return noTiles(isZoom(minZoom) ? minZoom : MAP_PLANE_COARSEST_ZOOM, problem)
  const cap = Math.min(Math.floor(requested), MAP_PLANE_MAX_TILES)
  const coarsest = Math.max(minZoom, MAP_PLANE_COARSEST_ZOOM)

  const polygon = visibleGroundPolygon(camera, planeY, radiusM, farM)
  if (polygon.length < 3) return noTiles(coarsest, 'nothing-in-view')
  const distanceM = Math.hypot(
    distanceToPolygon(camera.position.x, camera.position.z, polygon),
    camera.position.y - planeY,
  )
  let z = zoomForCameraDistance({
    distanceM,
    latDeg: frame.origin.lat,
    fovYDeg: camera.fovYDeg,
    viewportHeightPx,
    tilePx,
    minZoom: coarsest,
    maxZoom,
  })
  for (;;) {
    const found = visibleAtZoom(z, polygon, frame, camera)
    if (found && found.length <= cap) {
      return found.length > 0
        ? { zoom: z, tiles: nearestFirst(found), truncated: false, emptyReason: null }
        : noTiles(z, 'nothing-in-view')
    }
    if (z <= coarsest) {
      if (!found) return noTiles(z, 'too-large', true)
      return { zoom: z, tiles: nearestFirst(found).slice(0, cap), truncated: true, emptyReason: null }
    }
    z--
  }
}
