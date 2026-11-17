/**
 * Exact WGS-84 geodetic <-> ENU (src/world/enu.ts): round trips, and the numbers it must reproduce.
 *
 * A round trip proves the inverse undoes the forward and nothing about whether the forward is the
 * WGS-84 ellipsoid: a module that used the wrong flattening would round-trip perfectly. So every
 * check that carries weight compares against a value this module did not produce:
 *
 *   1. Exact points from the definition of the ellipsoid. (0N, 0E, h) is (a + h, 0, 0); the pole is
 *      (0, 0, b + h) with b = a(1 - f) = 6356752.3142 m, the published semi-minor axis.
 *   2. Properties that need no formula for the radius of curvature: a surface point satisfies
 *      (x^2 + y^2) / a^2 + z^2 / b^2 = 1; the geodetic latitude is the angle of the ellipsoid's
 *      normal, which points along (x / a^2, y / a^2, z / b^2); and a height h moves the point
 *      along that normal.
 *   3. Reference ECEF and ENU values from tests/unit/deno/enu_reference.py: the textbook closed
 *      forms evaluated in 70-digit decimal arithmetic with a hand-written Taylor series for the
 *      trigonometry, so no float library is involved. They check the module's double-precision
 *      arithmetic, to well under a micrometre.
 *   4. Vincenty's inverse geodesic distance and azimuth on the same ellipsoid, from the same script.
 *      It shares no formula with the module, and the horizontal ENU distance between two surface
 *      points agrees with it to about 1e-5 m at 1.4 km (the chord and the tangent plane lose a few
 *      micrometres to the curve), which checks the formulas and not just the arithmetic.
 *
 * Run `python3 -I -B tests/unit/deno/enu_reference.py` to regenerate the tables below.
 */
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  ecefToGeodetic,
  enuFromScene,
  enuToGeodetic,
  geodeticToEcef,
  geodeticToEnu,
  sceneFromEnu,
  sceneYawForBearingDeg,
  WGS84_A_M,
  WGS84_F,
  type Enu,
  type Geodetic,
} from '../../../src/world/enu.ts'
import { composeYUpTransform, geoToEnu } from '../../../src/world/geo.ts'
import { applyColumnMajor, norm360, R2D, D2R } from './physical_oracle.ts'

const B_M = WGS84_A_M * (1 - WGS84_F)

/** [name, lat, lng, height m, x, y, z] — ECEF metres. */
const ECEF_REFERENCE: Array<[string, number, number, number, number, number, number]> = [
  ['san_francisco', 37.7749, -122.4194, 10, -2.706179084171105e+6, -4.261066161627863e+6, 3.885731615632061e+6],
  ['sydney', -33.8688, 151.2093, 58, -4.646093477288302e+6, 2.553229535817072e+6, -3.534404710910369e+6],
  ['london', 51.5007, -0.1246, 11, 3.978585020170455e+6, -8.652163897667479e+3, 4.968419547435919e+6],
  ['reykjavik', 64.1466, -21.9426, 20, 2.586861995702165e+6, -1.042146699906051e+6, 5.716878321874214e+6],
  ['quito', -0.1807, -78.4678, 2850, 1.275671792318399e+6, -6.252139976953998e+6, -1.998972752649199e+4],
]

/** [name, dLat, dLng, dH, east, north, up] — ENU metres from the named origin to origin + offset. */
const ENU_REFERENCE: Array<[string, number, number, number, number, number, number]> = [
  ['san_francisco', 0.004, 0.000, 3, 0, 4.439699437518974e+2, 2.984502523639105e+0],
  ['san_francisco', 0.000, 0.006, -4, 5.286020275122698e+2, 1.695417575309449e-2, -4.021876974301499e+0],
  ['san_francisco', -0.003, -0.002, 12, -1.762082372043358e+2, -3.329758470063495e+2, 1.198885178489677e+1],
  ['san_francisco', 0.005, 0.007, 0, 6.166612164611328e+2, 5.549852898264283e+2, -5.398980409508897e-2],
  ['san_francisco', 0.009, 0.009, -20, 7.928049253678832e+2, 9.989673244045782e+2, -2.012767283592153e+1],
  ['sydney', 0.004, 0.000, 3, 0, 4.436841878287835e+2, 2.984512501838493e+0],
  ['sydney', 0.000, 0.006, -4, 5.551641580477103e+2, -1.619957679252559e-2, -4.024135893761989e+0],
  ['sydney', -0.003, -0.002, 12, -1.850487098133989e+2, -3.327656014173177e+2, 1.198860658445528e+1],
  ['sydney', 0.005, 0.007, 0, 6.477296815454341e+2, 5.545828769417272e+2, -5.705277072510072e-2],
  ['sydney', 0.009, 0.009, -20, 8.328315274237413e+2, 9.982489481014179e+2, -2.013271645614148e+1],
  ['london', 0.004, 0.000, 3, 0, 4.450325176353293e+2, 2.984465432795576e+0],
  ['london', 0.000, 0.006, -4, 4.166371727068001e+2, 1.707281870845712e-2, -4.013579992644140e+0],
  ['london', -0.003, -0.002, 12, -1.388885234813266e+2, -3.337727621643877e+2, 1.198975280968586e+1],
  ['london', 0.005, 0.007, 0, 4.860238140769802e+2, 5.563136681574180e+2, -4.275462035334772e-2],
  ['london', 0.009, 0.009, -20, 6.248310901517503e+2, 1.001358383946117e+3, -2.010919239578195e+1],
  ['reykjavik', 0.004, 0.000, 3, 0, 4.459201635757876e+2, 2.984434448447746e+0],
  ['reykjavik', 0.000, 0.006, -4, 2.920520193996647e+2, 1.376129286711118e-2, -4.006668298902597e+0],
  ['reykjavik', -0.003, -0.002, 12, -9.736142244292999e+1, -3.344389029529744e+2, 1.199050336665300e+1],
  ['reykjavik', 0.005, 0.007, 0, 3.406662841630055e+2, 5.574187082483120e+2, -3.339583401466481e-2],
  ['reykjavik', 0.009, 0.009, -20, 4.379350998767527e+2, 1.003348051568928e+3, -2.009379913455981e+1],
  ['quito', 0.004, 0.000, 3, 0, 4.424963231063988e+2, 2.984553964472628e+0],
  ['quito', 0.000, 0.006, -4, 6.682116749949708e+2, -1.103436847088068e-4, -4.034987307517109e+0],
  ['quito', -0.003, -0.002, 12, -2.227377470241032e+2, -3.318727272281787e+2, 1.198742410491172e+1],
  ['quito', 0.005, 0.007, 0, 7.795809858434898e+2, 5.531199913402116e+2, -7.175607475004117e-2],
  ['quito', 0.009, 0.009, -20, 1.002315477883321e+3, 9.956128599151809e+2, -2.015691655290332e+1],
]

/** [name, dLat, dLng, metres, azimuth degrees] — Vincenty on the surface (height 0 at both ends). */
const VINCENTY_REFERENCE: Array<[string, number, number, number, number]> = [
  ['san_francisco', 0.004, 0.000, 443.9690365406412, 0.0],
  ['san_francisco', 0.000, 0.006, 528.6015317434884, 89.99816231745532],
  ['san_francisco', -0.003, -0.002, 376.72440413672837, 207.8874465552564],
  ['san_francisco', 0.005, 0.007, 829.6249586970912, 48.01329101614729],
  ['san_francisco', 0.009, 0.009, 1275.3354435384822, 38.43637635228308],
  ['sydney', 0.004, 0.000, 443.67992958502816, 0.0],
  ['sydney', 0.000, 0.006, 555.1594636460669, 90.00167187913692],
  ['sydney', -0.003, -0.002, 380.75291269180735, 209.07814230056925],
  ['sydney', 0.005, 0.007, 852.703158129115, 49.43003023069602],
  ['sydney', 0.009, 0.009, 1300.0342941856013, 39.837986930944105],
  ['london', 0.004, 0.000, 445.0315406121362, 0.0],
  ['london', 0.000, 0.006, 416.63671703202124, 89.99765215267766],
  ['london', -0.003, -0.002, 361.5153331703041, 202.59302557687178],
  ['london', 0.005, 0.007, 738.716567069404, 41.14210959123204],
  ['london', 0.009, 0.009, 1180.312014317517, 31.963481911508882],
  ['reykjavik', 0.004, 0.000, 445.91855823351193, 0.0],
  ['reykjavik', 0.000, 0.006, 292.05128918349885, 89.99730026181987],
  ['reykjavik', -0.003, -0.002, 348.32084482284637, 196.23126642772525],
  ['reykjavik', 0.005, 0.007, 653.2736511562581, 31.43117606873333],
  ['reykjavik', 0.009, 0.009, 1094.7577248049417, 23.58000650306983],
  ['quito', 0.004, 0.000, 442.29714649225775, 0.0],
  ['quito', 0.000, 0.006, 667.9136452751246, 90.00000946141412],
  ['quito', -0.003, -0.002, 399.5092925274746, 213.86777976596997],
  ['quito', 0.005, 0.007, 955.4425199933521, 54.644024591493384],
  ['quito', 0.009, 0.009, 1412.1279746166365, 45.19229986615327],
]

const ORIGINS = new Map(ECEF_REFERENCE.map(([name, lat, lng, altitudeM]) => [name, { lat, lng, altitudeM }]))
const origin = (name: string): Geodetic => ORIGINS.get(name)!

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

Deno.test('WGS-84 constants: a is 6378137 m and b = a(1 - f) is the published 6356752.3142 m', () => {
  assertEquals(WGS84_A_M, 6378137)
  assertAlmostEquals(1 / WGS84_F, 298.257223563, 1e-9)
  assertAlmostEquals(B_M, 6356752.314245179, 1e-6)
})

Deno.test('geodeticToEcef: exact points follow from the ellipsoid, not from any formula for its curvature', () => {
  const at = (lat: number, lng: number, altitudeM = 0) => geodeticToEcef({ lat, lng, altitudeM })
  for (const [got, want] of [
    [at(0, 0), { x: WGS84_A_M, y: 0, z: 0 }],
    [at(0, 90), { x: 0, y: WGS84_A_M, z: 0 }],
    [at(0, 180), { x: -WGS84_A_M, y: 0, z: 0 }],
    [at(90, 0), { x: 0, y: 0, z: B_M }],
    [at(-90, 123), { x: 0, y: 0, z: -B_M }],
    [at(0, 0, 100), { x: WGS84_A_M + 100, y: 0, z: 0 }],
    [at(90, 0, -50), { x: 0, y: 0, z: B_M - 50 }],
  ] as const) {
    assertAlmostEquals(got.x, want.x, 1e-6)
    assertAlmostEquals(got.y, want.y, 1e-6)
    assertAlmostEquals(got.z, want.z, 1e-6)
  }
})

Deno.test('geodeticToEcef: a surface point is on the ellipsoid, and a height moves it along the normal', () => {
  const next = lcg(7)
  for (let i = 0; i < 200; i++) {
    const lat = next() * 178 - 89
    const lng = next() * 360 - 180
    const surface = geodeticToEcef({ lat, lng, altitudeM: 0 })
    const onEllipsoid = (surface.x ** 2 + surface.y ** 2) / WGS84_A_M ** 2 + surface.z ** 2 / B_M ** 2
    assertAlmostEquals(onEllipsoid, 1, 1e-14, `lat ${lat}, lng ${lng}`)

    // The ellipsoid's normal direction at a surface point is the gradient (x / a^2, y / a^2, z / b^2).
    const nx = surface.x / WGS84_A_M ** 2
    const ny = surface.y / WGS84_A_M ** 2
    const nz = surface.z / B_M ** 2
    const length = Math.hypot(nx, ny, nz)
    const normalLat = Math.atan2(nz, Math.hypot(nx, ny)) * R2D
    const normalLng = Math.atan2(ny, nx) * R2D
    assertAlmostEquals(normalLat, lat, 1e-10, `normal latitude at ${lat}`)
    assertAlmostEquals(normalLng, lng, 1e-10, `normal longitude at ${lng}`)

    const height = 500 + next() * 1000
    const lifted = geodeticToEcef({ lat, lng, altitudeM: height })
    assertAlmostEquals(lifted.x - surface.x, (nx / length) * height, 1e-6, 'height along the normal: x')
    assertAlmostEquals(lifted.y - surface.y, (ny / length) * height, 1e-6, 'height along the normal: y')
    assertAlmostEquals(lifted.z - surface.z, (nz / length) * height, 1e-6, 'height along the normal: z')
  }
})

Deno.test('geodeticToEcef: matches the 70-digit reference to well under a micrometre', () => {
  for (const [name, lat, lng, altitudeM, x, y, z] of ECEF_REFERENCE) {
    const got = geodeticToEcef({ lat, lng, altitudeM })
    assertAlmostEquals(got.x, x, 1e-7, `${name} x`)
    assertAlmostEquals(got.y, y, 1e-7, `${name} y`)
    assertAlmostEquals(got.z, z, 1e-7, `${name} z`)
  }
})

Deno.test('ecefToGeodetic: recovers the reference points', () => {
  for (const [name, lat, lng, altitudeM, x, y, z] of ECEF_REFERENCE) {
    const got = ecefToGeodetic({ x, y, z })
    // 1e-9 degrees is about 0.1 mm on the ground.
    assertAlmostEquals(got.lat, lat, 1e-9, `${name} lat`)
    assertAlmostEquals(got.lng, lng, 1e-9, `${name} lng`)
    assertAlmostEquals(got.altitudeM, altitudeM, 1e-6, `${name} height`)
  }
})

Deno.test('geodeticToEnu: matches the 70-digit reference to well under a micrometre', () => {
  for (const [name, dLat, dLng, dH, east, north, up] of ENU_REFERENCE) {
    const o = origin(name)
    const got = geodeticToEnu(o, { lat: o.lat + dLat, lng: o.lng + dLng, altitudeM: o.altitudeM + dH })
    assertAlmostEquals(got.east, east, 1e-7, `${name} +(${dLat}, ${dLng}, ${dH}) east`)
    assertAlmostEquals(got.north, north, 1e-7, `${name} +(${dLat}, ${dLng}, ${dH}) north`)
    assertAlmostEquals(got.up, up, 1e-7, `${name} +(${dLat}, ${dLng}, ${dH}) up`)
  }
})

Deno.test('enuToGeodetic: puts the reference offsets back where they came from', () => {
  for (const [name, dLat, dLng, dH, east, north, up] of ENU_REFERENCE) {
    const o = origin(name)
    const got = enuToGeodetic(o, { east, north, up })
    assertAlmostEquals(got.lat, o.lat + dLat, 1e-9, `${name} lat`)
    assertAlmostEquals(got.lng, o.lng + dLng, 1e-9, `${name} lng`)
    assertAlmostEquals(got.altitudeM, o.altitudeM + dH, 1e-6, `${name} height`)
  }
})

Deno.test('geodeticToEnu: horizontal distance and azimuth agree with an independent Vincenty geodesic', () => {
  assertEquals(VINCENTY_REFERENCE.length, 25)
  for (const [name, dLat, dLng, metres, azimuth] of VINCENTY_REFERENCE) {
    const o = origin(name)
    const surface = { lat: o.lat, lng: o.lng, altitudeM: 0 }
    const enu = geodeticToEnu(surface, { lat: o.lat + dLat, lng: o.lng + dLng, altitudeM: 0 })
    const distance = Math.hypot(enu.east, enu.north)
    // The chord and the tangent plane make the ENU distance a few micrometres short of the surface
    // distance by 1.4 km: 1e-4 m is 9x that and still catches a flattening wrong in the 7th digit.
    assertAlmostEquals(distance, metres, 1e-4, `${name} +(${dLat}, ${dLng}) distance`)
    const bearing = norm360(Math.atan2(enu.east, enu.north) * R2D)
    assertAlmostEquals(((bearing - azimuth + 540) % 360) - 180, 0, 1e-7, `${name} +(${dLat}, ${dLng}) azimuth`)
  }
})

Deno.test('geodeticToEnu and enuToGeodetic round-trip to well under a millimetre within 1 km, at every latitude', () => {
  const next = lcg(20260)
  let worstM = 0
  for (let i = 0; i < 2000; i++) {
    const o: Geodetic = { lat: next() * 170 - 85, lng: next() * 360 - 180, altitudeM: next() * 3000 - 200 }
    const enu: Enu = { east: next() * 2000 - 1000, north: next() * 2000 - 1000, up: next() * 200 - 100 }
    const geodetic = enuToGeodetic(o, enu)
    const back = geodeticToEnu(o, geodetic)
    const err = Math.hypot(back.east - enu.east, back.north - enu.north, back.up - enu.up)
    worstM = Math.max(worstM, err)
    assert(err < 1e-3, `origin ${JSON.stringify(o)}, offset ${JSON.stringify(enu)}: ${err} m`)
  }
  // The requirement is 1 mm. Doubles do far better: this run's worst is 5.5e-9 m. The bound is 2e-8 m, which a
  // loop that stops early does not meet: a stopping step of 1e-12 rad leaves 4e-8 m, and 1e-11 rad leaves 4e-7 m.
  assert(worstM < 2e-8, `worst round trip ${worstM} m`)
})

Deno.test('ecefToGeodetic: the poles, the antimeridian, the Dead Sea and a high balloon', () => {
  for (const g of [
    { lat: 90, lng: 0, altitudeM: 0 },
    { lat: -90, lng: 0, altitudeM: 1200 },
    { lat: 89.9999999, lng: 45, altitudeM: -30 },
    { lat: 0, lng: 180, altitudeM: 0 },
    { lat: 31.5, lng: 35.5, altitudeM: -430 },
    { lat: 45, lng: -75, altitudeM: 35_000 },
  ]) {
    const back = ecefToGeodetic(geodeticToEcef(g))
    assertAlmostEquals(back.lat, g.lat, 1e-9, JSON.stringify(g))
    // Longitude is meaningless at the poles, and +-180 are the same meridian.
    if (Math.abs(g.lat) < 89) assertAlmostEquals(Math.cos((back.lng - g.lng) * D2R), 1, 1e-14, JSON.stringify(g))
    assertAlmostEquals(back.altitudeM, g.altitudeM, 1e-6, JSON.stringify(g))
  }
})

Deno.test('geodeticToEnu: north is +north, east is +east, up is +up, and the origin is the origin', () => {
  const o = origin('san_francisco')
  const zero = geodeticToEnu(o, o)
  assertAlmostEquals(zero.east, 0, 1e-9)
  assertAlmostEquals(zero.north, 0, 1e-9)
  assertAlmostEquals(zero.up, 0, 1e-9)
  const north = geodeticToEnu(o, { ...o, lat: o.lat + 0.001 })
  assert(north.north > 100 && Math.abs(north.east) < 1e-6)
  const east = geodeticToEnu(o, { ...o, lng: o.lng + 0.001 })
  assert(east.east > 80 && Math.abs(east.north) < 0.1)
  const up = geodeticToEnu(o, { ...o, altitudeM: o.altitudeM + 5 })
  assertAlmostEquals(up.up, 5, 1e-9)
  assertAlmostEquals(up.east, 0, 1e-9)
  assertAlmostEquals(up.north, 0, 1e-9)
})

Deno.test('the legacy sphere (geoToEnu) is untouched, and measurably off the ellipsoid', () => {
  const pose = (g: Geodetic) => ({ lat: g.lat, lng: g.lng, altitudeM: g.altitudeM, bearing: null, accuracyM: null })
  // Untouched: the equirectangular formula on a sphere of the equatorial radius, restated here.
  const o = origin('san_francisco')
  const p = { lat: o.lat + 0.002, lng: o.lng + 0.003, altitudeM: o.altitudeM + 2 }
  const legacy = geoToEnu(pose(o), pose(p))
  const mid = ((o.lat + p.lat) / 2) * D2R
  assertAlmostEquals(legacy.x, 0.003 * D2R * Math.cos(mid) * 6_378_137, 1e-6)
  assertAlmostEquals(legacy.z, 0.002 * D2R * 6_378_137, 1e-6)
  assertAlmostEquals(legacy.y, 2, 1e-12)

  // Off the ellipsoid, by an amount that depends on latitude and direction. 100 m north on the
  // equator is 0.67 m out (the meridian's radius of curvature there is 0.67 % under a); at San
  // Francisco it is 0.30 m; 2 km north on the equator is 13.5 m.
  const errorAt = (lat: number, east: number, north: number) => {
    const start = { lat, lng: 10, altitudeM: 0 }
    const target = enuToGeodetic(start, { east, north, up: 0 })
    const sphere = geoToEnu(pose(start), pose(target))
    return Math.hypot(sphere.x - east, sphere.z - north)
  }
  assertAlmostEquals(errorAt(0, 0, 100), 0.674, 0.002)
  assertAlmostEquals(errorAt(37.7749, 0, 100), 0.295, 0.002)
  assertAlmostEquals(errorAt(0, 0, 2000), 13.48, 0.02)
  assertAlmostEquals(errorAt(75, 2000, 0), 6.36, 0.02)
})

Deno.test('sceneFromEnu / enuFromScene: x east, y up, z SOUTH, and back', () => {
  assertEquals(sceneFromEnu({ east: 1, north: 2, up: 3 }), { x: 1, y: 3, z: -2 })
  assertEquals(enuFromScene({ x: 1, y: 3, z: -2 }), { east: 1, north: 2, up: 3 })
  const next = lcg(5)
  for (let i = 0; i < 100; i++) {
    const enu = { east: next() * 100 - 50, north: next() * 100 - 50, up: next() * 10 }
    assertEquals(enuFromScene(sceneFromEnu(enu)), enu)
  }
  // North 0 is a zero, not minus zero.
  assert(Object.is(sceneFromEnu({ east: 1, north: 0, up: 0 }).z, 0))
  assert(Object.is(enuFromScene({ x: 1, y: 0, z: 0 }).north, 0))
})

Deno.test('the scene is right-handed: east x up = south, and north is -z', () => {
  const east = sceneFromEnu({ east: 1, north: 0, up: 0 })
  const up = sceneFromEnu({ east: 0, north: 0, up: 1 })
  const north = sceneFromEnu({ east: 0, north: 1, up: 0 })
  // east x up, by the right-hand rule, is where south is: (0, 0, +1).
  const eastCrossUp = {
    x: east.y * up.z - east.z * up.y,
    y: east.z * up.x - east.x * up.z,
    z: east.x * up.y - east.y * up.x,
  }
  assertEquals(eastCrossUp, { x: 0, y: 0, z: 1 })
  assertEquals(north, { x: 0, y: 0, z: -1 })
})

Deno.test('sceneYawForBearingDeg: a rotation by it carries +Z to the scene direction of that bearing', () => {
  // A frame whose +Z has true bearing B goes into the scene by Ry(180 - B): +Z must land on
  // (east sin B, north cos B), which is (sin B, 0, -cos B) in scene axes.
  for (let bearing = 0; bearing < 360; bearing += 7.5) {
    const yaw = sceneYawForBearingDeg(bearing)
    assert(yaw >= 0 && yaw < 360, `${yaw}`)
    const m = composeYUpTransform({ x: 0, y: 0, z: 0 }, yaw, 1)
    const z = applyColumnMajor(m, { x: 0, y: 0, z: 1 })
    const want = sceneFromEnu({ east: Math.sin(bearing * D2R), north: Math.cos(bearing * D2R), up: 0 })
    assertAlmostEquals(z.x, want.x, 1e-12, `bearing ${bearing}`)
    assertAlmostEquals(z.y, want.y, 1e-12, `bearing ${bearing}`)
    assertAlmostEquals(z.z, want.z, 1e-12, `bearing ${bearing}`)
  }
  assertEquals([0, 90, 180, 270].map(sceneYawForBearingDeg), [180, 90, 0, 270])
})
