"""Reference values for tests/unit/deno/enu.test.ts, derived without src/world/enu.ts.

Run:  python3 -I -B tests/unit/deno/enu_reference.py

Nothing here imports or ports the module under test. Two independent routes:

1. ECEF and ENU in 70-digit `decimal` arithmetic, from the textbook closed forms for the
   WGS-84 ellipsoid (a = 6378137 m, 1/f = 298.257223563) and the standard ECEF -> ENU rotation.
   The trigonometry is a Taylor series written out below, so no float libm is involved. This
   checks the module's double-precision arithmetic, to a few nanometres.

2. Vincenty's inverse geodesic problem on the same ellipsoid, in float64. It shares no formula
   with route 1 and gives the surface distance and the forward azimuth between two points. The
   horizontal ENU distance between two surface points is slightly shorter than that distance: the
   chord is shorter than the arc by s^3 / 24 R^2, and projecting it onto the origin's tangent plane
   loses another s^3 / 8 R^2 (about 3e-6 m and 9e-6 m at 1.4 km), so the two agree to about 1e-5 m
   there. That is the check on the module's *formulas* rather than its arithmetic.
"""
from decimal import Decimal as D, getcontext
import math

getcontext().prec = 70

PI = D('3.14159265358979323846264338327950288419716939937510582097494459230781640628620899')
A = D(6378137)
F = D(1) / D('298.257223563')
E2 = F * (2 - F)


def sin_cos(x):
    """Taylor series, after reducing x to [-pi, pi]."""
    two_pi = 2 * PI
    x = x - two_pi * ((x / two_pi).to_integral_value())
    s, c = D(0), D(0)
    term_s, term_c = x, D(1)
    for n in range(0, 80):
        if n > 0:
            term_c = term_c * (-x * x) / ((2 * n - 1) * (2 * n))
            term_s = term_s * (-x * x) / ((2 * n) * (2 * n + 1))
        c += term_c
        s += term_s
    return s, c


def rad(deg):
    return D(deg) * PI / 180


def ecef(lat, lng, h):
    slat, clat = sin_cos(rad(lat))
    slng, clng = sin_cos(rad(lng))
    n = A / (1 - E2 * slat * slat).sqrt()
    return ((n + D(h)) * clat * clng, (n + D(h)) * clat * slng, (n * (1 - E2) + D(h)) * slat)


def enu(origin, point):
    ox, oy, oz = ecef(*origin)
    px, py, pz = ecef(*point)
    dx, dy, dz = px - ox, py - oy, pz - oz
    slat, clat = sin_cos(rad(origin[0]))
    slng, clng = sin_cos(rad(origin[1]))
    east = -slng * dx + clng * dy
    north = -slat * clng * dx - slat * slng * dy + clat * dz
    up = clat * clng * dx + clat * slng * dy + slat * dz
    return east, north, up


def vincenty(lat1, lng1, lat2, lng2):
    a, f = 6378137.0, 1 / 298.257223563
    b = (1 - f) * a
    u1 = math.atan((1 - f) * math.tan(math.radians(lat1)))
    u2 = math.atan((1 - f) * math.tan(math.radians(lat2)))
    big_l = math.radians(lng2 - lng1)
    lam = big_l
    for _ in range(200):
        sin_s = math.hypot(math.cos(u2) * math.sin(lam),
                           math.cos(u1) * math.sin(u2) - math.sin(u1) * math.cos(u2) * math.cos(lam))
        cos_s = math.sin(u1) * math.sin(u2) + math.cos(u1) * math.cos(u2) * math.cos(lam)
        sigma = math.atan2(sin_s, cos_s)
        sin_alpha = math.cos(u1) * math.cos(u2) * math.sin(lam) / sin_s
        cos2_alpha = 1 - sin_alpha ** 2
        cos_2sm = cos_s - 2 * math.sin(u1) * math.sin(u2) / cos2_alpha if cos2_alpha else 0.0
        c = f / 16 * cos2_alpha * (4 + f * (4 - 3 * cos2_alpha))
        prev = lam
        lam = big_l + (1 - c) * f * sin_alpha * (
            sigma + c * sin_s * (cos_2sm + c * cos_s * (-1 + 2 * cos_2sm ** 2)))
        if abs(lam - prev) < 1e-14:
            break
    u_sq = cos2_alpha * (a * a - b * b) / (b * b)
    big_a = 1 + u_sq / 16384 * (4096 + u_sq * (-768 + u_sq * (320 - 175 * u_sq)))
    big_b = u_sq / 1024 * (256 + u_sq * (-128 + u_sq * (74 - 47 * u_sq)))
    d_sigma = big_b * sin_s * (cos_2sm + big_b / 4 * (
        cos_s * (-1 + 2 * cos_2sm ** 2) - big_b / 6 * cos_2sm * (-3 + 4 * sin_s ** 2) * (-3 + 4 * cos_2sm ** 2)))
    s = b * big_a * (sigma - d_sigma)
    az1 = math.degrees(math.atan2(math.cos(u2) * math.sin(lam),
                                  math.cos(u1) * math.sin(u2) - math.sin(u1) * math.cos(u2) * math.cos(lam)))
    return s, az1 % 360


def fmt(x):
    return format(x, '.14e') if isinstance(x, D) else repr(x)


# (name, lat, lng, height m)
POINTS = [
    ('san_francisco', '37.7749', '-122.4194', '10'),
    ('sydney', '-33.8688', '151.2093', '58'),
    ('london', '51.5007', '-0.1246', '11'),
    ('reykjavik', '64.1466', '-21.9426', '20'),
    ('quito', '-0.1807', '-78.4678', '2850'),
]
# Offsets from each origin: (dlat deg, dlng deg, dh m), 300 m to 1.4 km away.
OFFSETS = [('0.004', '0.000', '3'), ('0.000', '0.006', '-4'), ('-0.003', '-0.002', '12'), ('0.005', '0.007', '0'),
           ('0.009', '0.009', '-20')]


def num(x):
    if isinstance(x, D):
        # A coordinate that is zero by construction comes out as ~1e-64 of rounding: print it as 0.
        return '0' if abs(x) < D('1e-30') else format(x, '.15e')
    return repr(x)


if __name__ == '__main__':
    print('// ECEF, metres: [name, lat, lng, h, x, y, z]')
    for name, lat, lng, h in POINTS:
        x, y, z = ecef(lat, lng, h)
        print(f"  ['{name}', {lat}, {lng}, {h}, {num(x)}, {num(y)}, {num(z)}],")
    print()
    print('// ENU, metres, from the origin to origin + offset: [name, dLat, dLng, dH, east, north, up]')
    for name, lat, lng, h in POINTS:
        for dlat, dlng, dh in OFFSETS:
            p = (D(lat) + D(dlat), D(lng) + D(dlng), D(h) + D(dh))
            e, n, u = enu((D(lat), D(lng), D(h)), p)
            print(f"  ['{name}', {dlat}, {dlng}, {dh}, {num(e)}, {num(n)}, {num(u)}],")
    print()
    print('// Vincenty on the surface (height 0 at both ends), against the horizontal ENU distance: [name, dLat, dLng, metres, azimuth deg]')
    for name, lat, lng, h in POINTS:
        for dlat, dlng, dh in OFFSETS:
            s, az = vincenty(float(lat), float(lng), float(D(lat) + D(dlat)), float(D(lng) + D(dlng)))
            print(f"  ['{name}', {dlat}, {dlng}, {s!r}, {az!r}],")
