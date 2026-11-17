/**
 * WP-13, the pure maths: Web-Mercator tiles laid out in the scene, which tiles a camera can see, and how far a
 * four-corner quad is from the surface it stands for (src/viewer/map-plane-math.ts).
 *
 * A module that used the wrong inverse for the Mercator y, or put the corners on the sphere and not the ellipsoid,
 * would still agree with itself, so every check that carries weight compares against numbers it did not produce:
 *
 *   1. Tables from tests/unit/node/map_plane_reference.py: 70-digit `decimal` arithmetic from the definitions.
 *      The inverse Mercator is Newton's method on the forward form (the module uses atan(sinh(.))), the ENU is the
 *      textbook closed form on the WGS-84 ellipsoid, and no float result reaches a table (the one float is the
 *      starting guess of the Newton iteration, which is run on to 60 digits). The script's own asserts
 *      tie them to what research note R4 section 3 printed from its float64 script (the golden tile vectors, the
 *      47.6 m and 63.7 m widths, the corner offsets of the z19 tile and the 56 micron deviation), so a table that
 *      drifted from the research stops there. Run `python3 -I -B tests/unit/node/map_plane_reference.py` to
 *      regenerate them. ("R4" in this file is the maps research of the alignment investigation behind WP-13; the
 *      numbers it printed are quoted where they are used, so nothing here needs the note to run.)
 *   2. Closed forms: the quad's deviation follows `M (2 pi)^2 sin(lat) cos(lat) / (8 4^z)` east-west and
 *      north-south and `W^2 / (4 R)` up, M the meridional radius of curvature; the fall of the Earth away from the
 *      origin's tangent plane is `d^2 / (2 R)`; a frame of bearing `b` sends a point at bearing `b` to its +Z axis.
 *   3. For the tiles a camera sees, an oracle that shares no code with the module's footprint, overlap test or
 *      zoom: three.js's own frustum planes for the camera (its far plane included), each tile's corners clipped
 *      against them and against the window, and the area left. The corners it clips are the module's own, which the
 *      tables in 1 check. The same planes give the nearest ground the camera shows, by `Triangle.closestPointToPoint`,
 *      which is the distance the zoom is asked for by; the tile centres the order is checked against are worked from
 *      the tile's own centre coordinates and not from its corners. Six hundred seeded random cameras, frames, windows,
 *      plane heights, far planes and providers are held to all of it.
 *   4. For the depth buffer, a fixed-point buffer built on three.js's own projection matrix, whose steps are found by
 *      bisection and not by the formula the module uses.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/map_plane_math.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as THREE from 'three'
import {
  MAP_PLANE_COARSEST_ZOOM,
  MAP_PLANE_MAX_TILES,
  MAP_PLANE_MIN_NEAR_M,
  MAP_TILE_MAX_ZOOM,
  MAP_TILE_PX,
  MAX_ORIGIN_LONGITUDE_DEG,
  MAX_SCANNED_TILES_PER_ZOOM,
  QUAD_DEVIATION_STEPS,
  SCENE_Z_BEARING_DEG,
  WEB_MERCATOR_CIRCUMFERENCE_M,
  WEB_MERCATOR_MAX_LATITUDE_DEG,
  depthStepM,
  groundResolutionM,
  latLngToScene,
  latLngToTile,
  latLngToTileFraction,
  quadDeviation,
  sceneToLatLng,
  selectVisibleTiles,
  tileCornersScene,
  tilePointLatLng,
  tileWidthM,
  visibleGroundPolygon,
  zoomForCameraDistance,
  type MapPlaneFrame,
  type TileId,
} from '../../../src/viewer/map-plane-math.ts'
import { enuToGeodetic, WGS84_A_M, WGS84_F } from '../../../src/world/enu.ts'
import type { RayCamera } from '../../../src/ar/ground-gate.ts'
import type { Vec3 } from '../../../src/world/types.ts'

// ─── The 70-digit reference tables (tests/unit/node/map_plane_reference.py) ─────────────────────────────

/** [name, lat, lng, z, tileX, tileY, fracX, fracY, nwLat, nwLng, seLat, seLng] */
type TileRow = [string, number, number, number, number, number, number, number, number, number, number, number]
/** [lat, z, widthM] */
type WidthRow = [number, number, number]
/** [z, tileX, tileY, originLat, originLng, originAlt, [east, north, up] x NW, NE, SE, SW] */
type CornerRow = [number, number, number, number, number, number, number[], number[], number[], number[]]
/** [z, tileX, tileY, originLat, originLng, originAlt, horizontalM, verticalM, triangulatedM] */
type DeviationRow = [number, number, number, number, number, number, number, number, number]

const TILE_REFERENCE: TileRow[] = [
  ['london', 51.5, -0.1, 0, 0, 0, 4.997222222222222e-1, 3.325585454931201e-1, 8.505112877980659e+1, -1.800000000000000e+2, -8.505112877980659e+1, 1.800000000000000e+2],
  ['london', 51.5, -0.1, 1, 0, 0, 9.994444444444444e-1, 6.651170909862403e-1, 8.505112877980659e+1, -1.800000000000000e+2, 0, 0],
  ['london', 51.5, -0.1, 15, 16374, 10897, 8.977777777777778e-1, 2.784187185610083e-1, 5.150190410761812e+1, -1.098632812500000e-1, 5.149506473014369e+1, -9.887695312500000e-2],
  ['london', 51.5, -0.1, 16, 32749, 21794, 7.955555555555556e-1, 5.568374371220165e-1, 5.150190410761812e+1, -1.043701171875000e-1, 5.149848454717059e+1, -9.887695312500000e-2],
  ['london', 51.5, -0.1, 19, 261998, 174356, 3.644444444444444e-1, 4.546994969761321e-1, 5.150019435946634e+1, -1.002502441406250e-1, 5.149976691240593e+1, -9.956359863281250e-2],
  ['los_angeles', 33.5, -117.0, 0, 0, 0, 1.750000000000000e-1, 4.011389003645388e-1, 8.505112877980659e+1, -1.800000000000000e+2, -8.505112877980659e+1, 1.800000000000000e+2],
  ['los_angeles', 33.5, -117.0, 1, 0, 0, 3.500000000000000e-1, 8.022778007290775e-1, 8.505112877980659e+1, -1.800000000000000e+2, 0, 0],
  ['los_angeles', 33.5, -117.0, 15, 5734, 13144, 4.000000000000000e-1, 5.194871452059746e-1, 3.350475906922608e+1, -1.170043945312500e+2, 3.349559774486570e+1, -1.169934082031250e+2],
  ['los_angeles', 33.5, -117.0, 16, 11468, 26289, 8.000000000000000e-1, 3.897429041194918e-2, 3.350017852824229e+1, -1.170043945312500e+2, 3.349559774486570e+1, -1.169989013671875e+2],
  ['los_angeles', 33.5, -117.0, 19, 91750, 210312, 4.000000000000000e-1, 3.117943232955934e-1, 3.350017852824229e+1, -1.170002746582031e+2, 3.349960594357574e+1, -1.169995880126953e+2],
  ['tromso', 60, 10, 0, 0, 0, 5.277777777777778e-1, 2.903996408605086e-1, 8.505112877980659e+1, -1.800000000000000e+2, -8.505112877980659e+1, 1.800000000000000e+2],
  ['tromso', 60, 10, 1, 1, 0, 5.555555555555556e-2, 5.807992817210173e-1, 8.505112877980659e+1, 0, 0, 1.800000000000000e+2],
  ['tromso', 60, 10, 15, 17294, 9515, 2.222222222222222e-1, 8.154317171468967e-1, 6.000447899694396e+1, 9.997558593750000e+0, 5.999898612060444e+1, 1.000854492187500e+1],
  ['tromso', 60, 10, 16, 34588, 19031, 4.444444444444444e-1, 6.308634342937934e-1, 6.000173267279340e+1, 9.997558593750000e+0, 5.999898612060444e+1, 1.000305175781250e+1],
  ['tromso', 60, 10, 19, 276707, 152253, 5.555555555555556e-1, 4.690747435034710e-2, 6.000001610439935e+1, 9.999618530273438e+0, 5.999967278003097e+1, 1.000030517578125e+1],
  ['equator', 0, 0, 0, 0, 0, 5.000000000000000e-1, 5.000000000000000e-1, 8.505112877980659e+1, -1.800000000000000e+2, -8.505112877980659e+1, 1.800000000000000e+2],
  ['equator', 0, 0, 1, 1, 1, 0, 0, 0, 0, -8.505112877980659e+1, 1.800000000000000e+2],
  ['equator', 0, 0, 15, 16384, 16384, 0, 0, 0, 0, -1.098632805767735e-2, 1.098632812500000e-2],
  ['equator', 0, 0, 16, 32768, 32768, 0, 0, 0, 0, -5.493164054084669e-3, 5.493164062500000e-3],
  ['equator', 0, 0, 19, 262144, 262144, 0, 0, 0, 0, -6.866455077960638e-4, 6.866455078125000e-4],
  ['greenwich', 51.4769, -0.0005, 0, 0, 0, 4.999986111111111e-1, 3.326615959412666e-1, 8.505112877980659e+1, -1.800000000000000e+2, -8.505112877980659e+1, 1.800000000000000e+2],
  ['greenwich', 51.4769, -0.0005, 1, 0, 0, 9.999972222222222e-1, 6.653231918825331e-1, 8.505112877980659e+1, -1.800000000000000e+2, 0, 0],
  ['greenwich', 51.4769, -0.0005, 15, 16383, 10900, 9.544888888888889e-1, 6.551758034229341e-1, 5.148138289610098e+1, -1.098632812500000e-2, 5.147454043941974e+1, 0],
  ['greenwich', 51.4769, -0.0005, 16, 32767, 21801, 9.089777777777778e-1, 3.103516068458683e-1, 5.147796179607123e+1, -5.493164062500000e-3, 5.147454043941974e+1, 0],
  ['greenwich', 51.4769, -0.0005, 19, 262143, 174410, 2.718222222222222e-1, 4.828128547669462e-1, 5.147710648096692e+1, -6.866455078125000e-4, 5.147667881740016e+1, 0],
  ['sydney', -33.8688, 151.2093, 0, 0, 0, 9.200258333333333e-1, 6.000922514587762e-1, 8.505112877980659e+1, -1.800000000000000e+2, -8.505112877980659e+1, 1.800000000000000e+2],
  ['sydney', -33.8688, 151.2093, 1, 1, 1, 8.400516666666667e-1, 2.001845029175523e-1, 0, 0, -8.505112877980659e+1, 1.800000000000000e+2],
  ['sydney', -33.8688, 151.2093, 15, 30147, 19663, 4.065066666666667e-1, 8.228958011773143e-1, -3.386129311351552e+1, 1.512048339843750e+2, -3.387041555094183e+1, 1.512158203125000e+2],
  ['sydney', -33.8688, 151.2093, 16, 60294, 39327, 8.130133333333333e-1, 6.457916023546285e-1, -3.386585445407185e+1, 1.512048339843750e+2, -3.387041555094183e+1, 1.512103271484375e+2],
  ['sydney', -33.8688, 151.2093, 19, 482358, 314621, 5.041066666666667e-1, 1.663328188370282e-1, -3.386870516817359e+1, 1.512089538574219e+2, -3.386927529957080e+1, 1.512096405029297e+2],
]

const WIDTH_REFERENCE: WidthRow[] = [
  [0, 15, 1.222992452562820e+3],
  [0, 16, 6.114962262814100e+2],
  [0, 17, 3.057481131407050e+2],
  [0, 18, 1.528740565703525e+2],
  [0, 19, 7.643702828517625e+1],
  [0, 20, 3.821851414258813e+1],
  [0, 21, 1.910925707129406e+1],
  [33.5, 15, 1.019836066687289e+3],
  [33.5, 16, 5.099180333436447e+2],
  [33.5, 17, 2.549590166718223e+2],
  [33.5, 18, 1.274795083359112e+2],
  [33.5, 19, 6.373975416795558e+1],
  [33.5, 20, 3.186987708397779e+1],
  [33.5, 21, 1.593493854198890e+1],
  [51.5, 15, 7.613307022176951e+2],
  [51.5, 16, 3.806653511088475e+2],
  [51.5, 17, 1.903326755544238e+2],
  [51.5, 18, 9.516633777721188e+1],
  [51.5, 19, 4.758316888860594e+1],
  [51.5, 20, 2.379158444430297e+1],
  [51.5, 21, 1.189579222215149e+1],
  [60, 15, 6.114962262814100e+2],
  [60, 16, 3.057481131407050e+2],
  [60, 17, 1.528740565703525e+2],
  [60, 18, 7.643702828517625e+1],
  [60, 19, 3.821851414258813e+1],
  [60, 20, 1.910925707129406e+1],
  [60, 21, 9.554628535647031e+0],
  [-33.8688, 15, 1.015470052113299e+3],
  [-33.8688, 16, 5.077350260566495e+2],
  [-33.8688, 17, 2.538675130283248e+2],
  [-33.8688, 18, 1.269337565141624e+2],
  [-33.8688, 19, 6.346687825708119e+1],
  [-33.8688, 20, 3.173343912854060e+1],
  [-33.8688, 21, 1.586671956427030e+1],
]

// Exact tile corners, ENU metres at the origin height.
const CORNER_REFERENCE: CornerRow[] = [
  [19, 261998, 174356, 51.5001, -0.1000, 35, [-1.737710365829146e+1, 1.049831741297248e+1, -3.226784987116149e-5], [3.030397345267747e+1, 1.049837803330336e+1, -8.048726558696643e-5], [3.030425693307987e+1, -3.705871685886310e+1, -1.795634373757017e-4], [-1.737726621348724e+1, -3.705877747976105e+1, -1.313435705883767e-4]],
  [19, 261998, 174356, 51.50019, -0.09993, 0, [-2.223782398690949e+1, 4.850734335692013e-1, -3.870576880367184e-5], [2.544299201279261e+1, 4.850884641676455e-1, -5.066156527520933e-5], [2.544323002083871e+1, -4.707174531548346e+1, -2.244390945940821e-4], [-2.223803201201259e+1, -4.707176034622251e+1, -2.124831862813053e-4]],
  [16, 32749, 21794, 51.5, -0.1, 10, [-3.034510240767563e+2, 2.118563122649470e+2, -1.072423622967902e-2], [7.798182748699043e+1, 2.118478536057030e+2, -3.995914860146195e-3], [7.798766358226552e+1, -1.686056432035196e+2, -2.705583166078399e-3], [-3.034737340996540e+2, -1.685971839112365e+2, -9.434408077600676e-3]],
  [19, 482358, 314621, -33.8688, 151.2093, 58, [-3.202771436274876e+1, 1.051878993622556e+1, -8.903388955601056e-5], [3.150589167846979e+1, 1.051879167878073e+1, -8.643764109228889e-5], [3.150568223208736e+1, -5.272077251293587e+1, -2.964055993786347e-4], [-3.202750144736837e+1, -5.272077425547946e+1, -2.990018305828909e-4]],
]

// Quad deviation against the exact positions inside the tile, worst of a 17 x 17 grid, metres.
const DEVIATION_REFERENCE: DeviationRow[] = [
  [19, 261998, 174356, 5.149998063593614e+1, -9.990692138671875e-2, 0, 5.590001944106978e-5, 8.881358520729468e-5, 1.425562660385630e-4],  // closed form: horizontal 5.575414e-5, vertical 8.874691e-5
  [16, 32749, 21794, 5.150019432739436e+1, -1.016235351562500e-1, 0, 3.577712257824212e-3, 5.684016283028684e-3, 9.123558484353216e-3],  // closed form: horizontal 3.568259e-3, vertical 5.679749e-3
  [19, 261998, 174356, 5.150130000000000e+1, -9.810000000000000e-2, 3.500000000000000e+1, 5.590134947561782e-5, 8.881405877862100e-5, 1.425570483397828e-4],  // closed form: horizontal 5.575414e-5, vertical 8.874691e-5
  [13, 4375, 4095, 2.197265409567562e-2, 1.228271484375000e+1, 0, 2.565939866117653e-4, 9.348835154471364e-1, 9.348835837444163e-1],  // closed form: horizontal 1.786596e-4, vertical 9.380233e-1
]


// ─── Helpers ───────────────────────────────────────────────────────────────

const DEG = Math.PI / 180

function near(actual: number, expected: number, tolerance: number, what = ''): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} is not ${expected} (within ${tolerance})`)
}

/** mulberry32: a seeded generator, so every number below is the same on every run. */
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

const LONDON: MapPlaneFrame = { origin: { lat: 51.5, lng: -0.1, altitudeM: 35 } }
const SYDNEY: MapPlaneFrame = { origin: { lat: -33.8688, lng: 151.2093, altitudeM: 58 } }

/** A camera as the AR providers publish one: pitch negative looks down, yaw positive turns left, degrees. */
function cameraAt(position: Vec3, pitchDeg: number, yawDeg: number, fovYDeg = 50, aspect = 0.5, rollDeg = 0): RayCamera {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, 'YXZ'))
  return { position, rotation: { x: q.x, y: q.y, z: q.z, w: q.w }, fovYDeg, aspect }
}

function looksDown(position: Vec3, fovYDeg = 50, aspect = 0.5): RayCamera {
  return cameraAt(position, -90, 0, fovYDeg, aspect)
}

function threeCamera(camera: RayCamera, far = 1e6): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(camera.fovYDeg, camera.aspect, 0.001, far)
  c.position.set(camera.position.x, camera.position.y, camera.position.z)
  c.quaternion.set(camera.rotation.x, camera.rotation.y, camera.rotation.z, camera.rotation.w)
  c.updateMatrixWorld(true)
  return c
}

/** Where a point is in the camera's normalised device coordinates, by three.js, whether it is in front of it, and how far along its view direction. */
function ndcOf(camera: RayCamera, p: Vec3): { x: number; y: number; ahead: boolean; depth: number } {
  const c = threeCamera(camera)
  const world = new THREE.Vector3(p.x, p.y, p.z)
  const viewZ = world.clone().applyMatrix4(c.matrixWorldInverse).z
  const ndc = world.project(c)
  return { x: ndc.x, y: ndc.y, ahead: viewZ < 0, depth: -viewZ }
}

// ─── The oracle for which tiles a camera sees ─────────────────────────────

function clipByPlane(poly: THREE.Vector3[], plane: THREE.Plane): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const da = plane.distanceToPoint(a)
    const db = plane.distanceToPoint(b)
    if (da >= 0) out.push(a)
    if ((da >= 0) !== (db >= 0)) out.push(a.clone().lerp(b, da / (da - db)))
  }
  return out
}

function polygonArea(poly: THREE.Vector3[]): number {
  const sum = new THREE.Vector3()
  for (let i = 0; i < poly.length; i++) sum.add(new THREE.Vector3().crossVectors(poly[i]!, poly[(i + 1) % poly.length]!))
  return sum.length() / 2
}

/**
 * The planes that bound what the camera shows of the window: three.js's own frustum planes for the camera, its far
 * plane included when it has one, and the window's four sides.
 */
function viewPlanes(camera: RayCamera, halfSideM: number, far?: number): THREE.Plane[] {
  const c = threeCamera(camera, far)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse))
  return [
    ...frustum.planes,
    new THREE.Plane(new THREE.Vector3(1, 0, 0), halfSideM),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), halfSideM),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), halfSideM),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), halfSideM),
  ]
}

/** The area, in square metres, of the part of a polygon that lies inside every plane: its corners clipped by each. */
function areaWithin(planes: readonly THREE.Plane[], corners: readonly Vec3[]): number {
  let poly = corners.map((p) => new THREE.Vector3(p.x, p.y, p.z))
  for (const plane of planes) {
    poly = clipByPlane(poly, plane)
    if (poly.length < 3) return 0
  }
  return polygonArea(poly)
}

/** The area of the part of a tile that is in the camera's view and inside the square window `|x|, |z| <= halfSideM`. */
function visibleAreaM2(corners: readonly Vec3[], camera: RayCamera, halfSideM: number, far?: number): number {
  return areaWithin(viewPlanes(camera, halfSideM, far), corners)
}

/** Every tile of one zoom within reach of the window about the origin: more than it can touch, however the frame is turned. */
function tilesAround(frame: MapPlaneFrame, z: number, halfSideM: number): TileId[] {
  const home = latLngToTile(frame.origin.lat, frame.origin.lng, z)!
  const reach = Math.ceil((halfSideM * 1.5) / tileWidthM(frame.origin.lat, z)) + 2
  const n = 2 ** z
  const tiles: TileId[] = []
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const y = home.y + dy
      if (y < 0 || y >= n) continue
      tiles.push({ z, x: (((home.x + dx) % n) + n) % n, y })
    }
  }
  return tiles
}

const keyOf = (t: TileId): string => `${t.z}/${t.x}/${t.y}`

/** A tile showing this much of itself counts as in view: far above a sliver the module's one-micron guard can tell from nothing. */
const CLEARLY_VISIBLE_M2 = 0.01

/**
 * The tiles the module chose are the tiles the oracle sees: none that shows nothing, and none left out that shows
 * a patch of any size.
 */
function assertSeesWhatTheOracleSees(
  frame: MapPlaneFrame,
  camera: RayCamera,
  selection: { zoom: number; tiles: TileId[] },
  halfSideM: number,
  label: string,
  planeY = 0,
  far?: number,
): void {
  const planes = viewPlanes(camera, halfSideM, far)
  const flat = (t: TileId) => tileCornersScene(t, frame).map((c) => ({ ...c, y: planeY }))
  const chosen = new Set(selection.tiles.map(keyOf))
  assert.equal(chosen.size, selection.tiles.length, `${label}: a tile was named twice`)
  for (const tile of selection.tiles) {
    assert.equal(tile.z, selection.zoom, `${label}: one zoom for every tile`)
    const area = areaWithin(planes, flat(tile))
    assert.ok(area > 1e-9, `${label}: tile ${keyOf(tile)} shows ${area} m2 and was asked for`)
  }
  for (const tile of tilesAround(frame, selection.zoom, halfSideM)) {
    const area = areaWithin(planes, flat(tile))
    if (area >= CLEARLY_VISIBLE_M2) assert.ok(chosen.has(keyOf(tile)), `${label}: tile ${keyOf(tile)} shows ${area} m2 and was left out`)
  }
}

/** The area of each tile of one zoom within reach of the window that the camera shows part of, by the oracle. */
function shownAreas(frame: MapPlaneFrame, camera: RayCamera, z: number, halfSideM: number, planeY = 0, far?: number): Array<{ tile: TileId; area: number }> {
  const planes = viewPlanes(camera, halfSideM, far)
  return tilesAround(frame, z, halfSideM)
    .map((tile) => ({ tile, area: areaWithin(planes, tileCornersScene(tile, frame).map((c) => ({ ...c, y: planeY }))) }))
    .filter((t) => t.area > 0)
}

/** How many tiles of one zoom the oracle sees: at least `minAreaM2` of each in view. */
function oracleCount(frame: MapPlaneFrame, camera: RayCamera, z: number, halfSideM: number, planeY = 0, far?: number, minAreaM2 = CLEARLY_VISIBLE_M2): number {
  return shownAreas(frame, camera, z, halfSideM, planeY, far).filter((t) => t.area >= minAreaM2).length
}

/**
 * The distance from the camera to the nearest ground it shows inside the window, by three.js and no code of the
 * module's: the window's square at the plane's height clipped by the camera's own frustum planes, cut into triangles,
 * and `Triangle.closestPointToPoint` for the nearest point of each. Null when the camera sees none of the window.
 */
function nearestShownGroundM(camera: RayCamera, halfSideM: number, planeY = 0, far?: number): number | null {
  const c = threeCamera(camera, far)
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse))
  let poly = [[-halfSideM, -halfSideM], [halfSideM, -halfSideM], [halfSideM, halfSideM], [-halfSideM, halfSideM]]
    .map(([x, z]) => new THREE.Vector3(x, planeY, z))
  for (const plane of frustum.planes) {
    poly = clipByPlane(poly, plane)
    if (poly.length < 3) return null
  }
  const eye = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z)
  const closest = new THREE.Vector3()
  let best = Infinity
  for (let i = 1; i + 1 < poly.length; i++) {
    new THREE.Triangle(poly[0]!, poly[i]!, poly[i + 1]!).closestPointToPoint(eye, closest)
    best = Math.min(best, closest.distanceTo(eye))
  }
  return best
}

/** The zoom a distance asks for, worked from the ground resolution table and not from the module's zoom function. */
function zoomAskedFor(distanceM: number, latDeg: number, fovYDeg: number, viewportHeightPx: number, minZoom: number, maxZoom: number, tilePx = MAP_TILE_PX): { exact: number; zoom: number } {
  const metresPerScreenPx = (2 * distanceM * Math.tan((fovYDeg / 2) * DEG)) / viewportHeightPx
  const exact = 19 + Math.log2(groundResolutionM(latDeg, 19, tilePx) / metresPerScreenPx)
  return { exact, zoom: Math.min(maxZoom, Math.max(minZoom, Math.round(exact))) }
}

// ─── Constants ─────────────────────────────────────────────────────────────

test('the circumference is 40 075 016.6856 m, and the Web-Mercator square ends at 85.0511287798 degrees', () => {
  near(WEB_MERCATOR_CIRCUMFERENCE_M, 40_075_016.6856, 1e-4)
  assert.equal(Math.round(WEB_MERCATOR_CIRCUMFERENCE_M * 100) / 100, 40_075_016.69, 'to the centimetre')
  const limit = Number(TILE_REFERENCE[0]![8])
  near(WEB_MERCATOR_MAX_LATITUDE_DEG, limit, 1e-12)
  near(WEB_MERCATOR_MAX_LATITUDE_DEG, 85.05112877980659, 1e-12)
  assert.equal(MAP_TILE_PX, 256)
  assert.equal(SCENE_Z_BEARING_DEG, 180)
})

test('the cap is 64 tiles, which is 21.3 MiB of texture, and no tile is coarser than z14', () => {
  assert.equal(MAP_PLANE_MAX_TILES, 64)
  assert.equal(MAP_PLANE_COARSEST_ZOOM, 14)
  // 256 x 256 RGBA8 is 256 KiB, a full mip chain adds a third: 341.3 KiB a tile, 64 of them 21.3 MiB.
  const bytes = MAP_PLANE_MAX_TILES * 256 * 256 * 4 * (4 / 3)
  assert.equal((bytes / 2 ** 20).toFixed(1), '21.3')
})

test('the other adopted bounds are named: an origin longitude within a turn and a half, a near plane of 0.1 m, a deviation grid of 16 intervals', () => {
  assert.equal(MAX_ORIGIN_LONGITUDE_DEG, 540)
  assert.equal(MAP_PLANE_MIN_NEAR_M, 0.1)
  assert.equal(QUAD_DEVIATION_STEPS, 16)
  // The furthest column the scan can name: 540 degrees out, plus the half turn a wrapped longitude is carried by, at the
  // finest zoom. 2.7e9 is a thousandth of 2^53, where a float stops counting whole numbers.
  const furthest = latLngToTileFraction(0, MAX_ORIGIN_LONGITUDE_DEG + 180, MAP_TILE_MAX_ZOOM)!
  assert.ok(furthest.x < 2.7e9 && furthest.x < 2 ** 53 / 1000, `${furthest.x}`)
})

// ─── Lat/lng to tile ───────────────────────────────────────────────────────

test('lat/lng to tile: index, fraction and both corners match the 70-digit reference at six places and five zooms', () => {
  assert.equal(TILE_REFERENCE.length, 30)
  for (const [name, lat, lng, z, x, y, fx, fy, nwLat, nwLng, seLat, seLng] of TILE_REFERENCE) {
    const label = `${name} z${z}`
    assert.deepEqual(latLngToTile(lat, lng, z), { z, x, y }, label)
    const f = latLngToTileFraction(lat, lng, z)
    assert.ok(f, label)
    near(f.x - x, fx, 1e-9, `${label} fraction x`)
    near(f.y - y, fy, 1e-9, `${label} fraction y`)
    const nw = tilePointLatLng(z, x, y)
    near(nw.lat, nwLat, 1e-11, `${label} north-west lat`)
    near(nw.lng, nwLng, 1e-11, `${label} north-west lng`)
    const se = tilePointLatLng(z, x + 1, y + 1)
    near(se.lat, seLat, 1e-11, `${label} south-east lat`)
    near(se.lng, seLng, 1e-11, `${label} south-east lng`)
  }
})

test('lat/lng to tile: one tile at zoom 0, longitude wraps, the last row ends at the south limit, nothing beyond the projection', () => {
  assert.deepEqual(latLngToTile(0, 0, 0), { z: 0, x: 0, y: 0 })
  assert.deepEqual(latLngToTile(10, 190, 3), { z: 3, x: 0, y: latLngToTile(10, 0, 3)!.y })
  assert.deepEqual(latLngToTile(10, 190, 3), latLngToTile(10, -170, 3))
  assert.deepEqual(latLngToTile(10, -190, 3), latLngToTile(10, 170, 3))
  assert.equal(latLngToTile(10, -190, 3)!.x, 7)
  assert.equal(latLngToTile(-WEB_MERCATOR_MAX_LATITUDE_DEG, 0, 5)!.y, 31, 'the south limit belongs to the last row, not to a row 32')
  assert.equal(latLngToTile(WEB_MERCATOR_MAX_LATITUDE_DEG, 0, 5)!.y, 0)
  for (const lat of [85.06, -85.06, 90, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(latLngToTile(lat, 0, 5), null, `lat ${lat}`)
  assert.equal(latLngToTile(0, Number.NaN, 5), null)
  assert.equal(latLngToTile(0, Number.POSITIVE_INFINITY, 5), null)
  for (const z of [-1, 1.5, MAP_TILE_MAX_ZOOM + 1, Number.NaN]) assert.equal(latLngToTile(10, 10, z), null, `zoom ${z}`)
  assert.ok(latLngToTile(10, 10, MAP_TILE_MAX_ZOOM))
  assert.equal(latLngToTileFraction(86, 0, 3), null)
})

test('the grid point of a tile is its north-west corner: (1, 1) at zoom 1 is the point 0 N 0 E, and (0, 0) at zoom 0 is the limit and -180', () => {
  assert.deepEqual(tilePointLatLng(1, 1, 1), { lat: 0, lng: 0 })
  const corner = tilePointLatLng(0, 0, 0)
  near(corner.lat, 85.05112877980659, 1e-12)
  assert.equal(corner.lng, -180)
  assert.deepEqual(tilePointLatLng(2, 2, 2), { lat: 0, lng: 0 })
})

test('tilePointLatLng inverts latLngToTileFraction on two thousand random positions and zooms', () => {
  const rand = rng(11)
  for (let i = 0; i < 2000; i++) {
    const lat = (rand() - 0.5) * 168
    const lng = (rand() - 0.5) * 360
    const z = Math.floor(rand() * 23)
    const f = latLngToTileFraction(lat, lng, z)!
    const back = tilePointLatLng(z, f.x, f.y)
    near(back.lat, lat, 1e-9, `lat at z${z}`)
    near(back.lng, lng, 1e-9, `lng at z${z}`)
  }
})

// ─── Sizes ─────────────────────────────────────────────────────────────────

test('tile width: 47.6 m at z19 and 51.5 N, 63.7 m at 33.5 N, and the 70-digit table at every zoom and five latitudes', () => {
  assert.equal(tileWidthM(51.5, 19).toFixed(1), '47.6')
  assert.equal(tileWidthM(33.5, 19).toFixed(1), '63.7')
  assert.equal(WIDTH_REFERENCE.length, 35)
  for (const [lat, z, width] of WIDTH_REFERENCE) near(tileWidthM(lat, z), width, width * 1e-13, `lat ${lat} z${z}`)
  // A zoom up halves the width; a tile that is twice as wide is not a mistake of a factor of two anywhere else.
  near(tileWidthM(51.5, 18), 2 * tileWidthM(51.5, 19), 1e-9)
  // Forgetting cos(lat) stretches a z19 tile at 51.5 N by 1 / cos(51.5 degrees) = 1.606.
  near(WEB_MERCATOR_CIRCUMFERENCE_M / 2 ** 19 / tileWidthM(51.5, 19), 1.6064, 1e-4)
})

test('ground resolution: the table research note R4 prints, at latitudes 0, 33.5, 51.5 and 60 degrees', () => {
  const columns = [0, 33.5, 51.5, 60]
  const table: Record<number, number[]> = {
    17: [1.1943, 0.9959, 0.7435, 0.5972],
    18: [0.5972, 0.498, 0.3717, 0.2986],
    19: [0.2986, 0.249, 0.1859, 0.1493],
    20: [0.1493, 0.1245, 0.0929, 0.0746],
    21: [0.0746, 0.0622, 0.0465, 0.0373],
  }
  for (const z of Object.keys(table).map(Number)) {
    columns.forEach((lat, i) => near(groundResolutionM(lat, z), table[z]![i]!, 5.1e-5, `z${z} lat ${lat}`))
  }
  near(groundResolutionM(51.5, 19, 512), groundResolutionM(51.5, 19) / 2, 1e-12)
})

test('a tile is not as wide as its nominal width says: its true edges on the ellipsoid differ by up to 0.7 %, which is why corners place it', () => {
  // East-west and north-south edge of a z19 tile, metres, on the ellipsoid, as research note R4 section 3 derives them from the
  // scale factors of EPSG:3857 (a different route from corner ENU), at latitudes 0, 33.5, 51.5 and 60. The nominal widths are
  // 76.437, 63.740, 47.583 and 38.219 m.
  const ellipsoid: Array<[number, number, number]> = [
    [0.0001, 76.437, 75.925],
    [33.5, 63.805, 63.507],
    [51.5, 47.681, 47.557],
    [60, 38.315, 38.25],
  ]
  for (const [lat, eastWestM, northSouthM] of ellipsoid) {
    const tile = latLngToTile(lat, -0.1, 19)!
    const nw = tilePointLatLng(19, tile.x, tile.y)
    const se = tilePointLatLng(19, tile.x + 1, tile.y + 1)
    const frame: MapPlaneFrame = { origin: { lat: (nw.lat + se.lat) / 2, lng: (nw.lng + se.lng) / 2, altitudeM: 0 } }
    const [a, b, c] = tileCornersScene(tile, frame)
    near(Math.hypot(b.x - a.x, b.z - a.z), eastWestM, 1.5e-3, `lat ${lat} east-west edge`)
    near(Math.hypot(c.x - b.x, c.z - b.z), northSouthM, 1.5e-3, `lat ${lat} north-south edge`)
  }
  // At 51.5 N the east-west edge is 0.2 % over the nominal width and the north-south 0.05 % under; at the equator the north-south is 0.67 % under.
  const nominal = tileWidthM(51.5, 19)
  assert.ok(Math.abs(47.681 / nominal - 1 - 0.0021) < 2e-4 && Math.abs(47.557 / nominal - 1 + 0.0005) < 2e-4)
  assert.ok(Math.abs(75.925 / tileWidthM(0, 19) - 1 + 0.0067) < 2e-4)
})

// ─── The depth buffer ──────────────────────────────────────────────────────

/**
 * The step of a fixed-point depth buffer at a distance, measured on three.js's own projection matrix and not worked
 * from the formula: the width of the run of distances along the axis that are stored as the same depth.
 */
function measuredDepthStepM(near: number, far: number, distanceM: number, bits = 24): number {
  const camera = new THREE.PerspectiveCamera(60, 1, near, far)
  const stored = (z: number): number => (
    Math.floor(((new THREE.Vector3(0, 0, -z).applyMatrix4(camera.projectionMatrix).z + 1) / 2) * 2 ** bits)
  )
  const here = stored(distanceM)
  // Where the run starts: the smallest distance stored as `here`. Where it ends: the smallest stored as more.
  let lo = near
  let hi = distanceM
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (stored(mid) < here) lo = mid
    else hi = mid
  }
  const start = hi
  lo = distanceM
  hi = far
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (stored(mid) > here) hi = mid
    else lo = mid
  }
  return hi - start
}

test('depth step: 60 mm at 100 m with a near plane of 0.01 m, 0.37 m at 250 m, 0.95 m at 400 m, 3.8 m at 800 m, and a tenth of that at 0.1 m (research note R4)', () => {
  const r4: Array<[number, number, number]> = [[100, 0.06, 0.006], [250, 0.37, 0.037], [400, 0.95, 0.095], [800, 3.8, 0.38]]
  for (const [d, nearSmall, nearLarge] of r4) {
    assert.ok(Math.abs(depthStepM(0.01, d) / nearSmall - 1) < 0.01, `near 0.01 m at ${d} m: ${depthStepM(0.01, d)}`)
    assert.ok(Math.abs(depthStepM(0.1, d) / nearLarge - 1) < 0.01, `near 0.1 m at ${d} m: ${depthStepM(0.1, d)}`)
  }
  assert.equal(depthStepM(0.1, 0), 0)
})

test('depth step: the formula is what a fixed-point buffer on three.js\'s projection matrix does, over near planes, far planes, distances and 16 and 24 bits', () => {
  const cases: Array<[number, number, number]> = [[0.01, 1000, 24], [0.1, 800, 24], [1, 1000, 24], [0.1, 1000, 16], [0.01, 200, 24], [0.5, 50, 24]]
  for (const [near, far, bits] of cases) {
    for (const d of [3, 10, 100, 250, 400, 790]) {
      if (d >= far) continue
      const measured = measuredDepthStepM(near, far, d, bits)
      const formula = depthStepM(near, d, bits, far)
      // The run of distances stored as one depth runs from z0 to z1 with z0 <= d <= z1, and is exactly k z0 z1 where the
      // formula says k d^2: they differ by no more than the run's own width over the distance.
      assert.ok(Math.abs(measured / formula - 1) <= (1.01 * measured) / d + 1e-9, `near ${near} far ${far} ${bits} bits at ${d} m: measured ${measured}, formula ${formula}`)
    }
  }
  // A far plane much further than the distance is the limit the default stands for; a nearer one makes every step finer.
  assert.ok(Math.abs(depthStepM(0.01, 100, 24, 1e9) / depthStepM(0.01, 100) - 1) < 1e-6)
  assert.ok(depthStepM(0.01, 100, 24, 150) < depthStepM(0.01, 100))
  // Eight bits fewer is 256 times as coarse.
  near(depthStepM(0.1, 100, 16) / depthStepM(0.1, 100, 24), 256, 1e-9)
})

test('depth step: the near plane while the plane is visible is 0.1 m, because the plane is 0.03 m under the floor and 0.01 m cannot tell that at 100 m', () => {
  const offsetM = 0.03
  assert.ok(depthStepM(0.01, 100) > offsetM, `a near plane of 0.01 m steps ${depthStepM(0.01, 100)} m: the plane and the floor are one surface`)
  assert.ok(depthStepM(MAP_PLANE_MIN_NEAR_M, 100) < offsetM / 4, `a near plane of ${MAP_PLANE_MIN_NEAR_M} m steps ${depthStepM(MAP_PLANE_MIN_NEAR_M, 100)} m`)
})

test('depth step: not a number for a camera that is not one', () => {
  const bads: Array<Parameters<typeof depthStepM>> = [
    [0, 100], [-1, 100], [Number.NaN, 100], [Number.POSITIVE_INFINITY, 100], [0.1, -1], [0.1, Number.NaN], [0.1, Number.POSITIVE_INFINITY],
    [0.1, 100, 0], [0.1, 100, 33], [0.1, 100, 24.5], [0.1, 100, Number.NaN], [0.1, 100, 24, 0.1], [0.1, 100, 24, 0.05], [0.1, 100, 24, Number.NaN],
  ]
  for (const args of bads) assert.ok(Number.isNaN(depthStepM(...args)), JSON.stringify(args))
  assert.ok(Number.isFinite(depthStepM(0.1, 100, 32)) && Number.isFinite(depthStepM(0.1, 100, 1)), 'the whole range of bits works')
})

// ─── Tile corners in a frame ───────────────────────────────────────────────

test('tile corners through exact ENU match the 70-digit reference at four places: x east, y the fall of the Earth, z south', () => {
  assert.equal(CORNER_REFERENCE.length, 4)
  for (const [z, x, y, lat, lng, altitudeM, ...enu] of CORNER_REFERENCE) {
    const corners = tileCornersScene({ z, x, y }, { origin: { lat, lng, altitudeM } })
    enu.forEach(([east, north, up], i) => {
      const label = `z${z} ${x}/${y} corner ${i}`
      near(corners[i]!.x, east!, 1e-7, `${label} x`)
      near(corners[i]!.y, up!, 1e-7, `${label} y`)
      near(corners[i]!.z, -north!, 1e-7, `${label} z`)
    })
  }
})

test('the z19 tile at 51.5 N seen from its own centre has the corners research note R4 prints', () => {
  const tile = latLngToTile(51.5, -0.1, 19)!
  const nw = tilePointLatLng(19, tile.x, tile.y)
  const se = tilePointLatLng(19, tile.x + 1, tile.y + 1)
  const frame: MapPlaneFrame = { origin: { lat: (nw.lat + se.lat) / 2, lng: (nw.lng + se.lng) / 2, altitudeM: 0 } }
  // R4 prints (east, north): NW (-23.8404, 23.7785), NE (23.8404, 23.7785), SE (23.8406, -23.7784), SW (-23.8406, -23.7784).
  const expected = [[-23.8404, 23.7785], [23.8404, 23.7785], [23.8406, -23.7784], [-23.8406, -23.7784]]
  tileCornersScene(tile, frame).forEach((corner, i) => {
    near(corner.x, expected[i]![0]!, 6e-5, `corner ${i} east`)
    near(corner.z, -expected[i]![1]!, 6e-5, `corner ${i} south`)
  })
})

test('corners are in the order north-west, north-east, south-east, south-west: east is +x, north is -z', () => {
  const tile = latLngToTile(51.5, -0.1, 17)!
  const [nw, ne, se, sw] = tileCornersScene(tile, LONDON)
  assert.ok(ne.x > nw.x && se.x > sw.x, 'east is +x')
  assert.ok(sw.z > nw.z && se.z > ne.z, 'south is +z')
  // A tile north-east of the origin lies at +x and -z.
  const [a] = tileCornersScene({ z: 19, x: 261998 + 3, y: 174356 - 3 }, LONDON)
  assert.ok(a.x > 0 && a.z < 0, `${a.x}, ${a.z}`)
})

test('the corners run clockwise from above: the faces (0, 2, 1) and (0, 3, 2) point up and are drawn from above, (0, 1, 2) and (0, 2, 3) point down and are culled', () => {
  const tile = latLngToTile(51.5, -0.1, 19)!
  const corners = tileCornersScene(tile, LONDON)
  const mesh = (index: number[]): THREE.Mesh => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((c) => [c.x, c.y, c.z]), 3))
    geometry.setIndex(index)
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }))
  }
  // A point inside the tile and off its diagonal, one inside each of the two triangles of either list.
  const inside = (a: Vec3, b: Vec3, c: Vec3): Vec3 => ({ x: (a.x + b.x + c.x) / 3, y: 0, z: (a.z + b.z + c.z) / 3 })
  const [nw, ne, se, sw] = corners
  for (const [point, label] of [[inside(nw, ne, se), 'north-east half'], [inside(nw, se, sw), 'south-west half']] as const) {
    const down = new THREE.Raycaster(new THREE.Vector3(point.x, 100, point.z), new THREE.Vector3(0, -1, 0))
    const up = new THREE.Raycaster(new THREE.Vector3(point.x, -100, point.z), new THREE.Vector3(0, 1, 0))
    const faceUp = mesh([0, 2, 1, 0, 3, 2])
    assert.equal(down.intersectObject(faceUp).length, 1, `${label}: (0, 2, 1) and (0, 3, 2) are drawn when seen from above`)
    assert.equal(up.intersectObject(faceUp).length, 0, `${label}: and culled from below`)
    const faceDown = mesh([0, 1, 2, 0, 2, 3])
    assert.equal(down.intersectObject(faceDown).length, 0, `${label}: (0, 1, 2) and (0, 2, 3) are culled from above`)
    assert.equal(up.intersectObject(faceDown).length, 1, `${label}: and drawn from below`)
  }
})

test('the plane falls away from the origin as the Earth does: d squared over twice the radius, 0.8 mm at 100 m to 78 mm at 1 km', () => {
  // The prime-vertical radius at 51.5 N, the one a due-east point falls by.
  const sin = Math.sin(51.5 * DEG)
  const e2 = WGS84_F * (2 - WGS84_F)
  const radius = WGS84_A_M / Math.sqrt(1 - e2 * sin * sin)
  for (const [d, mm] of [[100, 0.8], [250, 4.9], [500, 19.6], [1000, 78.2]] as const) {
    const g = enuToGeodetic(LONDON.origin, { east: d, north: 0, up: 0 })
    const p = latLngToScene(LONDON, g.lat, g.lng)
    near(p.x, d, 1e-4, `${d} m east`)
    near(p.y, -(d * d) / (2 * radius), 1e-6, `${d} m fall`)
    near(-p.y * 1000, mm, 0.011 * mm + 0.011, `${d} m: research note R4 says ${mm} mm`)
  }
})

test('at a Place 1500 m up the plane is still at the Place: y is the fall of the Earth, and the ground is 0.0235 % bigger than at the surface', () => {
  // Each corner is taken at the origin's own height, where the feature it maps stands. At 1500 m the same angular
  // distance is (R + 1500) / R longer, 1 + 2.35e-4: 1.2 cm across a 47.6 m tile, and nothing a map can place to.
  const tile = { z: 19, x: 261998 + 2, y: 174356 + 2 }
  const surface = tileCornersScene(tile, { origin: { lat: 51.5001, lng: -0.1, altitudeM: 0 } })
  const high = tileCornersScene(tile, { origin: { lat: 51.5001, lng: -0.1, altitudeM: 1500 } })
  high.forEach((c, i) => {
    const ratio = Math.hypot(c.x, c.z) / Math.hypot(surface[i]!.x, surface[i]!.z)
    assert.ok(ratio - 1 > 2.3e-4 && ratio - 1 < 2.4e-4, `corner ${i}: ${ratio - 1}`)
    assert.ok(Math.abs(c.y) < 0.01, `corner ${i}: y ${c.y} is the fall of the Earth, not -1500 m`)
  })
})

// ─── Frames with a bearing ─────────────────────────────────────────────────

test('left out, the frame is the scene: a bearing of 180 degrees gives the same corners to the last bit', () => {
  const tile = { z: 19, x: 261998, y: 174356 }
  assert.deepEqual(
    tileCornersScene(tile, { origin: LONDON.origin, zAxisBearingDeg: SCENE_Z_BEARING_DEG }),
    tileCornersScene(tile, LONDON),
  )
})

test('a frame whose +Z has bearing b: a point d metres out at bearing b is on +Z, and one at b - 90 degrees is on +X (right-handed, never mirrored)', () => {
  const rand = rng(5)
  for (const bearing of [0, 33, 90, 180, 217.5, 270, 359]) {
    const frame: MapPlaneFrame = { origin: LONDON.origin, zAxisBearingDeg: bearing }
    const d = 80
    const at = (bearingDeg: number): Vec3 => {
      const g = enuToGeodetic(LONDON.origin, { east: d * Math.sin(bearingDeg * DEG), north: d * Math.cos(bearingDeg * DEG), up: 0 })
      return latLngToScene(frame, g.lat, g.lng)
    }
    const along = at(bearing)
    near(along.x, 0, 1e-6, `bearing ${bearing}: +Z x`)
    near(along.z, d, 1e-6, `bearing ${bearing}: +Z z`)
    const across = at(bearing - 90)
    near(across.x, d, 1e-6, `bearing ${bearing}: +X x`)
    near(across.z, 0, 1e-6, `bearing ${bearing}: +X z`)
    // And the closed form for anywhere: x = -E cos b + N sin b, z = E sin b + N cos b.
    for (let i = 0; i < 20; i++) {
      const east = (rand() - 0.5) * 300
      const north = (rand() - 0.5) * 300
      const g = enuToGeodetic(LONDON.origin, { east, north, up: 0 })
      const p = latLngToScene(frame, g.lat, g.lng)
      const b = bearing * DEG
      near(p.x, -east * Math.cos(b) + north * Math.sin(b), 1e-5, `bearing ${bearing}: x`)
      near(p.z, east * Math.sin(b) + north * Math.cos(b), 1e-5, `bearing ${bearing}: z`)
    }
  }
})

test('scene to lat/lng undoes lat/lng to scene on the ground plane, in every frame (within 150 m)', () => {
  const rand = rng(23)
  for (const frame of [LONDON, SYDNEY, { origin: LONDON.origin, zAxisBearingDeg: 33 }, { origin: SYDNEY.origin, zAxisBearingDeg: 250 }]) {
    for (let i = 0; i < 50; i++) {
      const x = (rand() - 0.5) * 300
      const z = (rand() - 0.5) * 300
      const ll = sceneToLatLng(frame, x, z)
      const back = latLngToScene(frame, ll.lat, ll.lng)
      near(back.x, x, 1e-6, 'x')
      near(back.z, z, 1e-6, 'z')
    }
  }
  const home = sceneToLatLng(LONDON, 0, 0)
  near(home.lat, 51.5, 1e-12)
  near(home.lng, -0.1, 1e-12)
})

// ─── What a four-corner quad costs ─────────────────────────────────────────

test('quad deviation: the 70-digit reference to a micron, four tiles, one against the equator where the worst sample is not on a coarse grid', () => {
  assert.equal(DEVIATION_REFERENCE.length, 4)
  for (const [z, x, y, lat, lng, altitudeM, horizontalM, verticalM, triangulatedM] of DEVIATION_REFERENCE) {
    const got = quadDeviation({ z, x, y }, { origin: { lat, lng, altitudeM } })
    const label = `z${z} ${x}/${y}`
    near(got.horizontalM, horizontalM, 1e-8 + horizontalM * 1e-4, `${label} horizontal`)
    near(got.verticalM, verticalM, 1e-8 + verticalM * 1e-4, `${label} vertical`)
    near(got.triangulatedM, triangulatedM, 1e-8 + triangulatedM * 1e-4, `${label} triangulated`)
  }
})

test('quad deviation: about 56 microns at z19 and 3.6 mm at z16 at 51.5 N, the figures research note R4 reports', () => {
  const z19 = quadDeviation({ z: 19, x: 261998, y: 174356 }, LONDON)
  assert.equal(Math.round(z19.horizontalM * 1e6), 56)
  near(z19.horizontalM, 5.59e-5, 5e-8, 'R4 prints 5.590e-5 m')
  const z16 = quadDeviation({ z: 16, x: 32749, y: 21794 }, LONDON)
  assert.equal((z16.horizontalM * 1e3).toFixed(1), '3.6')
  near(z16.horizontalM, 3.5777e-3, 5e-6)
})

test('quad deviation follows its closed forms: M (2 pi)^2 sin(lat) cos(lat) / (8 4^z) across, W^2 / (4 R) up', () => {
  const e2 = WGS84_F * (2 - WGS84_F)
  for (const [z, x, y] of [[19, 261998, 174356], [17, 65499, 43589], [16, 32749, 21794]] as const) {
    const nw = tilePointLatLng(z, x, y)
    const se = tilePointLatLng(z, x + 1, y + 1)
    const lat = (nw.lat + se.lat) / 2
    const sin = Math.sin(lat * DEG)
    const m = (WGS84_A_M * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5
    const across = (m * (2 * Math.PI) ** 2 * sin * Math.cos(lat * DEG)) / (8 * 4 ** z)
    const width = tileWidthM(lat, z)
    const up = (width * width) / (4 * WGS84_A_M)
    const got = quadDeviation({ z, x, y }, { origin: { lat, lng: (nw.lng + se.lng) / 2, altitudeM: 0 } })
    assert.ok(Math.abs(got.horizontalM / across - 1) < 0.01, `z${z} horizontal ${got.horizontalM} against ${across}`)
    assert.ok(Math.abs(got.verticalM / up - 1) < 0.01, `z${z} vertical ${got.verticalM} against ${up}`)
  }
})

test('quad deviation: 57 mm at z14 and 0.23 m at z13, which is why no plane is made of tiles coarser than z14', () => {
  const at = (z: number) => quadDeviation(latLngToTile(51.5, -0.1, z)!, LONDON)
  assert.equal((at(14).horizontalM * 1e3).toFixed(0), '57')
  assert.equal(at(13).horizontalM.toFixed(2), '0.23')
  // Every tile the module will draw is within centimetres east-west and north-south; the 3.5 m of a map click is a hundred times that.
  assert.ok(at(MAP_PLANE_COARSEST_ZOOM).horizontalM < 0.06)
})

test('quad deviation: a zoom out is a tile twice as wide, so four times the deviation, and none at all for the north-south part on the equator', () => {
  const z19 = quadDeviation({ z: 19, x: 261998, y: 174356 }, LONDON).horizontalM
  const z18 = quadDeviation({ z: 18, x: 130999, y: 87178 }, LONDON).horizontalM
  assert.ok(Math.abs(z18 / z19 - 4) < 0.05, `${z18 / z19}`)
  const equator = quadDeviation({ z: 19, x: 262144, y: 262144 }, { origin: { lat: 0, lng: 0, altitudeM: 0 } })
  assert.ok(equator.horizontalM < 1e-8, `${equator.horizontalM}`)
  // The two triangles add the quad's twist to the bilinear patch: more than it, and the 0.14 mm and 9.1 mm the module note gives.
  const tri19 = quadDeviation({ z: 19, x: 261998, y: 174356 }, LONDON).triangulatedM
  const tri16 = quadDeviation({ z: 16, x: 32749, y: 21794 }, LONDON).triangulatedM
  assert.equal((tri19 * 1e3).toFixed(2), '0.14')
  assert.equal((tri16 * 1e3).toFixed(1), '9.1')
  assert.equal((quadDeviation({ z: 19, x: 261998, y: 174356 }, LONDON).verticalM * 1e6).toFixed(0), '89')
  assert.equal((quadDeviation({ z: 16, x: 32749, y: 21794 }, LONDON).verticalM * 1e3).toFixed(1), '5.7')
})

test('quad deviation does not depend on how the frame is turned', () => {
  const tile = { z: 19, x: 261998, y: 174356 }
  const plain = quadDeviation(tile, LONDON)
  const turned = quadDeviation(tile, { origin: LONDON.origin, zAxisBearingDeg: 33 })
  near(turned.horizontalM, plain.horizontalM, 1e-9)
  near(turned.verticalM, plain.verticalM, 1e-9)
  near(turned.triangulatedM, plain.triangulatedM, 1e-9)
})

test('quad deviation: steps below 2 or not a whole number are the default grid, and not a grid of corners that reads as a perfect quad', () => {
  const tile = { z: 16, x: 32749, y: 21794 }
  const reference = quadDeviation(tile, LONDON)
  assert.ok(reference.horizontalM > 3e-3 && reference.verticalM > 5e-3, JSON.stringify(reference))
  assert.deepEqual(quadDeviation(tile, LONDON, QUAD_DEVIATION_STEPS), reference)
  // Corners alone have no deviation by construction (1), no grid at all gives nothing (0), and a count that is not whole never reaches the far edge (2.5).
  for (const steps of [1, 0, -1, -16, 2.5, 16.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(quadDeviation(tile, LONDON, steps), reference, `steps ${steps}`)
  }
})

test('quad deviation: away from the equator a grid of 2 intervals finds the same worst point as the default one, the middle of the tile', () => {
  for (const lat of [33.5, 51.5, 60, -33.9]) {
    for (const z of [16, 19]) {
      const home = latLngToTile(lat, 12.3, z)!
      const nw = tilePointLatLng(z, home.x, home.y)
      const se = tilePointLatLng(z, home.x + 1, home.y + 1)
      const frame: MapPlaneFrame = { origin: { lat: (nw.lat + se.lat) / 2, lng: (nw.lng + se.lng) / 2, altitudeM: 0 } }
      const fine = quadDeviation(home, frame)
      const coarse = quadDeviation(home, frame, 2)
      for (const key of ['horizontalM', 'verticalM', 'triangulatedM'] as const) {
        assert.ok(Math.abs(coarse[key] / fine[key] - 1) < 1e-6, `lat ${lat} z${z} ${key}: ${coarse[key]} against ${fine[key]}`)
      }
    }
  }
  // Against the equator the worst sample is not one of the nine, and a grid of 2 intervals is 2.5 % short of it: so 2 is a grid of its own,
  // and not the default.
  const [z, x, y, lat, lng, altitudeM] = DEVIATION_REFERENCE[3]!
  const equatorial = { origin: { lat, lng, altitudeM } }
  const coarse = quadDeviation({ z, x, y }, equatorial, 2)
  const fine = quadDeviation({ z, x, y }, equatorial)
  assert.ok(coarse.horizontalM < fine.horizontalM * 0.99 && coarse.horizontalM > fine.horizontalM * 0.95, `${coarse.horizontalM} against ${fine.horizontalM}`)
  // The grids are nested (2 within 4 within 16), so the worst sample can only grow as the grid is refined.
  const four = quadDeviation({ z, x, y }, equatorial, 4)
  assert.ok(coarse.horizontalM <= four.horizontalM && four.horizontalM <= fine.horizontalM, `${coarse.horizontalM}, ${four.horizontalM}, ${fine.horizontalM}`)
})

// ─── Which zoom a distance asks for ────────────────────────────────────────

/** The distance at which one screen pixel covers exactly one pixel of a tile of zoom `z`. */
function distanceForZoom(latDeg: number, fovYDeg: number, viewportHeightPx: number, z: number): number {
  return (groundResolutionM(latDeg, z) * viewportHeightPx) / (2 * Math.tan((fovYDeg / 2) * DEG))
}

const ZOOM = { latDeg: 51.5, fovYDeg: 50, viewportHeightPx: 800, minZoom: 0, maxZoom: 22 }

test('zoom for distance: where a screen pixel is a tile pixel, that tile; twice as far is one zoom coarser, half as far one finer', () => {
  for (const z of [14, 17, 19]) {
    const d = distanceForZoom(51.5, 50, 800, z)
    assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: d }), z)
    assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 2 * d }), z - 1)
    assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 4 * d }), z - 2)
    assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: d / 2 }), z + 1)
  }
})

test('zoom for distance: the nearest whole zoom, so a mismatch of up to half a level either way', () => {
  const d = distanceForZoom(51.5, 50, 800, 18)
  // log2 of the factor is how far from 18 the exact zoom is: 1.3 is 0.38 coarser, 1.5 is 0.58, 0.75 is 0.42 finer, 0.7 is 0.51.
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 1.3 * d }), 18)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 1.5 * d }), 17)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 0.75 * d }), 18)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 0.7 * d }), 19)
})

test('zoom for distance: held to the provider range, and a tile with twice the pixels is one zoom coarser', () => {
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 0.01, maxZoom: 19 }), 19)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 1e7, minZoom: 15 }), 15)
  const d = distanceForZoom(51.5, 50, 800, 19)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: d }), 19)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: d, tilePx: 512 }), 18)
  // A shorter picture is a coarser screen, so a coarser zoom; a taller one is finer.
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: d, viewportHeightPx: 400 }), 18)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: d, viewportHeightPx: 1600 }), 20)
})

test('zoom for distance: tiles are narrower at 60 degrees than at the equator, by cos(60) = 1/2, so the same view is one zoom coarser', () => {
  const d = distanceForZoom(0, 50, 800, 18)
  assert.equal(zoomForCameraDistance({ ...ZOOM, latDeg: 0, distanceM: d }), 18)
  assert.equal(zoomForCameraDistance({ ...ZOOM, latDeg: 60, distanceM: d }), 17)
})

test('zoom for distance: a request that makes no sense is the coarsest zoom, not NaN', () => {
  const ok = { ...ZOOM, distanceM: 100, minZoom: 3 }
  assert.ok(zoomForCameraDistance(ok) > 3, 'the control case asks for something finer')
  for (const bad of [
    { distanceM: 0 }, { distanceM: -5 }, { distanceM: Number.NaN }, { fovYDeg: 0 }, { fovYDeg: 180 }, { fovYDeg: Number.NaN },
    { viewportHeightPx: 0 }, { viewportHeightPx: Number.NaN }, { latDeg: 86 }, { latDeg: Number.NaN }, { tilePx: 0 },
  ]) {
    assert.equal(zoomForCameraDistance({ ...ok, ...bad }), 3, JSON.stringify(bad))
  }
})

test('zoom for distance: the edges of what is allowed are used, not refused: a lens of half a degree, a tile of one pixel, a picture one pixel high, the projection\'s own latitude limit', () => {
  const d = distanceForZoom(51.5, 50, 800, 19)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: d, tilePx: 1 }), 22, 'a tile of one pixel asks for the finest the provider has')
  // One pixel for the whole picture at 1 m: a screen pixel is 2 tan 25 = 0.93 m, so log2(24.9e6 / (256 x 0.93)) = 16.7.
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 1, viewportHeightPx: 1 }), 17)
  assert.equal(zoomForCameraDistance({ ...ZOOM, distanceM: 1000, fovYDeg: 0.5 }), 22, 'a lens of half a degree at 1 km: 1.1 cm a pixel')
  const atLimit = zoomForCameraDistance({ ...ZOOM, latDeg: WEB_MERCATOR_MAX_LATITUDE_DEG, distanceM: 100, minZoom: 3 })
  assert.ok(atLimit > 3 && atLimit < 22, `${atLimit}`)
  assert.equal(zoomForCameraDistance({ ...ZOOM, latDeg: WEB_MERCATOR_MAX_LATITUDE_DEG + 0.001, distanceM: 100, minZoom: 3 }), 3)
})

// ─── What a camera can see ─────────────────────────────────────────────────

type Ground = { x: number; z: number }

function assertVertices(actual: Ground[], expected: Ground[], tolerance: number, label: string): void {
  assert.equal(actual.length, expected.length, `${label}: ${actual.length} vertices ${JSON.stringify(actual)}`)
  for (const e of expected) {
    assert.ok(actual.some((a) => Math.hypot(a.x - e.x, a.z - e.z) < tolerance), `${label}: no vertex at (${e.x}, ${e.z}) in ${JSON.stringify(actual)}`)
  }
}

function insideConvex(poly: Ground[], x: number, z: number): boolean {
  let positive = false
  let negative = false
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const cross = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)
    if (cross > 0) positive = true
    if (cross < 0) negative = true
  }
  return !(positive && negative)
}

test('visible ground: a camera straight down 100 m up sees the rectangle its field of view makes, 23.3 m either side across and 46.6 m along', () => {
  // Half the vertical field of view is 25 degrees: 100 tan 25 = 46.63 m up the picture and 0.5 of that across it.
  const halfZ = Math.tan(25 * DEG) * 100
  const halfX = 0.5 * halfZ
  const poly = visibleGroundPolygon(looksDown({ x: 0, y: 100, z: 0 }), 0, 150)
  assertVertices(poly, [{ x: halfX, z: halfZ }, { x: halfX, z: -halfZ }, { x: -halfX, z: halfZ }, { x: -halfX, z: -halfZ }], 1e-9, 'down')
  assert.ok(Math.abs(halfX - 23.3154) < 1e-4 && Math.abs(halfZ - 46.6308) < 1e-4)
})

test('visible ground: the window cuts the picture where it reaches past it, and the camera need not be over the origin', () => {
  const halfZ = Math.tan(25 * DEG) * 400
  const halfX = 0.5 * halfZ
  // At 400 m the picture is 186.5 m up and down, beyond the 150 m window.
  assertVertices(
    visibleGroundPolygon(looksDown({ x: 0, y: 400, z: 0 }), 0, 150),
    [{ x: halfX, z: 150 }, { x: halfX, z: -150 }, { x: -halfX, z: 150 }, { x: -halfX, z: -150 }],
    1e-9,
    'cut by the window',
  )
  const h = Math.tan(25 * DEG) * 100
  assertVertices(
    visibleGroundPolygon(looksDown({ x: 30, y: 100, z: -20 }), 0, 150),
    [{ x: 30 + h / 2, z: -20 + h }, { x: 30 + h / 2, z: -20 - h }, { x: 30 - h / 2, z: -20 + h }, { x: 30 - h / 2, z: -20 - h }],
    1e-9,
    'off centre',
  )
})

test('visible ground: a level camera 2 m up sees a wedge that starts 4.29 m ahead, where its lowest ray meets the floor', () => {
  // At (0, 2, 50) looking north (-z). The lowest ray is 25 degrees down: it meets the floor 2 / tan 25 = 4.289 m ahead, where
  // the picture is aspect * 2 = 1 m either side. Out to the window's far edge, 200 m ahead, it is 0.5 * tan 25 * 200 = 46.63 m.
  const tan = Math.tan(25 * DEG)
  const near = 2 / tan
  assertVertices(
    visibleGroundPolygon(cameraAt({ x: 0, y: 2, z: 50 }, 0, 0, 50, 0.5), 0, 150),
    [{ x: 1, z: 50 - near }, { x: -1, z: 50 - near }, { x: 0.5 * tan * 200, z: -150 }, { x: -0.5 * tan * 200, z: -150 }],
    1e-9,
    'level',
  )
})

test('visible ground: a raised plane is a nearer floor, and a camera rolled a quarter turn has its long side across', () => {
  const tan = Math.tan(25 * DEG)
  assertVertices(
    visibleGroundPolygon(looksDown({ x: 0, y: 100, z: 0 }), 50, 150),
    [{ x: 0.5 * tan * 50, z: tan * 50 }, { x: 0.5 * tan * 50, z: -tan * 50 }, { x: -0.5 * tan * 50, z: tan * 50 }, { x: -0.5 * tan * 50, z: -tan * 50 }],
    1e-9,
    'plane at y = 50',
  )
  const rolled = cameraAt({ x: 0, y: 100, z: 0 }, -90, 0, 50, 0.5, 90)
  const poly = visibleGroundPolygon(rolled, 0, 150)
  assert.equal(poly.length, 4)
  assert.ok(Math.max(...poly.map((p) => Math.abs(p.x))) > 46.6 && Math.max(...poly.map((p) => Math.abs(p.z))) < 23.4, JSON.stringify(poly))
})

test('visible ground agrees with three.js on twenty-five random cameras: inside the polygon is in the picture, outside it is not', () => {
  const rand = rng(77)
  let inside = 0
  let outside = 0
  let empty = 0
  for (let c = 0; c < 25; c++) {
    const camera = cameraAt(
      { x: (rand() - 0.5) * 200, y: 1 + rand() * 150, z: (rand() - 0.5) * 200 },
      -90 + rand() * 100,
      rand() * 360,
      40 + rand() * 40,
      0.5 + rand() * 1.3,
      (rand() - 0.5) * 30,
    )
    const half = 120
    const poly = visibleGroundPolygon(camera, 0, half)
    if (poly.length === 0) empty++
    for (let i = 0; i < 1500; i++) {
      const x = (rand() * 2 - 1) * half
      const z = (rand() * 2 - 1) * half
      const n = ndcOf(camera, { x, y: 0, z })
      const margin = 1 - Math.max(Math.abs(n.x), Math.abs(n.y))
      if (n.ahead && Math.abs(margin) < 1e-6) continue
      const seen = n.ahead && margin > 0
      assert.equal(poly.length > 0 && insideConvex(poly, x, z), seen, `camera ${c}: (${x.toFixed(2)}, ${z.toFixed(2)}) ndc ${n.x.toFixed(4)}, ${n.y.toFixed(4)}`)
      if (seen) inside++
      else outside++
    }
    // Every vertex is on the edge of the picture or of the window, and in front of the camera.
    for (const v of poly) {
      const n = ndcOf(camera, { x: v.x, y: 0, z: v.z })
      assert.ok(n.ahead, `camera ${c}: a vertex is behind the camera`)
      const onWindow = Math.abs(Math.abs(v.x) - half) < 1e-9 || Math.abs(Math.abs(v.z) - half) < 1e-9
      assert.ok(Math.max(Math.abs(n.x), Math.abs(n.y)) <= 1 + 1e-9, `camera ${c}: a vertex is outside the picture`)
      if (!onWindow) near(Math.max(Math.abs(n.x), Math.abs(n.y)), 1, 1e-9, `camera ${c}: a vertex inside the window is on the picture's edge`)
    }
  }
  assert.ok(inside > 3000 && outside > 3000 && empty < 25, `${inside} points seen, ${outside} not, ${empty} cameras that saw none`)
})

test('visible ground: nothing for a camera at or below the plane, one looking at the sky, one looking away from the window, or one that is not a camera', () => {
  const down = looksDown({ x: 0, y: 100, z: 0 })
  assert.equal(visibleGroundPolygon(down, 0, 150).length, 4, 'the control case sees the ground')
  assert.deepEqual(visibleGroundPolygon(looksDown({ x: 0, y: 0, z: 0 }), 0, 150), [], 'on the plane')
  assert.deepEqual(visibleGroundPolygon(looksDown({ x: 0, y: -5, z: 0 }), 0, 150), [], 'below it')
  assert.deepEqual(visibleGroundPolygon(looksDown({ x: 0, y: 100, z: 0 }), 100, 150), [], 'the plane is at the camera')
  assert.deepEqual(visibleGroundPolygon(cameraAt({ x: 0, y: 5, z: 0 }, 30, 0, 50, 0.5), 0, 150), [], 'looking up')
  assert.deepEqual(visibleGroundPolygon(looksDown({ x: 0, y: 100, z: 300 }), 0, 150), [], 'over ground beyond the window')
  assert.deepEqual(visibleGroundPolygon(cameraAt({ x: 0, y: 2, z: 200 }, 0, 180, 50, 0.5), 0, 150), [], 'level, 50 m beyond the window and looking away from it')
  assert.deepEqual(visibleGroundPolygon({ ...down, fovYDeg: 0 }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, aspect: 0 }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, rotation: { x: 0, y: 0, z: 0, w: 0 } }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, rotation: { x: 0, y: 0, z: 0, w: 1e-12 } }, 0, 150), [], 'a rotation with no length, to a billionth')
  // A level camera 1 m up with a 90 degree lens sees the floor from 0.5 m ahead on, whatever the length of its rotation, which is exactly a billionth
  // for the first and twice that for the second: the first has no length to a billionth, and the second has.
  const level: RayCamera = { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, fovYDeg: 90, aspect: 1 }
  assert.ok(visibleGroundPolygon(level, 0, 150).length >= 3, 'the control case sees the floor')
  assert.deepEqual(visibleGroundPolygon({ ...level, rotation: { x: 0, y: 0, z: 0, w: 1e-9 } }, 0, 150), [], 'a rotation exactly a billionth long')
  assert.equal(visibleGroundPolygon({ ...level, rotation: { x: 0, y: 0, z: 0, w: 2e-9 } }, 0, 150).length, visibleGroundPolygon(level, 0, 150).length, 'and one twice that is a rotation')
  assert.deepEqual(visibleGroundPolygon({ ...down, aspect: Number.POSITIVE_INFINITY }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, position: { x: Number.NaN, y: 100, z: 0 } }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon(down, Number.NaN, 150), [])
  assert.deepEqual(visibleGroundPolygon(down, Number.POSITIVE_INFINITY, 150), [])
  assert.deepEqual(visibleGroundPolygon(down, 0, 0), [])
  assert.deepEqual(visibleGroundPolygon(down, 0, -3), [])
  assert.deepEqual(visibleGroundPolygon(down, 0, Number.POSITIVE_INFINITY), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, fovYDeg: 180 }, 0, 150), [], 'a lens of 180 degrees is not one')
  assert.deepEqual(visibleGroundPolygon({ ...down, fovYDeg: -60 }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, fovYDeg: Number.NaN }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, aspect: -1 }, 0, 150), [])
  assert.deepEqual(visibleGroundPolygon({ ...down, aspect: Number.NaN }, 0, 150), [])
  assert.equal(visibleGroundPolygon({ ...down, fovYDeg: 0.5 }, 0, 150).length, 4, 'a narrow lens is still a lens')
})

test('visible ground: a rotation that is not unit length points the camera where the unit one does, at any scale', () => {
  const camera = cameraAt({ x: 12, y: 60, z: -7 }, -70, 30, 50, 0.7, 5)
  const unit = visibleGroundPolygon(camera, 0, 150)
  assert.ok(unit.length >= 3, 'the control case sees the ground')
  for (const k of [7, 1e-3, 1e-6, 1e6]) {
    const r = camera.rotation
    const scaled = visibleGroundPolygon({ ...camera, rotation: { x: r.x * k, y: r.y * k, z: r.z * k, w: r.w * k } }, 0, 150)
    assert.equal(scaled.length, unit.length, `scale ${k}`)
    scaled.forEach((v, i) => {
      near(v.x, unit[i]!.x, 1e-6, `scale ${k} vertex ${i} x`)
      near(v.z, unit[i]!.z, 1e-6, `scale ${k} vertex ${i} z`)
    })
  }
})

test('visible ground: a far plane stops the picture at its depth along the view direction, which is not its distance on the floor', () => {
  // The level camera of the wedge test: 2 m up at (0, 2, 50) looking north, a 50 degree lens, aspect 0.5. A far plane 100 m out
  // cuts it across the view direction, at z = -50, where the picture is 0.5 tan 25 x 100 = 23.3 m either side.
  const tan = Math.tan(25 * DEG)
  const level = cameraAt({ x: 0, y: 2, z: 50 }, 0, 0, 50, 0.5)
  assertVertices(
    visibleGroundPolygon(level, 0, 150, 100),
    [{ x: 1, z: 50 - 2 / tan }, { x: -1, z: 50 - 2 / tan }, { x: 0.5 * tan * 100, z: -50 }, { x: -0.5 * tan * 100, z: -50 }],
    1e-9,
    'far plane 100 m',
  )
  // A far plane nearer than the nearest ground, 4.289 m ahead, leaves nothing.
  assert.deepEqual(visibleGroundPolygon(level, 0, 150, 4), [])
  assertVertices(
    visibleGroundPolygon(level, 0, 150, 4.3),
    [{ x: 1, z: 50 - 2 / tan }, { x: -1, z: 50 - 2 / tan }, { x: 0.5 * tan * 4.3, z: 50 - 4.3 }, { x: -0.5 * tan * 4.3, z: 50 - 4.3 }],
    1e-9,
    'a sliver of the wedge, as far as 4.3 m',
  )
  // Straight down every point of the ground is as deep as the camera is high: a far plane either side of that is all or nothing.
  const down = looksDown({ x: 0, y: 100, z: 0 })
  assert.equal(visibleGroundPolygon(down, 0, 150, 100.001).length, 4)
  assert.deepEqual(visibleGroundPolygon(down, 0, 150, 99.999), [])
  // Left out, it is as before; a far plane that is not one is no camera.
  assert.equal(visibleGroundPolygon(down, 0, 150, undefined).length, 4)
  for (const far of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.deepEqual(visibleGroundPolygon(down, 0, 150, far), [], `far ${far}`)
})

test('visible ground: a window of half a metre and a far plane of half a metre are a window and a plane, and not invalid', () => {
  assertVertices(
    visibleGroundPolygon(looksDown({ x: 0, y: 100, z: 0 }), 0, 0.5),
    [{ x: 0.5, z: 0.5 }, { x: 0.5, z: -0.5 }, { x: -0.5, z: 0.5 }, { x: -0.5, z: -0.5 }],
    1e-12,
    'a window of 1 m',
  )
  // 0.3 m up the ground is 0.3 m deep, inside a far plane of 0.5 m: the picture is 0.5 tan 25 x 0.3 = 0.07 m either side across and 0.14 m along.
  const tan = Math.tan(25 * DEG)
  assertVertices(
    visibleGroundPolygon(looksDown({ x: 0, y: 0.3, z: 0 }), 0, 150, 0.5),
    [{ x: 0.5 * tan * 0.3, z: tan * 0.3 }, { x: 0.5 * tan * 0.3, z: -tan * 0.3 }, { x: -0.5 * tan * 0.3, z: tan * 0.3 }, { x: -0.5 * tan * 0.3, z: -tan * 0.3 }],
    1e-12,
    'a camera 0.3 m up under a far plane of 0.5 m',
  )
})

test('visible ground agrees with three.js on twenty-five random cameras with a far plane: inside the polygon is in the picture and nearer than it, outside is not', () => {
  const rand = rng(88)
  let inside = 0
  let cutByFar = 0
  for (let c = 0; c < 25; c++) {
    const camera = cameraAt(
      { x: (rand() - 0.5) * 200, y: 1 + rand() * 100, z: (rand() - 0.5) * 200 },
      -90 + rand() * 90,
      rand() * 360,
      40 + rand() * 40,
      0.5 + rand() * 1.3,
      (rand() - 0.5) * 30,
    )
    const half = 150
    const far = 30 + rand() * 250
    const poly = visibleGroundPolygon(camera, 0, half, far)
    const unlimited = visibleGroundPolygon(camera, 0, half)
    for (let i = 0; i < 1500; i++) {
      const x = (rand() * 2 - 1) * half
      const z = (rand() * 2 - 1) * half
      const n = ndcOf(camera, { x, y: 0, z })
      const margin = Math.min(1 - Math.max(Math.abs(n.x), Math.abs(n.y)), far - n.depth)
      if (n.ahead && Math.abs(margin) < 1e-6) continue
      const seen = n.ahead && margin > 0
      assert.equal(poly.length > 0 && insideConvex(poly, x, z), seen, `camera ${c}: (${x.toFixed(2)}, ${z.toFixed(2)}) depth ${n.depth.toFixed(2)} of ${far.toFixed(2)}`)
      if (seen) inside++
      if (unlimited.length > 0 && insideConvex(unlimited, x, z) && !seen) cutByFar++
    }
    // Every vertex is in front of the camera, no deeper than the far plane, and on the edge of the picture, of the window or of the far plane.
    for (const v of poly) {
      const n = ndcOf(camera, { x: v.x, y: 0, z: v.z })
      assert.ok(n.ahead && n.depth <= far + 1e-9, `camera ${c}: a vertex is behind the camera or past the far plane`)
      assert.ok(Math.max(Math.abs(n.x), Math.abs(n.y)) <= 1 + 1e-9, `camera ${c}: a vertex is outside the picture`)
      const onWindow = Math.abs(Math.abs(v.x) - half) < 1e-9 || Math.abs(Math.abs(v.z) - half) < 1e-9
      const onFar = Math.abs(n.depth - far) < 1e-7
      const onPicture = Math.abs(Math.max(Math.abs(n.x), Math.abs(n.y)) - 1) < 1e-9
      assert.ok(onWindow || onFar || onPicture, `camera ${c}: a vertex is on no edge`)
    }
  }
  assert.ok(inside > 1500, `${inside} points seen`)
  assert.ok(cutByFar > 1000, `the far plane cut ${cutByFar} points the unlimited view had, so the test means something`)
})

test('visible ground: a diamond picture that cuts one corner of the window is a triangle, three vertices of an exact polygon and not nothing', () => {
  // A square picture turned 45 degrees is a diamond with its tips on the axes. Over (150, 150) with a half-diagonal of 120 m it
  // reaches the window's corner (100, 100) by 20 m along each side: |x - 150| + |z - 150| <= 120 with x, z <= 100 is x + z >= 180.
  const height = 120 / (Math.SQRT2 * Math.tan(25 * DEG))
  const camera = cameraAt({ x: 150, y: height, z: 150 }, -90, 45, 50, 1)
  assertVertices(visibleGroundPolygon(camera, 0, 100), [{ x: 100, z: 100 }, { x: 100, z: 80 }, { x: 80, z: 100 }], 1e-9, 'triangle')
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 100, ...VIEW })
  assert.equal(sel.emptyReason, null)
  assert.ok(sel.tiles.length >= 1, `${sel.tiles.length} tiles`)
  assertSeesWhatTheOracleSees(LONDON, camera, sel, 100, 'triangle')
})

// ─── Which tiles to ask for ────────────────────────────────────────────────

const VIEW = { viewportHeightPx: 800, minZoom: 15, maxZoom: 19 }

function centreDistance(frame: MapPlaneFrame, camera: RayCamera, tile: TileId): number {
  const [a, , c] = tileCornersScene(tile, frame)
  return Math.hypot((a.x + c.x) / 2 - camera.position.x, (a.y + c.y) / 2 - camera.position.y, (a.z + c.z) / 2 - camera.position.z)
}

test('select: straight down 100 m over the origin it asks for the six z19 tiles under its 47 m by 93 m picture, the one under the camera first', () => {
  const camera = looksDown({ x: 0, y: 100, z: 0 })
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 150, ...VIEW })
  assert.equal(sel.zoom, 19)
  assert.equal(sel.truncated, false)
  assert.equal(sel.tiles.length, 6)
  assertSeesWhatTheOracleSees(LONDON, camera, sel, 150, 'six tiles')
  assert.deepEqual(sel.tiles[0], { z: 19, x: 261998, y: 174356 })
  for (let i = 1; i < sel.tiles.length; i++) {
    assert.ok(centreDistance(LONDON, camera, sel.tiles[i]!) >= centreDistance(LONDON, camera, sel.tiles[i - 1]!) - 1e-9, `tile ${i} is nearer than tile ${i - 1}`)
  }
})

test('select: the zoom is the one for the nearest ground in the picture: straight down that is the point under the camera, level it is where the lowest ray lands', () => {
  // Over the picture. At 0.683 of the distance where z18 is exact the exact zoom is 18.55, which rounds to 19; at 0.732 of it, 18.45, which rounds to 18.
  // Measuring to the edge of the picture and not to the point under the camera would add 10 % to the distance and push the first to 18.
  const d18 = distanceForZoom(51.5, 50, 800, 18)
  const near19 = looksDown({ x: 0, y: d18 * 2 ** -0.55, z: 0 }, 50, 1)
  const near18 = looksDown({ x: 0, y: d18 * 2 ** -0.45, z: 0 }, 50, 1)
  const wide = { frame: LONDON, radiusM: 150, viewportHeightPx: 800, minZoom: 15, maxZoom: 22 }
  assert.equal(selectVisibleTiles({ ...wide, camera: near19 }).zoom, 19)
  assert.equal(selectVisibleTiles({ ...wide, camera: near18 }).zoom, 18)
  // Level, 30 m up and 100 m south of the origin looking north, fov 50: the lowest ray is 25 degrees down and lands 30 / tan 25 = 64.3 m
  // away, 30 / sin 25 = 71.0 m from the camera, and the ground it shows runs from there to the far edge of the 60 m window.
  const level = cameraAt({ x: 0, y: 30, z: 100 }, 0, 0, 50, 0.5)
  const nearest = 30 / Math.sin(25 * DEG)
  const exact = 19 + Math.log2(distanceForZoom(51.5, 50, 800, 19) / nearest)
  const sel = selectVisibleTiles({ frame: LONDON, camera: level, radiusM: 60, viewportHeightPx: 800, minZoom: 15, maxZoom: 22 })
  assert.equal(sel.zoom, Math.round(exact), `exact zoom ${exact}`)
  assert.ok(Math.abs(exact - Math.round(exact)) > 0.05, 'not a rounding coin toss')
  assert.ok(sel.tiles.length > 0 && !sel.truncated)
  // Measured to the camera's height alone the same view would ask for 30 / 71.0 of the distance: 1.24 zooms finer.
  assert.ok(Math.round(19 + Math.log2(distanceForZoom(51.5, 50, 800, 19) / 30)) > sel.zoom)
})

test('select: the higher the camera, the coarser the zoom', () => {
  // The nearest ground is the point under the camera, 400 m down at 400 m: a screen pixel (2 * 400 * tan 25 / 800 = 0.466 m) is
  // log2(24.9e6 / (256 * 0.466)) = 17.67 tile pixels' zoom, so z18; at 1500 m it is 15.77, z16; under 100 m it asks for z20 and
  // the provider stops at 19.
  const zooms = [20, 60, 100, 200, 400, 1500].map((h) => (
    selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: h, z: 0 }), radiusM: 150, ...VIEW }).zoom
  ))
  assert.deepEqual(zooms, [19, 19, 19, 19, 18, 16])
})

/**
 * A square picture turned 45 degrees is a diamond with its tips on the axes. Its east tip is put one metre short of the
 * west edge of the next tile east, which spans the tip's row: no edge of the diamond separates that tile from it, only
 * the tile's own west edge does.
 */
const NEXT_TILE_EAST = { z: 19, x: 261999, y: 174356 }
const DIAMOND_HEIGHT_M = (tileCornersScene(NEXT_TILE_EAST, LONDON)[0].x - 1) / (Math.SQRT2 * Math.tan(25 * DEG))

const SCENARIOS: Array<{ name: string; frame: MapPlaneFrame; camera: RayCamera; radiusM: number; planeY?: number; far?: number }> = [
  { name: 'a square picture turned 45 degrees, its tip a metre short of the next tile', frame: LONDON, camera: cameraAt({ x: 0, y: DIAMOND_HEIGHT_M, z: 0 }, -90, 45, 50, 1), radiusM: 150 },
  { name: 'straight down, off centre', frame: LONDON, camera: looksDown({ x: 30, y: 100, z: -20 }), radiusM: 150 },
  { name: 'level, 3 m up, looking north, a wide window', frame: LONDON, camera: cameraAt({ x: 0, y: 3, z: 0 }, 0, 0, 60, 0.75), radiusM: 300 },
  { name: 'oblique, 30 m up, 20 degrees down, turned right 45 degrees, landscape', frame: LONDON, camera: cameraAt({ x: 0, y: 30, z: 0 }, -20, -45, 60, 1.5), radiusM: 400 },
  { name: 'a frame turned 33 degrees, straight down', frame: { origin: LONDON.origin, zAxisBearingDeg: 33 }, camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150 },
  { name: 'a frame turned 100 degrees, oblique', frame: { origin: LONDON.origin, zAxisBearingDeg: 100 }, camera: cameraAt({ x: 10, y: 40, z: -20 }, -35, 70, 55, 0.8), radiusM: 200 },
  { name: 'the southern hemisphere, oblique', frame: SYDNEY, camera: cameraAt({ x: 5, y: 25, z: 5 }, -50, 200, 60, 0.6), radiusM: 150 },
  { name: 'a plane raised 50 m, for an upper floor', frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150, planeY: 50 },
  { name: 'a camera far above a small window', frame: LONDON, camera: looksDown({ x: 10, y: 400, z: -5 }), radiusM: 50 },
  {
    // Found by random search: the tile 19/262000/174357 lies next to this picture with none of itself in view, and an overlap test
    // that leaves out the first edge of each polygon asks for it.
    name: 'a pose that is turned right round, next to a tile that shows none of itself',
    frame: LONDON,
    camera: { position: { x: -32, y: 113, z: -92 }, rotation: { x: -0.003043, y: 0.996615, z: 0.06969, w: 0.043513 }, fovYDeg: 58, aspect: 1.2 },
    radiusM: 100,
  },
  { name: 'a far plane 120 m out on a camera pitched 40 degrees down', frame: LONDON, camera: cameraAt({ x: -20, y: 60, z: 80 }, -40, 20, 60, 1.2), radiusM: 250, far: 120 },
]

for (const s of SCENARIOS) {
  test(`select: the tiles are the tiles an independent oracle sees, none extra and none missing: ${s.name}`, () => {
    const sel = selectVisibleTiles({ frame: s.frame, camera: s.camera, radiusM: s.radiusM, planeY: s.planeY, farM: s.far, ...VIEW })
    assert.equal(sel.truncated, false)
    assert.ok(sel.tiles.length > 0 && sel.tiles.length <= MAP_PLANE_MAX_TILES, `${sel.tiles.length} tiles`)
    assertSeesWhatTheOracleSees(s.frame, s.camera, sel, s.radiusM, s.name, s.planeY ?? 0, s.far)
  })
}

test('select: the tile whose west edge is a metre beyond the east tip of a turned picture is not asked for, and the one under the tip is', () => {
  const camera = cameraAt({ x: 0, y: DIAMOND_HEIGHT_M, z: 0 }, -90, 45, 50, 1)
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 150, ...VIEW })
  assert.equal(sel.zoom, 19)
  const named = sel.tiles.map(keyOf)
  assert.ok(!named.includes(keyOf(NEXT_TILE_EAST)), `${named.join(' ')}`)
  assert.ok(named.includes(keyOf({ z: 19, x: 261998, y: 174356 })), 'the tile under the camera, which holds the tip')
  // The tip is where the picture ends: the diamond reaches 1 m short of the edge, to the metre.
  const polygon = visibleGroundPolygon(camera, 0, 150)
  near(Math.max(...polygon.map((v) => v.x)), tileCornersScene(NEXT_TILE_EAST, LONDON)[0].x - 1, 1e-9, 'east tip')
})

test('select: a view that would need more than 64 tiles at the zoom its distance asks for is given the next zoom out, and no coarser than that', () => {
  // 3 m up, level, looking north over a 500 m window: the nearest ground is 6 m away, which asks for finer than the provider's z19, and z19 shows more than 64 tiles.
  const camera = cameraAt({ x: 0, y: 3, z: 0 }, 0, 0, 60, 0.75)
  const finer = oracleCount(LONDON, camera, 19, 500)
  const coarser = oracleCount(LONDON, camera, 18, 500)
  assert.ok(finer > MAP_PLANE_MAX_TILES, `z19 shows ${finer} tiles`)
  assert.ok(coarser <= MAP_PLANE_MAX_TILES, `z18 shows ${coarser} tiles`)
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 500, ...VIEW })
  assert.equal(sel.zoom, 18)
  assert.equal(sel.truncated, false)
  assert.equal(sel.tiles.length, coarser)
  assertSeesWhatTheOracleSees(LONDON, camera, sel, 500, 'cap')
})

test('select: at the coarsest zoom the provider has, the 64 nearest tiles are kept and the answer says it is partial', () => {
  const camera = cameraAt({ x: 0, y: 3, z: 0 }, 0, 0, 60, 0.75)
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 500, viewportHeightPx: 800, minZoom: 19, maxZoom: 19 })
  assert.equal(sel.zoom, 19)
  assert.equal(sel.truncated, true)
  assert.equal(sel.tiles.length, MAP_PLANE_MAX_TILES)
  // The nearest 64 of what the oracle sees.
  const seen = tilesAround(LONDON, 19, 500)
    .filter((t) => visibleAreaM2(tileCornersScene(t, LONDON), camera, 500) >= CLEARLY_VISIBLE_M2)
    .map((t) => ({ t, d: centreDistance(LONDON, camera, t) }))
    .sort((a, b) => a.d - b.d)
  assert.ok(seen.length > MAP_PLANE_MAX_TILES)
  const kept = new Set(sel.tiles.map(keyOf))
  const farthestKept = Math.max(...sel.tiles.map((t) => centreDistance(LONDON, camera, t)))
  for (const { t, d } of seen) {
    if (kept.has(keyOf(t))) continue
    assert.ok(d >= farthestKept - 1e-3, `tile ${keyOf(t)} at ${d} m was left out for one at ${farthestKept} m`)
  }
  for (let i = 1; i < sel.tiles.length; i++) {
    assert.ok(centreDistance(LONDON, camera, sel.tiles[i]!) >= centreDistance(LONDON, camera, sel.tiles[i - 1]!) - 1e-9, 'nearest first')
  }
})

test('select: maxTiles asks for fewer, never more than 64', () => {
  const six = looksDown({ x: 0, y: 100, z: 0 })
  const few = selectVisibleTiles({ frame: LONDON, camera: six, radiusM: 150, viewportHeightPx: 800, minZoom: 19, maxZoom: 19, maxTiles: 3 })
  assert.equal(few.tiles.length, 3)
  assert.equal(few.truncated, true)
  const all = selectVisibleTiles({ frame: LONDON, camera: six, radiusM: 150, viewportHeightPx: 800, minZoom: 19, maxZoom: 19 })
  assert.deepEqual(few.tiles, all.tiles.slice(0, 3), 'the three nearest')
  // Coarser instead of partial when a coarser zoom fits.
  const coarser = selectVisibleTiles({ frame: LONDON, camera: six, radiusM: 150, viewportHeightPx: 800, minZoom: 15, maxZoom: 19, maxTiles: 3 })
  assert.ok(coarser.zoom < 19 && coarser.tiles.length <= 3 && coarser.tiles.length > 0, `${coarser.zoom}, ${coarser.tiles.length}`)
  // A bigger ask than 64 is 64.
  const wide = cameraAt({ x: 0, y: 3, z: 0 }, 0, 0, 60, 0.75)
  const many = selectVisibleTiles({ frame: LONDON, camera: wide, radiusM: 500, viewportHeightPx: 800, minZoom: 19, maxZoom: 19, maxTiles: 1000 })
  assert.equal(many.tiles.length, 64)
  assert.equal(many.truncated, true)
})

test('select: a view that shows none of the window asks for nothing at all: no neighbours, no parent tile, no tile for where the camera might turn', () => {
  const none = { zoom: 15, tiles: [], truncated: false, emptyReason: 'nothing-in-view' }
  assert.deepEqual(selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 300 }), radiusM: 150, ...VIEW }), none, 'over ground beyond the window')
  assert.deepEqual(selectVisibleTiles({ frame: LONDON, camera: cameraAt({ x: 0, y: 5, z: 0 }, 30, 0), radiusM: 150, ...VIEW }), none, 'looking at the sky')
  assert.deepEqual(selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: -2, z: 0 }), radiusM: 150, ...VIEW }), none, 'below the plane')
  assert.deepEqual(selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150, planeY: 100, ...VIEW }), none, 'the plane at the camera')
  assert.deepEqual(selectVisibleTiles({ frame: LONDON, camera: cameraAt({ x: 0, y: 2, z: 200 }, 0, 180, 50, 0.5), radiusM: 150, ...VIEW }), none, 'looking away')
})

test('select: no tile is coarser than z14, however far away the camera is or whatever the provider offers', () => {
  // 300 km up the nearest ground asks for z8, and a provider that starts at z0 would give it: a z8 tile is 97 km across, its flat quad nowhere near the ground.
  const camera = looksDown({ x: 0, y: 300_000, z: 0 }, 50, 1)
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 150, viewportHeightPx: 800, minZoom: 0, maxZoom: 19 })
  assert.equal(sel.zoom, MAP_PLANE_COARSEST_ZOOM)
  assert.equal(sel.truncated, false)
  assert.ok(sel.tiles.length >= 1 && sel.tiles.length <= 4, `${sel.tiles.length} tiles`)
  assertSeesWhatTheOracleSees(LONDON, camera, sel, 150, 'far above')
  // The same camera over a provider whose coarsest zoom is finer than z14 gets that one.
  assert.equal(selectVisibleTiles({ frame: LONDON, camera, radiusM: 150, viewportHeightPx: 800, minZoom: 16, maxZoom: 19 }).zoom, 16)
  // A camera that sees none of the window is told the coarsest zoom in use, not the provider's z0.
  const away = selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 900 }), radiusM: 150, viewportHeightPx: 800, minZoom: 0, maxZoom: 19 })
  assert.deepEqual(away, { zoom: MAP_PLANE_COARSEST_ZOOM, tiles: [], truncated: false, emptyReason: 'nothing-in-view' })
})

test('select: a provider with nothing finer than z13 gives no plane at all', () => {
  const sel = selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150, viewportHeightPx: 800, minZoom: 0, maxZoom: 13 })
  assert.deepEqual(sel, { zoom: 0, tiles: [], truncated: false, emptyReason: 'zoom-range' })
  assert.equal(selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150, viewportHeightPx: 800, minZoom: 0, maxZoom: 14 }).zoom, 14)
})

test('select: a picture inside one tile asks for that tile and no other', () => {
  const sel = selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: 20, z: 0 }), radiusM: 150, ...VIEW })
  assert.deepEqual(sel, { zoom: 19, tiles: [{ z: 19, x: 261998, y: 174356 }], truncated: false, emptyReason: null })
})

/** Where a tile's centre is, from the tile's own centre coordinates and not from its corners, which are where the module takes it from. */
function centreDistanceFromCentre(frame: MapPlaneFrame, camera: RayCamera, t: TileId): number {
  const c = tilePointLatLng(t.z, t.x + 0.5, t.y + 0.5)
  const p = latLngToScene(frame, c.lat, c.lng)
  return Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z)
}

/** Nearest first, to within 0.1 m: the centre of a quad and the centre of its tile part by up to 57 mm at z14. */
function assertNearestFirst(frame: MapPlaneFrame, camera: RayCamera, tiles: readonly TileId[], label: string): void {
  for (let i = 1; i < tiles.length; i++) {
    const before = centreDistanceFromCentre(frame, camera, tiles[i - 1]!)
    const after = centreDistanceFromCentre(frame, camera, tiles[i]!)
    assert.ok(after >= before - 0.1, `${label}: tile ${i} is ${after} m from the camera, nearer than tile ${i - 1} at ${before} m`)
  }
}

test('select: a view that needs exactly 64 tiles gets them, and one that needs more gets the nearest 64 and is called partial', () => {
  // A square picture 500 m up that sees the whole window, at z19 only. A window of half-side 165 m meets 8 columns and 8 rows of
  // tiles, and one of 170 m a ninth row (counted from the corners of the window and by the oracle).
  const camera = looksDown({ x: 0, y: 500, z: 0 }, 90, 1)
  const at = (radiusM: number) => ({ frame: LONDON, camera, radiusM, viewportHeightPx: 800, minZoom: 19, maxZoom: 19 })
  assert.equal(oracleCount(LONDON, camera, 19, 165), MAP_PLANE_MAX_TILES)
  const exactly = selectVisibleTiles(at(165))
  assert.equal(exactly.tiles.length, MAP_PLANE_MAX_TILES)
  assert.equal(exactly.truncated, false, 'exactly the cap is not more than the cap')
  assert.equal(exactly.emptyReason, null)
  assertSeesWhatTheOracleSees(LONDON, camera, exactly, 165, 'exactly 64')
  assert.ok(oracleCount(LONDON, camera, 19, 170) > MAP_PLANE_MAX_TILES)
  const more = selectVisibleTiles(at(170))
  assert.equal(more.tiles.length, MAP_PLANE_MAX_TILES)
  assert.equal(more.truncated, true)
  assertNearestFirst(LONDON, camera, more.tiles, 'cut at 64')
})

test('select: maxTiles equal to the tiles the view needs gets them all and is not called partial; one fewer is', () => {
  const camera = looksDown({ x: 0, y: 100, z: 0 })
  const base = { frame: LONDON, camera, radiusM: 150, viewportHeightPx: 800, minZoom: 19, maxZoom: 19 }
  const all = selectVisibleTiles(base)
  assert.equal(all.tiles.length, 6)
  assert.deepEqual(selectVisibleTiles({ ...base, maxTiles: 6 }), all, 'six of six')
  assert.deepEqual(selectVisibleTiles({ ...base, maxTiles: 7 }), all, 'six of seven')
  const five = selectVisibleTiles({ ...base, maxTiles: 5 })
  assert.equal(five.truncated, true)
  assert.deepEqual(five.tiles, all.tiles.slice(0, 5))
  assert.equal(five.emptyReason, null)
})

test('select: the zoom is asked for by the straight-line distance to the nearest ground shown, not by the horizontal distance and the height added up', () => {
  // 95 m up, pitched 15 degrees down, a 60 degree lens: the lowest ray is 45 degrees down and lands 95 m ahead, 95 / sin 45 = 134.35 m from
  // the camera. Horizontal and height added up are 190 m, a whole half zoom further.
  const camera = cameraAt({ x: 0, y: 95, z: 0 }, -15, 0, 60, 0.5625)
  const nearest = nearestShownGroundM(camera, 150)!
  near(nearest, 95 * Math.SQRT2, 1e-9, 'nearest ground by three.js')
  const straight = zoomAskedFor(nearest, 51.5, 60, 800, 15, 22)
  const added = zoomAskedFor(190, 51.5, 60, 800, 15, 22)
  assert.equal(straight.zoom, 19)
  assert.equal(added.zoom, 18, 'the sum would be a zoom coarser')
  assert.ok(Math.abs(straight.exact - 18.94) < 0.01 && Math.abs(Math.abs(straight.exact % 1) - 0.5) > 0.3, `exact ${straight.exact}: not a rounding coin toss`)
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 150, viewportHeightPx: 800, minZoom: 15, maxZoom: 22 })
  assert.equal(sel.zoom, 19)
  assert.equal(sel.tiles.length, oracleCount(LONDON, camera, 19, 150))
  assertSeesWhatTheOracleSees(LONDON, camera, sel, 150, 'oblique, 95 m up')
})

test('select: the zoom is asked for by the distance to the plane, so a plane raised under the camera asks for a finer one', () => {
  // 40 m up and pitched 60 degrees down with a 60 degree lens, the lowest ray is vertical, so the nearest ground is the point under the
  // camera: 40 m away over a plane at the floor, 20 m over one raised to 20 m, which is a whole zoom finer.
  const camera = cameraAt({ x: 0, y: 40, z: 0 }, -60, 0, 60, 0.5625)
  const raised = { frame: LONDON, camera, radiusM: 60, viewportHeightPx: 800, minZoom: 15, maxZoom: 22, planeY: 20 }
  const nearestRaised = nearestShownGroundM(camera, 60, 20)!
  const nearestFloor = nearestShownGroundM(camera, 60, 0)!
  near(nearestRaised, 20, 1e-9)
  near(nearestFloor, 40, 1e-9)
  const askedRaised = zoomAskedFor(nearestRaised, 51.5, 60, 800, 15, 22)
  const askedFloor = zoomAskedFor(nearestFloor, 51.5, 60, 800, 15, 22)
  assert.equal(askedRaised.zoom, 22)
  assert.equal(askedFloor.zoom, 21)
  assert.ok(Math.abs(Math.abs(askedRaised.exact % 1) - 0.5) > 0.1 && Math.abs(Math.abs(askedFloor.exact % 1) - 0.5) > 0.1, 'neither is a rounding coin toss')
  const sel = selectVisibleTiles(raised)
  assert.equal(sel.zoom, 22)
  assert.equal(sel.tiles.length, oracleCount(LONDON, camera, 22, 60, 20))
  assertSeesWhatTheOracleSees(LONDON, camera, sel, 60, 'raised plane', 20)
  assert.equal(selectVisibleTiles({ ...raised, planeY: 0 }).zoom, 21, 'the same camera over a plane at the floor')
})

test('select: nearest first is nearest to the camera wherever the camera is, and a cut keeps the tiles nearest to it', () => {
  const camera = looksDown({ x: 60, y: 100, z: -40 }, 50, 1)
  const base = { frame: LONDON, camera, radiusM: 150, viewportHeightPx: 800, minZoom: 19, maxZoom: 19 }
  const sel = selectVisibleTiles(base)
  assert.ok(sel.tiles.length > 8, `${sel.tiles.length} tiles`)
  const under = sceneToLatLng(LONDON, 60, -40)
  assert.deepEqual(sel.tiles[0], latLngToTile(under.lat, under.lng, 19), 'the tile under the camera first, not the one under the origin')
  assertNearestFirst(LONDON, camera, sel.tiles, 'off the origin')
  const cut = selectVisibleTiles({ ...base, maxTiles: 3 })
  assert.deepEqual(cut.tiles, sel.tiles.slice(0, 3))
  // A camera on the other side of the origin, higher and looking down at an angle.
  const other = cameraAt({ x: -45, y: 60, z: 35 }, -50, 120, 55, 0.8)
  const second = selectVisibleTiles({ ...base, camera: other })
  assert.ok(second.tiles.length > 5)
  assertNearestFirst(LONDON, other, second.tiles, 'another camera')
})

test('select: the editor\'s 800 m far plane: tiles that lie only beyond it are not asked for, and the zoom is the finer one the rest allows', () => {
  // The editor camera (src/viewer/viewer.ts) is far = 800. From 700 m south of the origin, 40 m up, pitched 8 degrees down with a
  // 60 degree lens and a 1200 m window, the unlimited view reaches 1.9 km north and asks for tiles the camera clips.
  const camera = cameraAt({ x: 0, y: 40, z: 700 }, -8, 0, 60, 1.6)
  const base = { frame: LONDON, camera, radiusM: 1200, viewportHeightPx: 900, minZoom: 15, maxZoom: 19 }
  const unlimited = selectVisibleTiles(base)
  const limited = selectVisibleTiles({ ...base, farM: 800 })
  assert.equal(limited.emptyReason, null)
  const planes = viewPlanes(camera, 1200, 800)
  const wasted = unlimited.tiles.filter((t) => areaWithin(planes, tileCornersScene(t, LONDON)) <= 1e-9).length
  assert.ok(wasted >= unlimited.tiles.length / 2, `${wasted} of the ${unlimited.tiles.length} tiles of the unlimited view show nothing once the far plane is applied`)
  assert.ok(limited.zoom > unlimited.zoom, `z${limited.zoom} against z${unlimited.zoom}`)
  assertSeesWhatTheOracleSees(LONDON, camera, limited, 1200, 'far 800', 0, 800)
  // A far plane nearer than the nearest ground leaves nothing in view.
  const nothing = selectVisibleTiles({ ...base, farM: 30 })
  assert.deepEqual(nothing.tiles, [])
  assert.equal(nothing.emptyReason, 'nothing-in-view')
})

test('select: across the antimeridian the tiles on both sides are asked for, named by their wrapped column, and placed where they are', () => {
  // 22 m west of the antimeridian at 10 N, looking straight down from 100 m with a square picture 93 m across: the picture runs 25 m past it.
  const frame: MapPlaneFrame = { origin: { lat: 10, lng: 179.9998, altitudeM: 0 } }
  const camera = looksDown({ x: 0, y: 100, z: 0 }, 50, 1)
  const sel = selectVisibleTiles({ frame, camera, radiusM: 150, ...VIEW })
  assert.equal(sel.zoom, 19)
  const n = 2 ** 19
  assert.ok(sel.tiles.some((t) => t.x === n - 1) && sel.tiles.some((t) => t.x === 0), JSON.stringify(sel.tiles))
  assert.ok(sel.tiles.every((t) => t.x >= 0 && t.x < n))
  // The column 0 tile is east of the origin, across the line, not 40 000 km away.
  const [corner] = tileCornersScene(sel.tiles.find((t) => t.x === 0)!, frame)
  assert.ok(corner.x > 15 && corner.x < 30, `${corner.x}`)
  assertSeesWhatTheOracleSees(frame, camera, sel, 150, 'antimeridian')
})

test('select: a picture too big for the provider zoom to examine is reported as partial and not walked', () => {
  // 2 km up with a square picture 1.9 km across, at z22 (6 m tiles): 314 x 315 = 98 910 candidates, past the 4096 the module will examine.
  const sel = selectVisibleTiles({
    frame: LONDON,
    camera: looksDown({ x: 0, y: 2000, z: 0 }, 50, 1),
    radiusM: 2000,
    viewportHeightPx: 800,
    minZoom: 22,
    maxZoom: 22,
  })
  assert.deepEqual(sel, { zoom: 22, tiles: [], truncated: true, emptyReason: 'too-large' })
  assert.equal(MAX_SCANNED_TILES_PER_ZOOM, 4096)
})

/** How many candidate tiles a window of half-side `radiusM` spans at one zoom, counted from its four corners: columns x rows of the tile grid. */
function candidateGrid(frame: MapPlaneFrame, radiusM: number, z: number): number {
  const fractions = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const ll = sceneToLatLng(frame, sx! * radiusM, sz! * radiusM)
    return latLngToTileFraction(ll.lat, ll.lng, z)!
  })
  const span = (axis: 'x' | 'y'): number => Math.floor(Math.max(...fractions.map((f) => f[axis]))) - Math.floor(Math.min(...fractions.map((f) => f[axis]))) + 1
  return span('x') * span('y')
}

test('select: a view whose tile grid is exactly 4096 candidates is examined, and one of 4160 is too large to be', () => {
  // A picture 20 km up that sees the whole window, at z19 only. At 51.5 N a window of half-side 1498 m spans 64 columns and 64 rows of
  // tiles, and one of 1503 m 64 columns and 65 rows: counted from the corners of the window by the tile fraction, which the scan does not use.
  assert.equal(MAX_SCANNED_TILES_PER_ZOOM, 64 * 64)
  assert.equal(candidateGrid(LONDON, 1498, 19), 4096)
  assert.equal(candidateGrid(LONDON, 1503, 19), 4160)
  const camera = looksDown({ x: 0, y: 20_000, z: 0 }, 90, 1)
  const at = (radiusM: number) => selectVisibleTiles({ frame: LONDON, camera, radiusM, viewportHeightPx: 800, minZoom: 19, maxZoom: 19 })
  const examined = at(1498)
  assert.equal(examined.emptyReason, null)
  assert.equal(examined.truncated, true, 'more than the cap of 64 are in view, so it is partial')
  assert.equal(examined.tiles.length, MAP_PLANE_MAX_TILES)
  assertNearestFirst(LONDON, camera, examined.tiles, 'a window of 3 km')
  assert.deepEqual(at(1503), { zoom: 19, tiles: [], truncated: true, emptyReason: 'too-large' })
})

test('select: against the north and south limits of the square the end rows are used, a picture across the limit has the tiles inside it, and one beyond it has none', () => {
  const n = 2 ** 18
  for (const [name, row, towards] of [['north', 0, -1], ['south', n - 1, 1]] as const) {
    // The middle of the end row at z18, 6.6 m from the limit. A square picture 15 m up with a 40 degree lens is 11 m across: inside the row.
    const middle = tilePointLatLng(18, 138_000.5, row + 0.5)
    const frame: MapPlaneFrame = { origin: { lat: middle.lat, lng: middle.lng, altitudeM: 0 } }
    const base = { frame, viewportHeightPx: 800, minZoom: 18, maxZoom: 18 }
    const inside = looksDown({ x: 0, y: 15, z: 0 }, 40, 1)
    const within = selectVisibleTiles({ ...base, camera: inside, radiusM: 100 })
    assert.equal(within.emptyReason, null, name)
    assert.ok(within.tiles.length >= 1 && within.tiles.every((t) => t.y === row), `${name}: ${JSON.stringify(within.tiles)}`)
    assertSeesWhatTheOracleSees(frame, inside, within, 100, `${name}, inside the end row`)
    // 25 m up the picture is 18 m across and reaches the limit, 6.6 m off, and 2.4 m past it: the part inside has tiles.
    const across = looksDown({ x: 0, y: 25, z: 0 }, 40, 1)
    const reaching = selectVisibleTiles({ ...base, camera: across, radiusM: 100 })
    assert.equal(reaching.emptyReason, null, `${name}: a picture across the limit`)
    assert.ok(reaching.tiles.some((t) => t.y === row) && reaching.tiles.some((t) => t.y === row - towards), `${name}: ${JSON.stringify(reaching.tiles)}`)
    assertSeesWhatTheOracleSees(frame, across, reaching, 100, `${name}, across the limit`)
    // A camera 15 m towards the pole looking straight down sees only ground beyond the limit, from 3 to 14 m past it: the band a row beyond the end row
    // would hold. There is no tile there, and the answer is nothing in view.
    const beyond = looksDown({ x: 0, y: 15, z: 15 * towards }, 40, 1)
    const none = selectVisibleTiles({ ...base, camera: beyond, radiusM: 100 })
    assert.deepEqual(none, { zoom: 18, tiles: [], truncated: false, emptyReason: 'nothing-in-view' }, `${name}: beyond the limit`)
  }
})

test('select: a plane height left out is 0: a camera 0.5 m up sees a floor at 0, the same as naming it, and is under a plane at 1 m', () => {
  const camera = looksDown({ x: 0, y: 0.5, z: 0 }, 50, 1)
  const base = { frame: LONDON, camera, radiusM: 50, viewportHeightPx: 800, minZoom: 15, maxZoom: 21 }
  const left = selectVisibleTiles(base)
  assert.ok(left.tiles.length > 0, 'the floor is in view')
  assert.deepEqual(selectVisibleTiles({ ...base, planeY: 0 }), left)
  assert.equal(selectVisibleTiles({ ...base, planeY: 1 }).emptyReason, 'nothing-in-view')
})

test('select: straight down over the ground the nearest ground is the height itself, not the height and a step to the edge of the picture', () => {
  // A square picture under a 50 degree lens is 2 tan 25 = 0.93 of the height to a side, however it is turned, and the point under the camera is the
  // height away. The edge of the picture is 1.10 times that, 0.14 of a zoom coarser. Each viewport is made as high as puts the exact zoom for the
  // height at 22.57 less a number of levels, which rounds up, where the edge's would round down. Tiles of 2048 px keep the zoom within a provider's.
  const tilePx = 2048
  const cases: Array<{ height: number; yaw: number; exact: number }> = [
    { height: 2, yaw: 0, exact: 20.57 },
    { height: 2, yaw: 30, exact: 20.57 },
    { height: 0.5, yaw: 30, exact: 22.57 },
    { height: 0.5, yaw: 45, exact: 22.57 },
  ]
  for (const { height, yaw, exact } of cases) {
    const camera = cameraAt({ x: 0, y: height, z: 0 }, -90, yaw, 50, 1)
    const viewportHeightPx = (2 ** (exact - 19) * 2 * height * Math.tan(25 * DEG)) / groundResolutionM(51.5, 19, tilePx)
    const asked = zoomAskedFor(height, 51.5, 50, viewportHeightPx, 15, 24, tilePx)
    near(asked.exact, exact, 1e-9, `height ${height}: exact zoom`)
    const edge = zoomAskedFor(Math.hypot(height * Math.tan(25 * DEG), height), 51.5, 50, viewportHeightPx, 15, 24, tilePx)
    assert.equal(edge.zoom, asked.zoom - 1, `height ${height}: the edge of the picture would be a zoom coarser`)
    const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 5, viewportHeightPx, tilePx, minZoom: 15, maxZoom: 24 })
    assert.equal(sel.zoom, asked.zoom, `height ${height}, yaw ${yaw}`)
    assertSeesWhatTheOracleSees(LONDON, camera, sel, 5, `straight down, ${height} m up, yaw ${yaw}`)
  }
})

test('select: a picture whose near edge is under a metre long: the nearest ground is the middle of that short edge, not its end', () => {
  // 0.5 m up, pitched 30 degrees down, a 50 degree lens and an aspect of 1.2: the lowest ray lands 0.35 m ahead, where the picture is 0.62 m across.
  // The camera is 0.61 m from the middle of that edge and 0.69 m from its ends, which is 0.17 of a zoom coarser. The viewport is made as high as puts
  // the exact zoom for 0.61 m at 22.57 (tiles of 2048 px), which rounds up, where the end of the edge would round down.
  const tilePx = 2048
  const middle = Math.hypot(0.5 / Math.tan(55 * DEG), 0.5)
  const viewportHeightPx = (2 ** (22.57 - 19) * 2 * middle * Math.tan(25 * DEG)) / groundResolutionM(51.5, 19, tilePx)
  const asked = zoomAskedFor(middle, 51.5, 50, viewportHeightPx, 15, 24, tilePx)
  near(asked.exact, 22.57, 1e-9)
  assert.equal(asked.zoom, 23)
  for (const yaw of [0, 90, 215]) {
    const camera = cameraAt({ x: 0, y: 0.5, z: 0 }, -30, yaw, 50, 1.2)
    const polygon = visibleGroundPolygon(camera, 0, 5)
    const edges = polygon.map((p, i) => Math.hypot(polygon[(i + 1) % polygon.length]!.x - p.x, polygon[(i + 1) % polygon.length]!.z - p.z))
    assert.ok(edges.some((e) => e < 0.7), `yaw ${yaw}: the picture has a short edge: ${edges.join(', ')}`)
    near(nearestShownGroundM(camera, 5)!, middle, 1e-9, `yaw ${yaw}: the nearest ground by three.js`)
    const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 5, viewportHeightPx, tilePx, minZoom: 15, maxZoom: 24 })
    assert.equal(sel.zoom, 23, `yaw ${yaw}`)
    assertSeesWhatTheOracleSees(LONDON, camera, sel, 5, `a picture with a short near edge, yaw ${yaw}`)
  }
})

test('select: a picture under a metre across, with a tile corner just off one of its edges, does not ask for the tile that meets only its bounding box', () => {
  // A square picture turned 45 degrees is a diamond. 0.5 m up with a 50 degree lens its half-diagonal is 0.33 m, and its edges are 0.47 m long.
  // The camera is put 0.8 of that short of a corner of four z23 tiles, so the corner is outside the diamond and inside its bounding box: the tile
  // across the corner is a tile no part of the picture shows, and only the diamond's own edges tell it from one that does.
  const home = latLngToTile(51.5, -0.1, 23)!
  const corner = tileCornersScene(home, LONDON)[2]
  const r = 0.5 * Math.tan(25 * DEG) * Math.SQRT2
  const camera = cameraAt({ x: corner.x - 0.8 * r, y: 0.5, z: corner.z - 0.8 * r }, -90, 45, 50, 1)
  const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 5, viewportHeightPx: 200, tilePx: 2048, minZoom: 23, maxZoom: 23 })
  const keys = new Set(sel.tiles.map(keyOf))
  assert.deepEqual(keys, new Set([keyOf(home), keyOf({ ...home, x: home.x + 1 }), keyOf({ ...home, y: home.y + 1 })]))
  assert.ok(!keys.has(keyOf({ ...home, x: home.x + 1, y: home.y + 1 })), 'the tile across the corner')
  assertSeesWhatTheOracleSees(LONDON, camera, sel, 5, 'a diamond under a metre across')
})

test('select: the zoom is asked for by the middle of the near edge of the picture, from every side: the nearest ground is the foot of the camera\'s perpendicular on that edge, not the end of it', () => {
  // A level camera 80 m up with a 50 degree lens and an aspect of 2, 300 m from the origin looking at it, whichever way it is turned about it. Its
  // lowest ray lands 171.6 m ahead, so the near edge of the picture is a line across the view that long way off and 320 m long; the camera is
  // 189.3 m from the middle of it and 247.9 m from the ends. A viewport of 365 px asks for zoom 17.62 from 189.3 m, which is z18, and 17.23 from the end: z17.
  const asks = zoomAskedFor(Math.hypot(80 / Math.tan(25 * DEG), 80), 51.5, 50, 365, 15, 22)
  assert.equal(asks.zoom, 18)
  assert.ok(asks.exact > 17.6 && asks.exact < 17.65, `${asks.exact}`)
  assert.equal(zoomAskedFor(Math.hypot(Math.hypot(80 / Math.tan(25 * DEG), 160), 80), 51.5, 50, 365, 15, 22).zoom, 17, 'the end of the edge would be a zoom coarser')
  for (const yaw of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
    const t = yaw * DEG
    const camera = cameraAt({ x: 300 * Math.sin(t), y: 80, z: 300 * Math.cos(t) }, 0, yaw, 50, 2)
    const nearest = nearestShownGroundM(camera, 300)!
    near(nearest, Math.hypot(80 / Math.tan(25 * DEG), 80), 1e-6, `yaw ${yaw}: the nearest ground by three.js`)
    const sel = selectVisibleTiles({ frame: LONDON, camera, radiusM: 300, viewportHeightPx: 365, minZoom: 15, maxZoom: 22 })
    assert.equal(sel.zoom, 18, `yaw ${yaw}`)
    assert.equal(sel.truncated, false, `yaw ${yaw}`)
    assertSeesWhatTheOracleSees(LONDON, camera, sel, 300, `yaw ${yaw}`)
  }
})

const LONGITUDE_MODULE = new URL('../../../src/viewer/map-plane-math.ts', import.meta.url).href

test('select: an origin longitude that is not a longitude is an unusable input at once, and the call returns', () => {
  // A longitude of 1e13 degrees put the tile column past 2^53, where `x++` no longer changes x, and the scan never ended. The call
  // runs in a child process, so a hang is a failed test after 20 s and not a stopped suite.
  const script = `
    import { selectVisibleTiles } from ${JSON.stringify(LONGITUDE_MODULE)}
    const camera = { position: { x: 0, y: 100, z: 0 }, rotation: { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, fovYDeg: 60, aspect: 0.5625 }
    const answers = [1e13, -1e13, 7e12, 1e300, 541, -541, 540, -540, 539.9998].map((lng) => {
      const sel = selectVisibleTiles({ frame: { origin: { lat: 51.5, lng, altitudeM: 0 } }, camera, viewportHeightPx: 1000, radiusM: 150, minZoom: 0, maxZoom: 19 })
      return [lng, sel.emptyReason, sel.tiles.length > 0]
    })
    console.log(JSON.stringify(answers))
  `
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(run.status, 0, `status ${run.status}, signal ${run.signal}: ${run.stderr}`)
  assert.deepEqual(JSON.parse(run.stdout), [
    [1e13, 'unusable-input', false],
    [-1e13, 'unusable-input', false],
    [7e12, 'unusable-input', false],
    [1e300, 'unusable-input', false],
    [541, 'unusable-input', false],
    [-541, 'unusable-input', false],
    [540, null, true],
    [-540, null, true],
    [539.9998, null, true],
  ])
  const base = { camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150, ...VIEW }
  for (const lng of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(selectVisibleTiles({ ...base, frame: { origin: { ...LONDON.origin, lng } } }).emptyReason, 'unusable-input', `lng ${lng}`)
  }
})

test('select: a longitude a turn out names the place it names: the same tiles, in the same order', () => {
  // 22 m west of the antimeridian at 10 N, as in the antimeridian test: the same place at 179.9998, -180.0002 and 539.9998 degrees.
  const camera = looksDown({ x: 0, y: 100, z: 0 }, 50, 1)
  const at = (lng: number) => selectVisibleTiles({ frame: { origin: { lat: 10, lng, altitudeM: 0 } }, camera, radiusM: 150, ...VIEW })
  const home = at(179.9998)
  assert.ok(home.tiles.length >= 4 && home.tiles.some((t) => t.x === 0) && home.tiles.some((t) => t.x === 2 ** 19 - 1), JSON.stringify(home.tiles))
  assert.deepEqual(at(-180.0002), home)
  assert.deepEqual(at(539.9998), home)
  assert.deepEqual(at(-540.0002 + 360), home)
})

test('select: an empty answer says why, and only an empty answer does', () => {
  const down = looksDown({ x: 0, y: 100, z: 0 })
  const base = { frame: LONDON, camera: down, radiusM: 150, ...VIEW }
  const full = selectVisibleTiles(base)
  assert.ok(full.tiles.length > 0)
  assert.equal(full.emptyReason, null)
  const cases: Array<[string, Partial<typeof base> & Record<string, unknown>, string]> = [
    ['over ground beyond the window', { camera: looksDown({ x: 0, y: 100, z: 300 }) }, 'nothing-in-view'],
    ['looking at the sky', { camera: cameraAt({ x: 0, y: 5, z: 0 }, 30, 0) }, 'nothing-in-view'],
    ['below the plane', { camera: looksDown({ x: 0, y: -2, z: 0 }) }, 'nothing-in-view'],
    ['the plane at the camera', { planeY: 100 }, 'nothing-in-view'],
    ['a far plane in front of the ground', { farM: 50 }, 'nothing-in-view'],
    ['a lens that is not one', { camera: { ...down, fovYDeg: 0 } }, 'unusable-input'],
    ['a camera with no rotation', { camera: { ...down, rotation: { x: 0, y: 0, z: 0, w: 0 } } }, 'unusable-input'],
    ['a camera at no number', { camera: { ...down, position: { x: Number.NaN, y: 100, z: 0 } } }, 'unusable-input'],
    ['a window of no size', { radiusM: 0 }, 'unusable-input'],
    ['a frame at the pole', { frame: { origin: { lat: 90, lng: 0, altitudeM: 0 } } }, 'unusable-input'],
    ['a provider whose finest zoom is 13', { minZoom: 0, maxZoom: 13 }, 'zoom-range'],
    ['a provider that offers only z10', { minZoom: 10, maxZoom: 10 }, 'zoom-range'],
  ]
  for (const [what, change, reason] of cases) {
    const sel = selectVisibleTiles({ ...base, ...change })
    assert.deepEqual(sel.tiles, [], what)
    assert.equal(sel.truncated, false, what)
    assert.equal(sel.emptyReason, reason, what)
  }
  // The view too wide for the zoom to examine is empty and partial both, and says it is too large.
  const wide = selectVisibleTiles({ frame: LONDON, camera: looksDown({ x: 0, y: 2000, z: 0 }, 50, 1), radiusM: 2000, viewportHeightPx: 800, minZoom: 22, maxZoom: 22 })
  assert.deepEqual(wide, { zoom: 22, tiles: [], truncated: true, emptyReason: 'too-large' })
  // The reason is null exactly when there are tiles, partial or not.
  const partial = selectVisibleTiles({ ...base, minZoom: 19, maxZoom: 19, maxTiles: 3 })
  assert.equal(partial.truncated, true)
  assert.equal(partial.emptyReason, null)
})

test('select: where the zoom of an empty answer comes from: the coarsest in use for a camera that sees nothing, the provider\'s own for an input that cannot be used', () => {
  const base = { frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150, ...VIEW }
  assert.equal(selectVisibleTiles({ ...base, camera: looksDown({ x: 0, y: 100, z: 300 }), minZoom: 0 }).zoom, MAP_PLANE_COARSEST_ZOOM)
  assert.equal(selectVisibleTiles({ ...base, camera: looksDown({ x: 0, y: 100, z: 300 }), minZoom: 16 }).zoom, 16)
  assert.equal(selectVisibleTiles({ ...base, radiusM: 0, minZoom: 3 }).zoom, 3)
  assert.equal(selectVisibleTiles({ ...base, minZoom: 0, maxZoom: 13 }).zoom, 0)
  // A minimum that is not a zoom is not echoed back: NaN is no zoom, and a caller that asks a tile source for it asks for nothing real.
  for (const minZoom of [Number.NaN, 1.5, -2, 31, Number.POSITIVE_INFINITY]) {
    assert.equal(selectVisibleTiles({ ...base, minZoom }).zoom, MAP_PLANE_COARSEST_ZOOM, `minZoom ${minZoom}`)
  }
})

test('select: an input that is not a camera, a frame or a provider is an empty answer and never throws', () => {
  const base = { frame: LONDON, camera: looksDown({ x: 0, y: 100, z: 0 }), radiusM: 150, ...VIEW }
  assert.equal(selectVisibleTiles(base).tiles.length, 6, 'the control case sees tiles')
  const bads: Array<Record<string, unknown>> = [
    { radiusM: 0 }, { radiusM: -1 }, { radiusM: Number.NaN }, { radiusM: Number.POSITIVE_INFINITY }, { viewportHeightPx: 0 }, { viewportHeightPx: Number.NaN },
    { minZoom: 20 }, { minZoom: 1.5 }, { minZoom: Number.NaN }, { maxZoom: 31 }, { maxZoom: 14 }, { maxZoom: Number.NaN }, { tilePx: 0 }, { tilePx: Number.NaN },
    { planeY: Number.NaN }, { planeY: Number.POSITIVE_INFINITY }, { maxTiles: Number.NaN }, { maxTiles: 0 }, { maxTiles: 0.5 }, { maxTiles: -3 },
    { maxTiles: Number.NEGATIVE_INFINITY }, { farM: 0 }, { farM: -800 }, { farM: Number.NaN }, { farM: Number.POSITIVE_INFINITY },
    { frame: { origin: { lat: 90, lng: 0, altitudeM: 0 } } }, { frame: { origin: { lat: 85.06, lng: 0, altitudeM: 0 } } },
    { frame: { origin: { ...LONDON.origin, lat: Number.NaN } } }, { frame: { origin: { ...LONDON.origin, lng: Number.NaN } } },
    { frame: { origin: { ...LONDON.origin, lng: 541 } } }, { frame: { origin: { ...LONDON.origin, lng: -541 } } },
    { frame: { origin: { ...LONDON.origin, altitudeM: Number.NaN } } }, { frame: { origin: LONDON.origin, zAxisBearingDeg: Number.NaN } },
    { camera: { ...looksDown({ x: 0, y: 100, z: 0 }), fovYDeg: 0 } }, { camera: { ...looksDown({ x: 0, y: 100, z: 0 }), fovYDeg: 180 } },
    { camera: { ...looksDown({ x: 0, y: 100, z: 0 }), aspect: 0 } }, { camera: { ...looksDown({ x: 0, y: 100, z: 0 }), aspect: Number.NaN } },
  ]
  for (const bad of bads) {
    const sel = selectVisibleTiles({ ...base, ...bad })
    assert.deepEqual(sel.tiles, [], JSON.stringify(bad))
    assert.equal(sel.truncated, false, JSON.stringify(bad))
    assert.equal(sel.emptyReason, 'unusable-input', JSON.stringify(bad))
    assert.ok(Number.isInteger(sel.zoom) && sel.zoom >= 0 && sel.zoom <= MAP_TILE_MAX_ZOOM, `${JSON.stringify(bad)}: zoom ${sel.zoom}`)
  }
  // Good inputs at the edge of what is allowed are used: the Web-Mercator limit, a turn and a half of longitude, one tile, a far plane of a metre.
  for (const ok of [
    { frame: { origin: { lat: 85, lng: 0, altitudeM: 0 } } }, { frame: { origin: { lat: WEB_MERCATOR_MAX_LATITUDE_DEG, lng: 0, altitudeM: 0 } } },
    { frame: { origin: { lat: -WEB_MERCATOR_MAX_LATITUDE_DEG, lng: 0, altitudeM: 0 } } }, { frame: { origin: { ...LONDON.origin, lng: 540 } } },
    { maxTiles: 1 }, { maxTiles: 1.9 }, { farM: 150 }, { farM: 0.5 }, { radiusM: 0.5 }, { viewportHeightPx: 1 }, { tilePx: 1 },
    { camera: { ...looksDown({ x: 0, y: 100, z: 0 }), fovYDeg: 0.5 } },
  ]) {
    assert.equal(selectVisibleTiles({ ...base, ...ok }).emptyReason !== 'unusable-input', true, JSON.stringify(ok))
  }
  assert.equal(selectVisibleTiles({ ...base, maxTiles: 1.9 }).tiles.length, 1, 'a count that is not whole is rounded down')
})

// ─── Any camera ────────────────────────────────────────────────────────────

/** A frame, a camera and a window as the editor or the capture flow might have them, from a seeded generator. */
function randomView(rand: () => number): {
  frame: MapPlaneFrame
  camera: RayCamera
  radiusM: number
  planeY: number
  far: number | undefined
  viewportHeightPx: number
  tilePx: number
  minZoom: number
  maxZoom: number
} {
  const frames: MapPlaneFrame[] = [
    LONDON,
    SYDNEY,
    { origin: LONDON.origin, zAxisBearingDeg: 33 },
    { origin: SYDNEY.origin, zAxisBearingDeg: 250 },
    { origin: { lat: 60, lng: 10, altitudeM: 0 } },
    { origin: { lat: 10, lng: 179.9998, altitudeM: 0 } },
    { origin: { lat: -20, lng: -179.9995, altitudeM: 0 }, zAxisBearingDeg: 120 },
  ]
  const frame = frames[Math.floor(rand() * frames.length)]!
  const radiusM = 40 + rand() * 180
  const planeY = rand() < 0.7 ? 0 : (rand() - 0.5) * 6
  // Half of the cameras are at a person's or a drone's height, 3 to 120 m, and half are high over the Place, 120 m to 1.5 km.
  const height = rand() < 0.5 ? 3 * 40 ** rand() : 120 * 12.5 ** rand()
  const camera = cameraAt(
    { x: (rand() - 0.5) * 2.4 * radiusM, y: planeY + height, z: (rand() - 0.5) * 2.4 * radiusM },
    -90 + rand() * 85,
    rand() * 360,
    40 + rand() * 50,
    0.45 + rand() * 1.4,
    (rand() - 0.5) * 40,
  )
  return {
    frame,
    camera,
    radiusM,
    planeY,
    far: rand() < 0.3 ? 60 + rand() * 400 : undefined,
    viewportHeightPx: 300 + rand() * 1300,
    tilePx: rand() < 0.5 ? 256 : 512,
    minZoom: 15 + Math.floor(rand() * 2),
    maxZoom: 17 + Math.floor(rand() * 3),
  }
}

test('select: for 600 random cameras, frames, windows, plane heights, far planes and providers the tiles are the oracle\'s, at the zoom the nearest ground shown asks for, nearest first', () => {
  const rand = rng(2024)
  const tally = { seen: 0, nothing: 0, far: 0, antimeridian: 0, belowRange: 0, inRange: 0, aboveRange: 0 }
  for (let i = 0; i < 600; i++) {
    const { frame, camera, radiusM, planeY, far, viewportHeightPx, tilePx, minZoom, maxZoom } = randomView(rand)
    const label = `case ${i} (${JSON.stringify(frame)}, camera ${JSON.stringify(camera)}, radius ${radiusM}, plane ${planeY}, far ${far}, viewport ${viewportHeightPx}, tile ${tilePx} px, z${minZoom}-${maxZoom})`
    const sel = selectVisibleTiles({ frame, camera, radiusM, planeY, farM: far, viewportHeightPx, tilePx, minZoom, maxZoom })
    const nearest = nearestShownGroundM(camera, radiusM, planeY, far)
    if (nearest === null) {
      assert.deepEqual(sel.tiles, [], label)
      assert.equal(sel.emptyReason, 'nothing-in-view', label)
      tally.nothing++
      continue
    }
    tally.seen++
    if (far !== undefined) tally.far++
    if (Math.abs(frame.origin.lng) > 179) tally.antimeridian++
    assert.equal(sel.emptyReason, null, label)
    assert.equal(sel.truncated, false, label)

    // The zoom: the one the nearest ground asks for, held to the provider's range, unless the cap forces a coarser.
    const asked = zoomAskedFor(nearest, frame.origin.lat, camera.fovYDeg, viewportHeightPx, minZoom, maxZoom, tilePx)
    if (Math.abs((asked.exact % 1) - 0.5) > 1e-6) {
      const areas = shownAreas(frame, camera, asked.zoom, radiusM, planeY, far)
      const least = areas.filter((t) => t.area > 1e-9).length
      const most = areas.filter((t) => t.area >= CLEARLY_VISIBLE_M2).length
      if (least <= MAP_PLANE_MAX_TILES) {
        assert.equal(sel.zoom, asked.zoom, `${label}: zoom (exact ${asked.exact})`)
        const whole = Math.round(asked.exact)
        if (whole < minZoom) tally.belowRange++
        else if (whole > maxZoom) tally.aboveRange++
        else tally.inRange++
      } else if (most > MAP_PLANE_MAX_TILES) {
        assert.ok(sel.zoom < asked.zoom, `${label}: ${most} tiles at z${asked.zoom} are over the cap, so z${sel.zoom} is coarser`)
      }
    }
    // The tiles: every one has some of itself in view, none that shows a patch is missing, and they are nearest first.
    assertSeesWhatTheOracleSees(frame, camera, sel, radiusM, label, planeY, far)
    assertNearestFirst(frame, camera, sel.tiles, label)
  }
  assert.ok(tally.seen > 400 && tally.nothing < 200 && tally.far > 100 && tally.antimeridian > 100, JSON.stringify(tally))
  assert.ok(tally.belowRange > 4 && tally.inRange > 80 && tally.aboveRange > 100, `the zooms asked for, held to the range and not: ${JSON.stringify(tally)}`)
})
