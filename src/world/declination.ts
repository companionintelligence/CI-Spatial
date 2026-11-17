/**
 * Magnetic declination from the World Magnetic Model, WMM2025: in house, pure, no dependency, no network.
 *
 * A phone's compass reads **magnetic** north, not true north: WebKit sets `webkitCompassHeading` from CoreLocation's
 * `magneticHeading`, and Chrome's `deviceorientationabsolute` comes from the magnetometer. A bearing a map or a
 * georeference can use is the true one:
 *
 *     true bearing = magnetic bearing + declination        (declination is east positive)
 *
 * so a place where magnetic north lies 15° east of true north has declination +15 and a compass reading of
 * 0° is a true bearing of 15°. {@link trueBearingDeg} does that sum, and refuses when there is no usable
 * declination:
 *
 *     const declination = declinationDeg(origin.lat, origin.lng, origin.altitudeM ?? 0, new Date())
 *     const trueBearing = trueBearingDeg(compassHeading, declination)      // null when it has no value
 *
 * The result has a field named like the function, so give it a name first: `const { declinationDeg } =
 * declinationDeg(...)` does not compile. For a place read from storage, a GeoPose that may hold nothing, a
 * (0, 0) or a number out of range, use {@link declinationForGeoPose}: it gives null where `declinationDeg` throws.
 *
 * Declination does not affect how two scans of one Place line up with each other (a Place frame comes from
 * geometry, ADR 0005), only a compass seed and anything compared with a map.
 *
 * ## What a result means
 *
 *     status          declinationDeg  sigmaDeg  hNT     when
 *     'ok'            number          number    number  H >= 6000 nT
 *     'caution'       number          number    number  2000 nT <= H < 6000 nT: a weak field; sigma is large
 *     'blackout'      null            null      number  H < 2000 nT: NOAA's blackout zone, no usable value
 *     'expired'       null            null      null    the date is on or after 2030-01-01
 *     'not-yet-valid' null            null      null    the date is before 2025-01-01
 *
 * `H` is the horizontal intensity of the field. `sigmaDeg` is NOAA's 1-sigma error for the declination,
 * `sqrt(0.26² + (5417 / H)²)` degrees with H in nT: 0.3° at H = 40000 nT, 0.6° at 10000 nT, 0.9° at 6000 nT
 * and 2.7° at 2000 nT. A number is only ever given when the model stands behind it: **outside its validity
 * the module never extrapolates**, and in the blackout zone it says so instead of printing a value NOAA
 * calls unreliable. The constants behind the guards are NOAA's, adopted, not measured here (ADR 0005
 * rule 5); each says so where it is defined. The blackout zone is not only a polar curiosity: the north
 * geographic pole is inside it in 2026 (H is about 1800 nT there), the south geographic pole is not.
 *
 * Arguments that are not numbers in range (a latitude beyond ±90, a height outside the model's, an invalid
 * `Date`) are a programming error and throw a `RangeError`: `declinationDeg` takes a place that has been checked.
 * `hasGeoPose` in ./geo.ts does not check it (it asks only for numbers that are not (0, 0)), which is why
 * {@link declinationForGeoPose} exists. A height that is not known can be passed as 0: 100 m of height changes
 * the declination by under 0.01° anywhere on the global grid the tests sweep.
 *
 * ## WMM2030: replace the coefficients before 2030-01-01
 *
 * The model is valid from 2025.0 to 2030.0. NOAA says WMM2025 "expires on December 31, 2029"
 * (https://www.ncei.noaa.gov/products/world-magnetic-model), and from 2030-01-01 every call here returns
 * `'expired'` with no value: the Place georeference and the compass seed then have no declination, which is
 * the honest answer, but not one to ship. NCEI released WMM2025 on December 17, 2024, two weeks before its
 * epoch, so expect WMM2030 in December 2029: weeks, not months, before the limit. The calendar item is a
 * test: the reminder at the end of tests/unit/deno/declination.test.ts prints a warning from 180 days before
 * the model ends (2030-01-01) and fails from 14 days before it, until this swap is made. To make it:
 *
 *   1. Download NOAA's `WMM.COF` and the test-value file for WMM2030 from the page above (the download sits
 *      behind a survey page, so it is a manual step). The generator writes only from a file in NOAA's layout
 *      with LF line endings; convert a download that has Windows ones first.
 *   2. `node scripts/gen-wmm-coefficients.mjs <WMM.COF> --origin "<where the file came from>"` writes
 *      `src/world/wmm2030-coefficients.ts` (the name follows the model named in the file), with the SHA-256
 *      of the file in its header. Say in --origin that the file is NOAA's own, if it is.
 *   3. Change the import of the coefficients below to that file: the only place this module's code names the
 *      year, which a test checks. Delete `src/world/wmm2025-coefficients.ts`. Read this header for the years and
 *      the model it names (2025, 2030, WMM2025, the 2026 figures for the poles) and correct them.
 *   4. Run `deno task test`: what fails is what knows WMM2025's answers, and each is marked "WMM2025 only" in
 *      the test files. In tests/unit/deno/declination.test.ts replace the 12 NOAA rows with the new test-value
 *      file's, the pinned reference table with what `python3 -I -B tests/unit/deno/wmm_reference.py table`
 *      prints, and the table's name, file date, SHA-256 and first and last rows, and re-read the places the tests
 *      name (their declination and zone on the day the tests use) against the new model. In
 *      tests/unit/deno/wmm_generator.test.ts replace the layout lines and the two header sentences marked. In
 *      tests/unit/deno/wmm_reference.py replace the 12 NOAA rows: `python3 -I -B tests/unit/deno/wmm_reference.py`
 *      then checks the new table against them with a second implementation, and finds the new file by its name.
 *   5. NOTICE.md and THIRD_PARTY.md name the file, the model and the dates: edit those (a test reads them). The
 *      native apps' notices (scripts/native/third-party-notices.mjs) find the file by its name and carry the
 *      notice from its header, so they need no edit.
 *
 * ## Method
 *
 * The WMM technical report ("The US/UK World Magnetic Model for 2025-2030: Technical Report", Chulliat et al., NOAA
 * NCEI, 2025, https://doi.org/10.25923/prbc-s316) gives the algorithm; this is that algorithm, written out:
 *
 *   1. g and h are moved from the epoch to the date with their annual rates (linear).
 *   2. The geodetic latitude and height are converted to a geocentric radius and latitude on the WGS-84
 *      ellipsoid ({@link WGS84_A_M}, {@link WGS84_F} from ./enu.ts, so the ellipsoid is defined once).
 *   3. The potential's gradient is summed over degree and order 12 with Schmidt semi-normalised associated
 *      Legendre functions, in the geocentric north, east and down directions, with reference radius 6371.2 km.
 *   4. The vector is turned from geocentric into geodetic axes by the angle between the two latitudes.
 *   5. H = sqrt(X² + Y²), F = sqrt(H² + Z²), I = atan2(Z, H), D = atan2(Y, X).
 *
 * The east component has the factor 1 / cos(latitude), which has no value at the geographic poles. The
 * Legendre functions of order m >= 1 all contain a factor cos(latitude)^m, so this module carries
 * `P / cos(latitude)` as its own recurrence and never divides: at ±90° the result is the limit along the
 * meridian `lonDeg`, finite and continuous with the values next to it. The field there is one fixed
 * vector, so H and Z do not depend on `lonDeg` and the declination turns one degree for every degree of
 * longitude (a meridian is all that tells north from south at a pole).
 *
 * Everything is plain double arithmetic with no state: the same arguments give the same bits in any order
 * within one engine, and the frozen coefficient table cannot be changed by a caller. (`Math.sin` and
 * `Math.cos` may differ in the last bit between engines; the module's whole rounding error against a 60-digit
 * reference is about 1e-10 nT, measured in tests/unit/deno/declination.test.ts.) Dates are read in UTC
 * whatever the machine's time zone.
 *
 * Browser-safe on purpose (ADR 0002): no Deno or DOM references.
 */
import { WGS84_A_M, WGS84_F } from './enu.ts'
import { hasGeoPose, normaliseBearingDeg } from './geo.ts'
import type { GeoPose } from './types.ts'
import { WMM_COEFFICIENTS, WMM_EPOCH, WMM_FILE_DATE, WMM_MODEL_NAME, WMM_SOURCE_SHA256, WMM_VALID_UNTIL } from './wmm2025-coefficients.ts'

/**
 * The facts about the model in use leave this module under their own names, so the tests and a record that wants to
 * say which model and which file a number came from read them here, and only the import above names the year.
 */
export { WMM_COEFFICIENTS, WMM_EPOCH, WMM_FILE_DATE, WMM_MODEL_NAME, WMM_SOURCE_SHA256, WMM_VALID_UNTIL }

/** The model in use, as the georeference record names it, such as 'WMM2025'. */
export const DECLINATION_MODEL = WMM_MODEL_NAME.replace('-', '')

/**
 * The horizontal intensity below which NOAA calls a place a blackout zone, nT. There the horizontal field is
 * too weak for a compass: NOAA says compasses in the zone are unreliable and "should not be relied on for
 * navigation" (https://www.ncei.noaa.gov/products/world-magnetic-model/accuracy-limitations-error-model).
 * Adopted from NOAA, not measured here (ADR 0005 rule 5).
 */
export const BLACKOUT_H_NT = 2000

/**
 * The horizontal intensity below which NOAA asks for caution, nT: between this and the blackout limit a compass
 * "should be used with caution". Adopted from NOAA, not measured here (ADR 0005 rule 5).
 */
export const CAUTION_H_NT = 6000

/**
 * The part of NOAA's 1-sigma declination error that does not depend on the field's strength, degrees:
 * `sigma_D = sqrt(0.26² + (5417 / H)²)`, H in nT. NOAA's page prints both terms with a superscript 2, which a
 * text copy flattens to a trailing 2, so it reads "0.262" for 0.26² as it reads "(5417/H)2" for (5417/H)².
 * That reading, the same on both terms, is what is adopted: nothing here could open NOAA's technical report
 * to confirm it. Adopted from NOAA, not measured here (ADR 0005 rule 5).
 */
export const SIGMA_D_FLOOR_DEG = 0.26

/** The field-strength term of NOAA's declination error, nT times degrees: `5417 / H`. Adopted from NOAA, not measured here (ADR 0005 rule 5). */
export const SIGMA_D_FIELD_TERM_NT_DEG = 5417

/** The lowest height the model is used at, metres above the WGS-84 ellipsoid: NOAA's calculator takes -1 km to 850 km. Adopted from NOAA, not measured here (ADR 0005 rule 5). */
export const MIN_HEIGHT_M = -1_000

/** The highest height the model is used at, metres above the WGS-84 ellipsoid. Adopted from NOAA, not measured here (ADR 0005 rule 5). */
export const MAX_HEIGHT_M = 850_000

/** The reference radius of the harmonic expansion, km: a defining constant of the model, not a measurement. */
const REFERENCE_RADIUS_KM = 6371.2

const A_KM = WGS84_A_M / 1000
const E2 = WGS84_F * (2 - WGS84_F)
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/** The highest degree in the table (12). */
const N_MAX = WMM_COEFFICIENTS.reduce((highest, row) => Math.max(highest, row[0]), 0)
/** Entries of a triangular array over (n, m), n = 0..N_MAX and m = 0..n. */
const TRIANGLE = ((N_MAX + 1) * (N_MAX + 2)) / 2
const at = (n: number, m: number) => (n * (n + 1)) / 2 + m

export type DeclinationStatus = 'ok' | 'caution' | 'blackout' | 'expired' | 'not-yet-valid'

/**
 * What the model says about a place and a date. Narrow on `status`, or on `declinationDeg !== null`: a number
 * comes with 'ok' and 'caution' only. See the table in the module header.
 */
export type Declination =
  | { status: 'ok' | 'caution'; declinationDeg: number; sigmaDeg: number; hNT: number }
  | { status: 'blackout'; declinationDeg: null; sigmaDeg: null; hNT: number }
  | { status: 'expired' | 'not-yet-valid'; declinationDeg: null; sigmaDeg: null; hNT: null }

/** The field vector at a place and date, in the geodetic frame: X north, Y east, Z down, in nT, with the angles of H. */
export interface MagneticField {
  xNT: number
  yNT: number
  zNT: number
  /** Horizontal intensity, `sqrt(X² + Y²)`. */
  hNT: number
  /** Total intensity, `sqrt(H² + Z²)`. */
  fNT: number
  /** Inclination (dip): positive when the field points down, degrees. */
  inclinationDeg: number
  /**
   * The model's declination with none of the guards, east positive, degrees. Where H is below 2000 nT (NOAA's
   * blackout zone) NOAA calls it unreliable, and it comes with no sigma. A compass reading is corrected with
   * {@link declinationDeg}'s result, which refuses there, never with this.
   */
  unguardedDeclinationDeg: number
}

export type ModelValidity = 'valid' | 'expired' | 'not-yet-valid'

/** 00:00 UTC on 1 January of `year`, in milliseconds. `Date.UTC` would read a year under 100 as 19xx. */
function startOfYearMs(year: number): number {
  const d = new Date(0)
  d.setUTCFullYear(year, 0, 1)
  return d.getTime()
}

const VALID_FROM_MS = startOfYearMs(WMM_EPOCH)
const VALID_UNTIL_MS = startOfYearMs(WMM_VALID_UNTIL)

function timeOf(date: Date): number {
  const t = typeof date?.getTime === 'function' ? date.getTime() : Number.NaN
  if (!Number.isFinite(t)) throw new RangeError('date must be a valid Date')
  return t
}

/**
 * The date as a decimal year in UTC: the year plus the fraction of it that has passed, by milliseconds, so a leap
 * year's days are not 1/365 each. 2027-07-02T12:00:00Z is 2027.5, the date of NOAA's mid-point test rows.
 */
export function decimalYear(date: Date): number {
  const t = timeOf(date)
  const year = new Date(t).getUTCFullYear()
  const start = startOfYearMs(year)
  return year + (t - start) / (startOfYearMs(year + 1) - start)
}

/** Whether the model covers this date: from 1 January of its epoch up to, not including, 1 January of its limit (2025 and 2030 for WMM2025). */
export function modelValidity(date: Date): ModelValidity {
  const t = timeOf(date)
  if (t < VALID_FROM_MS) return 'not-yet-valid'
  if (t >= VALID_UNTIL_MS) return 'expired'
  return 'valid'
}

/** What a horizontal intensity in nT means for a compass: 'ok' from 6000, 'caution' from 2000, below that 'blackout'. */
export function statusForHorizontalIntensity(hNT: number): 'ok' | 'caution' | 'blackout' {
  // Written so that a NaN is a blackout: nothing that is not a number at least 2000 is called usable.
  if (!(hNT >= BLACKOUT_H_NT)) return 'blackout'
  return hNT < CAUTION_H_NT ? 'caution' : 'ok'
}

/** NOAA's 1-sigma declination error in degrees for a horizontal intensity in nT: `sqrt(0.26² + (5417 / H)²)`. */
export function declinationSigmaDeg(hNT: number): number {
  return Math.hypot(SIGMA_D_FLOOR_DEG, SIGMA_D_FIELD_TERM_NT_DEG / hNT)
}

function assertPlace(latDeg: number, lonDeg: number, heightM: number): void {
  if (!Number.isFinite(latDeg) || latDeg < -90 || latDeg > 90) throw new RangeError('latDeg must be a number from -90 to 90')
  if (!Number.isFinite(lonDeg)) throw new RangeError('lonDeg must be a finite number')
  if (!Number.isFinite(heightM) || heightM < MIN_HEIGHT_M || heightM > MAX_HEIGHT_M) {
    throw new RangeError(`heightM must be a number from ${MIN_HEIGHT_M} to ${MAX_HEIGHT_M} (metres above the WGS-84 ellipsoid); pass 0 when the height is not known`)
  }
}

/**
 * Schmidt semi-normalised associated Legendre functions of sin(latitude), degrees 0..N_MAX, for the geocentric
 * latitude whose sine and cosine are given. Triangular arrays indexed by `at(n, m)`:
 *
 *   p   P(n, m)                                   (P(0, 0) = 1, P(1, 0) = sin, P(1, 1) = cos)
 *   dp  its derivative with respect to latitude
 *   q   P(n, m) / cos(latitude), for m >= 1       (0 for m = 0, which never uses it)
 *
 * Standard recurrences, each entry from the entries one and two degrees below it, so nothing divides by
 * cos(latitude):
 *
 *   P(n, n) = sqrt((2n - 1) / 2n) cos P(n-1, n-1)                 (P(1, 1) = cos)
 *   P(n, m) = ((2n - 1) sin P(n-1, m) - sqrt((n-1)² - m²) P(n-2, m)) / sqrt(n² - m²)
 *
 * and the same two for `q`, with Q(1, 1) = 1, and for `dp` by differentiating them.
 */
function legendre(sinLat: number, cosLat: number): { p: Float64Array; dp: Float64Array; q: Float64Array } {
  const p = new Float64Array(TRIANGLE)
  const dp = new Float64Array(TRIANGLE)
  const q = new Float64Array(TRIANGLE)
  p[0] = 1
  for (let n = 1; n <= N_MAX; n++) {
    const diagonal = at(n, n)
    if (n === 1) {
      p[diagonal] = cosLat
      dp[diagonal] = -sinLat
      q[diagonal] = 1
    } else {
      const k = Math.sqrt((2 * n - 1) / (2 * n))
      const previous = at(n - 1, n - 1)
      p[diagonal] = k * cosLat * p[previous]
      dp[diagonal] = k * (cosLat * dp[previous] - sinLat * p[previous])
      q[diagonal] = k * cosLat * q[previous]
    }
    for (let m = 0; m < n; m++) {
      const here = at(n, m)
      const one = at(n - 1, m)
      const root = Math.sqrt(n * n - m * m)
      let pv = (2 * n - 1) * sinLat * p[one]
      let dpv = (2 * n - 1) * (cosLat * p[one] + sinLat * dp[one])
      let qv = (2 * n - 1) * sinLat * q[one]
      if (n - 2 >= m) {
        const two = at(n - 2, m)
        const k2 = Math.sqrt((n - 1) * (n - 1) - m * m)
        pv -= k2 * p[two]
        dpv -= k2 * dp[two]
        qv -= k2 * q[two]
      }
      p[here] = pv / root
      dp[here] = dpv / root
      q[here] = m >= 1 ? qv / root : 0
    }
  }
  return { p, dp, q }
}

/** The field at a place and a decimal year. No validity check: the callers make it. */
function fieldAt(latDeg: number, lonDeg: number, heightKm: number, year: number): MagneticField {
  // Geodetic latitude and height to a geocentric radius and latitude on the WGS-84 ellipsoid.
  const phi = latDeg * DEG_TO_RAD
  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const primeVertical = A_KM / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  const horizontal = (primeVertical + heightKm) * cosPhi
  const vertical = (primeVertical * (1 - E2) + heightKm) * sinPhi
  const r = Math.hypot(horizontal, vertical)
  const sinLat = vertical / r
  const cosLat = horizontal / r

  const lambda = (((((lonDeg + 180) % 360) + 360) % 360) - 180) * DEG_TO_RAD
  const cosMLon = new Float64Array(N_MAX + 1)
  const sinMLon = new Float64Array(N_MAX + 1)
  for (let m = 0; m <= N_MAX; m++) {
    cosMLon[m] = Math.cos(m * lambda)
    sinMLon[m] = Math.sin(m * lambda)
  }

  // (a / r)^(n + 2) for n = 0..N_MAX
  const ratio = REFERENCE_RADIUS_KM / r
  const radial = new Float64Array(N_MAX + 1)
  radial[0] = ratio * ratio
  for (let n = 1; n <= N_MAX; n++) radial[n] = radial[n - 1] * ratio

  const { p, dp, q } = legendre(sinLat, cosLat)
  const dt = year - WMM_EPOCH
  let north = 0
  let east = 0
  let down = 0
  for (const [n, m, g0, h0, gDot, hDot] of WMM_COEFFICIENTS) {
    const g = g0 + dt * gDot
    const h = h0 + dt * hDot
    const i = at(n, m)
    const cosine = g * cosMLon[m] + h * sinMLon[m]
    const sine = g * sinMLon[m] - h * cosMLon[m]
    north -= radial[n] * cosine * dp[i]
    down -= (n + 1) * radial[n] * cosine * p[i]
    east += radial[n] * m * sine * q[i]
  }

  // Geocentric (north, east, down) to geodetic: a turn about the east axis by the angle between the latitudes.
  const cosPsi = cosLat * cosPhi + sinLat * sinPhi
  const sinPsi = sinLat * cosPhi - cosLat * sinPhi
  const x = north * cosPsi - down * sinPsi
  const y = east
  const z = north * sinPsi + down * cosPsi
  const hNT = Math.hypot(x, y)
  return {
    xNT: x,
    yNT: y,
    zNT: z,
    hNT,
    fNT: Math.hypot(hNT, z),
    inclinationDeg: Math.atan2(z, hNT) * RAD_TO_DEG,
    unguardedDeclinationDeg: Math.atan2(y, x) * RAD_TO_DEG,
  }
}

/**
 * The full magnetic field vector at a place and a date, or null when the date is outside the model (see
 * {@link modelValidity}). The blackout and caution guards are about what the field is good for, not about
 * whether it exists, so they do not apply here: read `hNT` and use {@link statusForHorizontalIntensity}, and take
 * a declination to correct a compass with from {@link declinationDeg}, not from `unguardedDeclinationDeg`. A place
 * or date that is not a number in range throws a `RangeError`, as it does there.
 * @param heightM metres above the WGS-84 ellipsoid
 */
export function magneticField(latDeg: number, lonDeg: number, heightM: number, date: Date): MagneticField | null {
  assertPlace(latDeg, lonDeg, heightM)
  if (modelValidity(date) !== 'valid') return null
  return fieldAt(latDeg, lonDeg, heightM / 1000, decimalYear(date))
}

/**
 * The magnetic declination at a place and a date, east positive, with NOAA's error and the guards: see the
 * table in the module header. Never extrapolates past the model's validity. Throws a `RangeError` for a place
 * or a date that is not a number in range: for a place read from storage use {@link declinationForGeoPose}.
 * @param latDeg geodetic latitude, degrees, -90 to 90
 * @param lonDeg longitude, degrees east, any number (it wraps)
 * @param heightM metres above the WGS-84 ellipsoid; 0 when not known
 */
export function declinationDeg(latDeg: number, lonDeg: number, heightM: number, date: Date): Declination {
  assertPlace(latDeg, lonDeg, heightM)
  const validity = modelValidity(date)
  if (validity !== 'valid') return { status: validity, declinationDeg: null, sigmaDeg: null, hNT: null }
  const field = fieldAt(latDeg, lonDeg, heightM / 1000, decimalYear(date))
  const status = statusForHorizontalIntensity(field.hNT)
  if (status === 'blackout') return { status, declinationDeg: null, sigmaDeg: null, hNT: field.hNT }
  return { status, declinationDeg: field.unguardedDeclinationDeg, sigmaDeg: declinationSigmaDeg(field.hNT), hNT: field.hNT }
}

/**
 * The declination for a place as it is stored: a GeoPose, whose latitude and longitude may be null, NaN, out of
 * range, or the (0, 0) that means "no fix" (`hasGeoPose` in ./geo.ts takes any other pair of numbers for a place).
 * Where {@link declinationDeg} throws on a place or a date it cannot use, this gives null, so a caller that reads
 * records it did not write needs no try/catch:
 *
 *     const declination = declinationForGeoPose(project.geoPose, new Date())      // null: no usable place or date
 *     const trueBearing = trueBearingDeg(compassHeading, declination)               // null when it has no value
 *
 * Otherwise it is `declinationDeg`'s answer for a height of 0: a stored altitude is metres above mean sea level on
 * one platform and above the ellipsoid on another, and 100 m of it changes the declination by under 0.01°. Call
 * {@link declinationDeg} when a height above the WGS-84 ellipsoid is known.
 */
export function declinationForGeoPose(pose: GeoPose | null | undefined, date: Date): Declination | null {
  if (!hasGeoPose(pose) || !(pose.lat >= -90 && pose.lat <= 90) || !Number.isFinite(pose.lng)) return null
  if (!Number.isFinite(date?.getTime?.())) return null
  return declinationDeg(pose.lat, pose.lng, 0, date)
}

/**
 * A magnetic bearing turned into a true one: `magnetic + declination`, folded into [0, 360). Null when there is no
 * usable declination (none given, or one that was refused) or the magnetic bearing is not a finite number, so a
 * caller cannot add a number that was refused or turn a bad reading into a bearing.
 */
export function trueBearingDeg(magneticBearingDeg: number, declination: Declination | null | undefined): number | null {
  if (!declination || declination.declinationDeg === null || !Number.isFinite(magneticBearingDeg)) return null
  return normaliseBearingDeg(magneticBearingDeg + declination.declinationDeg)
}
