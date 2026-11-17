"""A second implementation of the World Magnetic Model, for tests/unit/deno/declination.test.ts.

Run:  python3 -I -B tests/unit/deno/wmm_reference.py              # self-checks (all must pass), then a summary
      python3 -I -B tests/unit/deno/wmm_reference.py table        # the pinned table the test embeds, as TypeScript
      python3 -I -B tests/unit/deno/wmm_reference.py grid         # a dense global grid as JSON, for a full comparison
      python3 -I -B tests/unit/deno/wmm_reference.py blindspot    # which coefficient errors NOAA's 12 rows cannot see (25 s)
      add  --cof <WMM.COF>  to read NOAA's coefficient file instead of the generated src/world/wmm<year>-coefficients.ts

It is written from the model as the WMM technical report describes it ("The US/UK World Magnetic Model for
2025-2030", Chulliat et al., NOAA NCEI, 2025, https://doi.org/10.25923/prbc-s316) and from nothing in
src/world/declination.ts: it imports none of it, and it is built differently on purpose, so that the two agreeing
means something. The module under test is plain double arithmetic with recurrences; this is

  * 60-digit decimal arithmetic, the trigonometry written out as Taylor series (only the last step, the atan2 that
    turns X, Y and Z into the angles D and I, is a double);
  * the Schmidt semi-normalised Legendre functions from their definition (Rodrigues' formula, a derivative of
    (x^2 - 1)^n taken term by term in exact rational arithmetic), not from the recurrences the module uses; the
    normalisation is checked exactly, by integrating the squares as fractions (self-check 1);
  * the geocentric-to-geodetic step as a projection of one 3-D vector onto the two frames' unit vectors, not as a
    rotation by the difference of the latitudes;
  * the gradient formulas checked against finite differences of the potential itself (self-check 3), so a sign or a
    factor in them cannot hide behind the NOAA rows;
  * the field's east component built from P / cos(latitude) = N c^(m-1) Q directly, so there is no division at
    the poles either.

What it takes from the same place as the module is the coefficient table, and the NOAA test rows check that
independently (self-check 2): the two programs can differ in method and still read the same 90 rows. Nothing
here is downloaded.
"""
from calendar import isleap
from datetime import datetime, timedelta, timezone
from decimal import Decimal as D, getcontext
from fractions import Fraction
from math import atan2, comb, degrees, factorial
from pathlib import Path
import json
import re
import sys

getcontext().prec = 60

ROOT = Path(__file__).resolve().parents[3]


def default_coefficients():
    """The generated coefficient module, src/world/wmm<year>-coefficients.ts: the one there is, whichever year it is."""
    found = sorted((ROOT / 'src' / 'world').glob('wmm[0-9][0-9][0-9][0-9]-coefficients.ts'))
    if len(found) != 1:
        sys.exit(f'expected exactly one src/world/wmm<year>-coefficients.ts, found {[p.name for p in found]}: pass --cof <WMM.COF> to name the file')
    return found[0]


PI = D('3.14159265358979323846264338327950288419716939937510582097494459230781640628620899')
A_KM = D('6378.137')  # WGS-84 semi-major axis
F = D(1) / D('298.257223563')  # WGS-84 flattening
E2 = F * (2 - F)
RE_KM = D('6371.2')  # the WMM reference radius
NMAX = 12
EPS = D(10) ** -64


def sin_cos(x):
    """sin and cos by Taylor series, after reducing the angle to [-pi, pi]."""
    two_pi = 2 * PI
    x = x - two_pi * (x / two_pi).to_integral_value()
    sine, cosine = D(0), D(0)
    t_sin, t_cos = x, D(1)
    k = 0
    while abs(t_sin) > EPS or abs(t_cos) > EPS:
        sine += t_sin
        cosine += t_cos
        k += 1
        t_cos = -t_cos * x * x / ((2 * k - 1) * (2 * k))
        t_sin = -t_sin * x * x / ((2 * k) * (2 * k + 1))
    return sine, cosine


def multiple_angles(lam):
    """cos(m lam) and sin(m lam) for m = 0..12, by the exact addition formulas from one sin and cos."""
    sin1, cos1 = sin_cos(lam)
    cos_m, sin_m = [D(1)], [D(0)]
    for m in range(1, NMAX + 1):
        cos_m.append(cos_m[m - 1] * cos1 - sin_m[m - 1] * sin1)
        sin_m.append(sin_m[m - 1] * cos1 + cos_m[m - 1] * sin1)
    return cos_m, sin_m


def rad(deg):
    return deg * PI / 180


def atan2_deg(y, x):
    """Degrees, from a double: it is only ever the last step, so double precision is all it needs."""
    return degrees(atan2(float(y), float(x)))


# --- Legendre functions from their definition -------------------------------------------------------------------

def rodrigues(n, m):
    """Exact coefficients, lowest power first, of d^(n+m)/dx^(n+m) (x^2 - 1)^n / (2^n n!).

    That is d^m P_n / dx^m, the polynomial part of the associated Legendre function."""
    k = n + m
    coefficients = {}
    for j in range(n + 1):
        power = 2 * j
        if power < k:
            continue
        coefficients[power - k] = Fraction(comb(n, j) * (-1) ** (n - j) * factorial(power), factorial(power - k)) / (2 ** n * factorial(n))
    top = max(coefficients)
    return [coefficients.get(i, Fraction(0)) for i in range(top + 1)]


def derivative(poly):
    return [i * c for i, c in enumerate(poly)][1:] or [Fraction(0)]


def horner(poly, x):
    total = D(0)
    for c in reversed(poly):
        total = total * x + c
    return total


def to_decimal(poly):
    return [D(c.numerator) / D(c.denominator) for c in poly]


def schmidt_factor_squared(n, m):
    """The Schmidt semi-normalisation squared: (2 - delta_m0) (n - m)! / (n + m)!, a fraction."""
    return Fraction((1 if m == 0 else 2) * factorial(n - m), factorial(n + m))


def poly_mul(a, b):
    out = [Fraction(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            out[i + j] += x * y
    return out


def poly_pow(a, e):
    out = [Fraction(1)]
    for _ in range(e):
        out = poly_mul(out, a)
    return out


def integral_minus1_to_1(poly):
    return sum((2 * c / (i + 1) for i, c in enumerate(poly) if i % 2 == 0), Fraction(0))


class Legendre:
    """S(n, m)(sin phi) = sqrt((2 - d) (n - m)! / (n + m)!) cos^m(phi) Q(n, m)(sin phi), and its derivatives."""

    def __init__(self):
        self.q = {}
        self.dq = {}
        self.norm = {}
        for n in range(1, NMAX + 1):
            for m in range(n + 1):
                poly = rodrigues(n, m)
                self.q[n, m] = to_decimal(poly)
                self.dq[n, m] = to_decimal(derivative(poly))
                squared = schmidt_factor_squared(n, m)
                self.norm[n, m] = (D(squared.numerator) / D(squared.denominator)).sqrt()

    def values(self, n, m, s, c):
        """(S, dS/dphi, S / cos(phi) or None for m = 0) at the point whose sine and cosine are s and c."""
        norm = self.norm[n, m]
        q = horner(self.q[n, m], s)
        dq = horner(self.dq[n, m], s)
        value = norm * c ** m * q
        slope = norm * (c ** (m + 1) * dq - (m * c ** (m - 1) * s * q if m else 0))
        over_c = norm * c ** (m - 1) * q if m else None
        return value, slope, over_c


# --- the model ---------------------------------------------------------------------------------------------------

def load_coefficients(path):
    """The 90 rows [n, m, g, h, gdot, hdot] and the epoch, from the generated module or from a WMM.COF file.

    Each value goes through a double first, so that this program and the module under test sum identical numbers
    and any difference between them is a difference of method."""
    text = Path(path).read_text()
    if path.suffix == '.ts':
        rows = re.findall(r'^ {2}\[(\d+), (\d+), (-?\d+\.\d), (-?\d+\.\d), (-?\d+\.\d), (-?\d+\.\d)\],$', text, re.M)
        epoch = int(re.search(r'WMM_EPOCH = (\d+)', text).group(1))
    else:
        lines = text.split('\n')
        epoch = int(float(lines[0].split()[0]))
        rows = [ln.split() for ln in lines[1:] if ln.strip() and not ln.startswith('9999')]
    out = [[int(r[0]), int(r[1])] + [D(float(v)) for v in r[2:6]] for r in rows]
    assert len(out) == 90, len(out)
    return out, epoch


class Model:
    def __init__(self, rows, epoch):
        self.rows = rows
        self.epoch = D(epoch)
        self.legendre = Legendre()

    def geodetic_to_geocentric(self, lat_deg, h_km):
        """(sin, cos) of the geodetic latitude, then the geocentric radius and the (sin, cos) of its latitude."""
        sin_phi, cos_phi = sin_cos(rad(lat_deg))
        prime_vertical = A_KM / (1 - E2 * sin_phi ** 2).sqrt()
        p = (prime_vertical + h_km) * cos_phi
        z = (prime_vertical * (1 - E2) + h_km) * sin_phi
        r = (p * p + z * z).sqrt()
        return sin_phi, cos_phi, r, z / r, p / r

    def sums(self, s, c, r, lam, year):
        """Br, B_phi', B_lambda from the gradient of the potential, in nT, at geocentric (r, phi', lambda)."""
        dt = year - self.epoch
        cos_m, sin_m = multiple_angles(lam)
        b_r = b_phi = b_lambda = D(0)
        for n, m, g, h, g_dot, h_dot in self.rows:
            gt = g + dt * g_dot
            ht = h + dt * h_dot
            power = (RE_KM / r) ** (n + 2)
            value, slope, over_c = self.legendre.values(n, m, s, c)
            cosine_term = gt * cos_m[m] + ht * sin_m[m]
            b_r += (n + 1) * power * cosine_term * value
            b_phi -= power * cosine_term * slope
            if m:
                b_lambda += power * m * (gt * sin_m[m] - ht * cos_m[m]) * over_c
        return b_r, b_phi, b_lambda

    def potential(self, s, c, r, lam, year):
        """The scalar potential V in nT km, whose negative gradient is the field. Used only by the self-check."""
        dt = year - self.epoch
        total = D(0)
        cos_m, sin_m = multiple_angles(lam)
        for n, m, g, h, g_dot, h_dot in self.rows:
            value, _, _ = self.legendre.values(n, m, s, c)
            total += (RE_KM / r) ** (n + 1) * ((g + dt * g_dot) * cos_m[m] + (h + dt * h_dot) * sin_m[m]) * value
        return RE_KM * total

    def field(self, lat_deg, lon_deg, h_km, year):
        """X (north), Y (east), Z (down) in nT in the geodetic frame, as decimals, plus H, F, I and D as floats."""
        lat_deg, lon_deg, h_km, year = D(lat_deg), D(lon_deg), D(h_km), D(year)
        sin_phi, cos_phi, r, s, c = self.geodetic_to_geocentric(lat_deg, h_km)
        lam = rad(lon_deg)
        b_r, b_phi, b_lambda = self.sums(s, c, r, lam, year)
        sin_l, cos_l = sin_cos(lam)
        # One physical vector, in Earth-fixed axes, from its geocentric components ...
        north_geocentric = (-s * cos_l, -s * sin_l, c)
        up_geocentric = (c * cos_l, c * sin_l, s)
        east = (-sin_l, cos_l, D(0))
        vector = [b_phi * north_geocentric[i] + b_lambda * east[i] + b_r * up_geocentric[i] for i in range(3)]
        # ... projected onto the geodetic frame at the same point.
        north_geodetic = (-sin_phi * cos_l, -sin_phi * sin_l, cos_phi)
        up_geodetic = (cos_phi * cos_l, cos_phi * sin_l, sin_phi)
        x = sum(vector[i] * north_geodetic[i] for i in range(3))
        y = sum(vector[i] * east[i] for i in range(3))
        z = -sum(vector[i] * up_geodetic[i] for i in range(3))
        h = (x * x + y * y).sqrt()
        f = (h * h + z * z).sqrt()
        return {'x': x, 'y': y, 'z': z, 'h': h, 'f': f, 'i': atan2_deg(z, h), 'd': atan2_deg(y, x)}


def year_from_iso(text):
    """The decimal year of an ISO UTC time: the year plus the fraction of it passed, by microseconds, exactly."""
    moment = datetime.fromisoformat(text.replace('Z', '+00:00')).astimezone(timezone.utc)
    start = datetime(moment.year, 1, 1, tzinfo=timezone.utc)
    end = datetime(moment.year + 1, 1, 1, tzinfo=timezone.utc)
    micro = lambda delta: delta.days * 86_400_000_000 + delta.seconds * 1_000_000 + delta.microseconds
    return Fraction(moment.year) + Fraction(micro(moment - start), micro(end - start))


def decimal_of(fraction):
    return D(fraction.numerator) / D(fraction.denominator)


# --- NOAA's published test rows ----------------------------------------------------------------------------------
# WMM2025 only: replaced with the next model's rows when the coefficients are.
# year, height km, lat, lon, X, Y, Z, H, F, I, D  (WMM2025_TEST_VALUES.txt, 2025.0 and 2027.5)
NOAA_ROWS = [
    (2025.0, 0, 80, 0, 6521.6, 145.9, 54791.5, 6523.2, 55178.5, 83.21, 1.28),
    (2025.0, 0, 0, 120, 39677.8, -109.6, -10580.2, 39677.9, 41064.3, -14.93, -0.16),
    (2025.0, 0, -80, 240, 6117.5, 15751.9, -52022.5, 16898.1, 54698.2, -72.00, 68.78),
    (2025.0, 100, 80, 0, 6216.0, 92.4, 52598.8, 6216.7, 52964.9, 83.26, 0.85),
    (2025.0, 100, 0, 120, 37688.6, -96.2, -10152.1, 37688.7, 39032.1, -15.08, -0.15),
    (2025.0, 100, -80, 240, 5907.6, 14780.3, -49540.7, 15917.1, 52035.0, -72.19, 68.21),
    (2027.5, 0, 80, 0, 6500.8, 294.5, 54869.4, 6507.5, 55253.9, 83.24, 2.59),
    (2027.5, 0, 0, 120, 39701.6, -167.4, -10381.8, 39702.0, 41036.9, -14.65, -0.24),
    (2027.5, 0, -80, 240, 6200.7, 15730.3, -51783.7, 16908.3, 54474.2, -71.92, 68.49),
    (2027.5, 100, 80, 0, 6196.7, 233.8, 52670.5, 6201.1, 53034.3, 83.29, 2.16),
    (2027.5, 100, 0, 120, 37711.5, -148.7, -9969.8, 37711.8, 39007.4, -14.81, -0.23),
    (2027.5, 100, -80, 240, 5984.0, 14760.1, -49317.7, 15927.0, 51825.7, -72.10, 67.93),
]


# --- the points the test pins, and the dense grid ---------------------------------------------------------------

def lcg(seed):
    state = seed

    def draw():
        nonlocal state
        state = (state * 1664525 + 1013904223) % 2 ** 32
        return state / 2 ** 32

    return draw


def window_dates(epoch):
    """Five instants in a model's window of five years from its epoch, ISO UTC: its first second, a day in the next
    year, noon on 2 July two years in, a leap day (the first in the window) and the last second but one."""
    leap = next(year for year in range(epoch, epoch + 5) if isleap(year))
    return [f'{epoch}-01-01T00:00:00Z', f'{epoch + 1}-03-15T06:30:00Z', f'{epoch + 2}-07-02T12:00:00Z',
            f'{leap}-02-29T18:45:00Z', f'{epoch + 4}-12-31T23:59:59Z']


def pinned_points(epoch):
    """(iso, height m, lat, lon): the poles, the equator, both meridians that wrap, and a seeded scatter."""
    dates = window_dates(epoch)
    points = []
    for lat in (-90, -89.999999, -45, 0, 45, 89.999999, 90):
        for lon in (-180, -90, 0, 90, 180):
            points.append((f'{epoch + 1}-11-16T00:00:00Z', 0, lat, lon))
    for lat, lon in ((47.6, -122.3), (-33.9, 151.2), (51.5, -0.1), (35.7, 139.7), (-1.3, 36.8), (64.1, -21.9)):
        for iso, height in zip(dates, (0, 120, 1500, 9000, 100_000)):
            points.append((iso, height, lat, lon))
    draw = lcg(20251101)
    for _ in range(70):
        lat = round(-90 + 180 * draw(), 4)
        lon = round(-180 + 360 * draw(), 4)
        height = round(-1000 + 12_000 * draw() ** 3, 1)
        iso = dates[int(draw() * len(dates))]
        points.append((iso, height, lat, lon))
    return points


def grid_points(epoch):
    """Every 5 degrees of latitude and 10 of longitude, at two heights and five dates (6660 points), plus 4000 seeded
    random points: any place, any millisecond of the validity window, any height the model takes (-1 km to 850 km)."""
    points = []
    for lat in range(-90, 91, 5):
        for lon in range(-180, 180, 10):
            for k, iso in enumerate(window_dates(epoch)):
                points.append((iso, (0, 5000)[k % 2], float(lat), float(lon)))
    draw = lcg(7)
    start = datetime(epoch, 1, 1, tzinfo=timezone.utc)
    window_ms = int((datetime(epoch + 5, 1, 1, tzinfo=timezone.utc) - start).total_seconds() * 1000)
    for _ in range(4000):
        moment = start + timedelta(milliseconds=int(draw() * window_ms))
        iso = moment.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (moment.microsecond // 1000)
        points.append((iso, round(-1000 + 851_000 * draw(), 1), -90 + 180 * draw(), -180 + 360 * draw()))
    return points


def evaluate(model, iso, height_m, lat, lon):
    return model.field(D(float(lat)), D(float(lon)), D(float(height_m)) / 1000, decimal_of(year_from_iso(iso)))


# --- self-checks -------------------------------------------------------------------------------------------------

def check(label, ok, detail=''):
    print(('PASS  ' if ok else 'FAIL  ') + label + (f'  {detail}' if detail else ''))
    if not ok:
        sys.exit(1)


def self_check_normalisation():
    """Self-check 1: the Schmidt functions are normalised as defined: the integral of S^2 over x is (2 - d) 2 / (2n + 1)."""
    worst = Fraction(0)
    for n in range(1, NMAX + 1):
        for m in range(n + 1):
            q = rodrigues(n, m)
            squared = poly_mul(poly_pow([Fraction(1), Fraction(0), Fraction(-1)], m), poly_mul(q, q))
            integral = schmidt_factor_squared(n, m) * integral_minus1_to_1(squared)
            expected = Fraction((1 if m == 0 else 2) * 2, 2 * n + 1)
            worst = max(worst, abs(integral - expected))
    check('Legendre normalisation, degrees 1-12, exact', worst == 0, f'(largest error {worst})')


def self_check_noaa(model):
    """Self-check 2: NOAA's published rows, to half the last printed digit."""
    worst_nt = worst_deg = 0.0
    for year, h_km, lat, lon, x, y, z, h, f, i, d in NOAA_ROWS:
        got = model.field(lat, lon, h_km, year)
        for key, want in zip('xyzhf', (x, y, z, h, f)):
            worst_nt = max(worst_nt, abs(float(got[key]) - want))
        worst_deg = max(worst_deg, abs(got['i'] - i), abs(got['d'] - d))
    check('NOAA test rows, X Y Z H F to 0.05 nT', worst_nt <= 0.0501, f'(worst {worst_nt:.4f} nT)')
    check('NOAA test rows, I and D to 0.005 degrees', worst_deg <= 0.00501, f'(worst {worst_deg:.5f} degrees)')


def self_check_gradient(model):
    """Self-check 3: the components are the negative gradient of the potential, by central differences in 60 digits."""
    step = D(10) ** -14
    worst = D(0)
    dates = window_dates(int(model.epoch))
    for lat, lon, h_km, iso in ((47.6, -122.3, 0.3, dates[1]), (-33.9, 151.2, 2, dates[3]), (80, 0, 0, dates[0]), (-80, 240, 100, dates[2]), (0.5, 120, 0, dates[4]), (89.9, 10, 0, dates[1])):
        year = decimal_of(year_from_iso(iso))
        _, _, r, s, c = model.geodetic_to_geocentric(D(lat), D(h_km))
        lam = rad(D(lon))
        phi = D(float(atan2_deg(s, c))) * PI / 180  # only seeds the angle; the offsets below are in 60 digits
        # Recover phi' to full precision from (s, c): Newton steps on sin(phi) = s from that seed.
        for _ in range(4):
            sp, cp = sin_cos(phi)
            phi = phi - (sp - s) / cp
        b_r, b_phi, b_lambda = model.sums(s, c, r, lam, year)

        def v(dphi=D(0), dlam=D(0), dr=D(0)):
            sp, cp = sin_cos(phi + dphi)
            return model.potential(sp, cp, r + dr, lam + dlam, year)

        fd_r = -(v(dr=step) - v(dr=-step)) / (2 * step)
        fd_phi = -(v(dphi=step) - v(dphi=-step)) / (2 * step) / r
        fd_lambda = -(v(dlam=step) - v(dlam=-step)) / (2 * step) / (r * c)
        for got, want in ((b_r, fd_r), (b_phi, fd_phi), (b_lambda, fd_lambda)):
            worst = max(worst, abs(got - want) / max(abs(want), D(1)))
    check('field = -grad(potential), six places, relative error below 1e-20', worst < D(10) ** -20, f'(worst {float(worst):.2e})')


def run_checks(model):
    self_check_normalisation()
    self_check_noaa(model)
    self_check_gradient(model)


def noaa_rows_notice(model):
    """True if NOAA's 12 rows would show that this model is not the right one, to half the last printed digit."""
    for year, h_km, lat, lon, x, y, z, h, f, i, d in NOAA_ROWS:
        got = model.field(lat, lon, h_km, year)
        if any(abs(float(got[key]) - want) > 0.051 for key, want in zip('xyzhf', (x, y, z, h, f))):
            return True
        if abs(got['i'] - i) > 0.0051 or abs(got['d'] - d) > 0.0051:
            return True
    return False


def blindspot(model):
    """What the 12 NOAA rows cannot tell: change each coefficient value by one in its last printed digit (0.1 nT
    or 0.1 nT per year), either way, and count the changes the rows do not notice; then say how far those could move
    the field and the declination where a compass is usable, at the end of the model's validity."""
    unseen = []
    tried = 0
    for k, row in enumerate(model.rows):
        for column in range(4):
            if row[1] == 0 and column in (1, 3):  # a zonal row has no h term
                continue
            for sign in (1, -1):
                tried += 1
                changed = [list(r) for r in model.rows]
                changed[k][2 + column] += D('0.1') * sign
                variant = Model(changed, model.epoch)
                variant.legendre = model.legendre
                if not noaa_rows_notice(variant):
                    unseen.append((row[0], row[1], ('g', 'h', 'gdot', 'hdot')[column], sign, variant))
    print(f'{tried} single-last-digit changes tried; the 12 NOAA rows notice all but {len(unseen)}:')
    print('  ' + ', '.join(sorted({f'{n},{m} {name}' for n, m, name, _, _ in unseen})))
    worst_nt = worst_deg = 0.0
    last_day = f'{int(model.epoch) + 4}-12-31T12:00:00Z'
    for lat in range(-90, 91, 6):
        for lon in range(-180, 180, 12):
            base = evaluate(model, last_day, 0, float(lat), float(lon))
            if float(base['h']) < 2000:
                continue
            for _, _, _, _, variant in unseen:
                other = evaluate(variant, last_day, 0, float(lat), float(lon))
                worst_nt = max(worst_nt, *(abs(float(other[c] - base[c])) for c in 'xyz'))
                worst_deg = max(worst_deg, abs((other['d'] - base['d'] + 180) % 360 - 180))
    print(f'  the largest effect of those on a 6 x 12 degree grid where H >= 2000 nT: {worst_nt:.2f} nT in X, Y or Z, {worst_deg:.4f} degrees of declination')


# --- output ------------------------------------------------------------------------------------------------------

def number(value):
    return repr(float(value))


def print_table(model):
    print('/** [UTC date, height in metres, latitude, longitude, X, Y, Z in nT]: tests/unit/deno/wmm_reference.py, 60-digit arithmetic. */')
    print('const REFERENCE: Array<[string, number, number, number, number, number, number]> = [')
    for iso, height, lat, lon in pinned_points(int(model.epoch)):
        f = evaluate(model, iso, height, lat, lon)
        print(f"  ['{iso}', {height}, {lat}, {lon}, {number(f['x'])}, {number(f['y'])}, {number(f['z'])}],")
    print(']')


def print_grid(model):
    rows = []
    for iso, height, lat, lon in grid_points(int(model.epoch)):
        f = evaluate(model, iso, height, lat, lon)
        rows.append({'iso': iso, 'heightM': height, 'lat': lat, 'lon': lon, 'x': number(f['x']), 'y': number(f['y']), 'z': number(f['z'])})
    json.dump(rows, sys.stdout)
    print()


def main(argv):
    args = list(argv)
    if '--cof' in args:
        at = args.index('--cof')
        path = Path(args[at + 1])
        del args[at:at + 2]
    else:
        path = default_coefficients()
    rows, epoch = load_coefficients(path)
    model = Model(rows, epoch)
    mode = args[0] if args else 'check'
    if mode == 'check':
        run_checks(model)
        print(f'{len(rows)} coefficient rows, epoch {epoch}, from {path}')
    elif mode == 'table':
        print_table(model)
    elif mode == 'grid':
        print_grid(model)
    elif mode == 'blindspot':
        blindspot(model)
    else:
        sys.exit(f'unknown mode {mode!r}: check, table, grid or blindspot')


if __name__ == '__main__':
    main(sys.argv[1:])
