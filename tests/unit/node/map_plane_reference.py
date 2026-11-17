"""Reference values for tests/unit/node/map_plane_math.test.ts, derived without src/viewer/map-plane-math.ts.

Run:  python3 -I -B tests/unit/node/map_plane_reference.py

Nothing here imports or ports the module under test. Every printed number is `decimal` arithmetic at 70
digits, from definitions (the one float is the starting guess of the Newton iteration below, which is run on
to 60 digits):

1. Web Mercator (EPSG:3857) tile maths from the textbook forms: x = n (lng + 180) / 360 and
   y = n (1/2 - ln((1 + sin lat) / (1 - sin lat)) / (4 pi)), with n = 2^z. The module inverts the second
   with atan(sinh(.)); this script inverts it by Newton's method on the forward form, so the two routes
   share no formula for the inverse. The sine and cosine are a Taylor series written out below.
2. Tile ground width on the sphere Web Mercator is defined on: 2 pi a cos(lat) / 2^z, a = 6378137 m.
3. ECEF and ENU on the WGS-84 ellipsoid (a = 6378137 m, 1/f = 298.257223563) from the closed forms, as in
   tests/unit/deno/enu_reference.py, which tests the ENU module this one is built on.
4. The deviation of a four-corner tile quad from the exact positions inside it, sampled on a 17 x 17 grid: the
   bilinear patch east-north and up, which is the check research note R4 section 3 reports (56 um at z19 and
   51.5 N, 3.6 mm at z16), measured here a second way, and the quad drawn as two triangles in all three axes. The
   closed forms the first two follow are printed beside each row: M (2 pi)^2 sin(lat) cos(lat) / (8 4^z), M the
   meridional radius of curvature, for the east-west and north-south part (the northing's own curvature across the
   tile), and W^2 / (4 R) for the vertical part (the Earth's curvature across it). Three tiles are at 51.5 N and one,
   at z13, lies against the equator, where the east-west figure is small and a coarse grid (3 x 3) is 2.5 % short of it.

The asserts at the end tie the tables to the values the maps research behind WP-13 (note R4, whose float64 script
printed them) gives for the same inputs, and the values are written out in the asserts, so a regeneration that
drifted from them stops here instead of in the test, and nothing needs the note to run.
"""
from decimal import Decimal as D, getcontext
import math

getcontext().prec = 70

PI = D('3.14159265358979323846264338327950288419716939937510582097494459230781640628620899')
A = D(6378137)
F = D(1) / D('298.257223563')
E2 = F * (2 - F)
C = 2 * PI * A


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


# ---- Web Mercator tiles ------------------------------------------------------------------------------------

def lng_to_x(lng, z):
    return (D(lng) + 180) / 360 * (2 ** z)


def lat_to_y(lat, z):
    s, _ = sin_cos(rad(lat))
    return (D('0.5') - ((1 + s) / (1 - s)).ln() / (4 * PI)) * (2 ** z)


def x_to_lng(x, z):
    return D(x) / (2 ** z) * 360 - 180


def y_to_lat(y, z):
    """Newton on the forward form: f(phi) = y(phi) - Y, f'(phi) = -n / (2 pi cos phi)."""
    n = D(2 ** z)
    y = D(y)
    phi = D(math.atan(math.sinh(math.pi * (1 - 2 * float(y) / float(n)))))
    for _ in range(12):
        s, c = sin_cos(phi)
        fy = n * (D('0.5') - ((1 + s) / (1 - s)).ln() / (4 * PI))
        step = (fy - y) * 2 * PI * c / n
        phi = phi + step
        if abs(step) < D('1e-60'):
            break
    return phi * 180 / PI


def tile_width_m(lat, z):
    _, c = sin_cos(rad(lat))
    return C * c / (2 ** z)


# ---- ECEF and ENU ------------------------------------------------------------------------------------------

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


def corner_enu(origin, z, cx, cy):
    """ENU of the tile-grid point (cx, cy), at the origin's own height, from the origin."""
    lat = y_to_lat(cy, z)
    lng = x_to_lng(cx, z)
    return enu(origin, (lat, lng, origin[2]))


def meridional_radius(lat):
    s, _ = sin_cos(rad(lat))
    return A * (1 - E2) / (1 - E2 * s * s) ** D('1.5')


def deviation(origin, z, tx, ty, steps=16):
    """Max over a (steps+1)^2 grid of the gap between the quad through the four exact corners and the exact position:
    the bilinear patch east-north (horizontal) and up (vertical), and the quad drawn as two triangles split along the
    north-west to south-east diagonal, in all three axes."""
    nw = corner_enu(origin, z, tx, ty)
    ne = corner_enu(origin, z, tx + 1, ty)
    se = corner_enu(origin, z, tx + 1, ty + 1)
    sw = corner_enu(origin, z, tx, ty + 1)
    horizontal, vertical, triangulated = D(0), D(0), D(0)
    for i in range(steps + 1):
        for j in range(steps + 1):
            u, v = D(i) / steps, D(j) / steps
            exact = corner_enu(origin, z, D(tx) + u, D(ty) + v)
            bil = [(1 - u) * (1 - v) * nw[k] + u * (1 - v) * ne[k] + u * v * se[k] + (1 - u) * v * sw[k] for k in range(3)]
            horizontal = max(horizontal, ((exact[0] - bil[0]) ** 2 + (exact[1] - bil[1]) ** 2).sqrt())
            vertical = max(vertical, abs(exact[2] - bil[2]))
            if u >= v:  # triangle nw, ne, se
                tri = [nw[k] + u * (ne[k] - nw[k]) + v * (se[k] - ne[k]) for k in range(3)]
            else:  # triangle nw, se, sw
                tri = [nw[k] + v * (sw[k] - nw[k]) + u * (se[k] - sw[k]) for k in range(3)]
            triangulated = max(triangulated, sum((exact[k] - tri[k]) ** 2 for k in range(3)).sqrt())
    return horizontal, vertical, triangulated


def num(x, digits=15):
    if isinstance(x, D):
        return '0' if abs(x) < D('1e-30') else format(x, '.%de' % digits)
    return repr(x)


# (name, lat, lng)
PLACES = [
    ('london', '51.5', '-0.1'),
    ('los_angeles', '33.5', '-117.0'),
    ('tromso', '60', '10'),
    ('equator', '0', '0'),
    ('greenwich', '51.4769', '-0.0005'),
    ('sydney', '-33.8688', '151.2093'),
]
ZOOMS = [0, 1, 15, 16, 19]

if __name__ == '__main__':
    print('// Tiles: [name, lat, lng, z, tileX, tileY, fracX, fracY, nwLat, nwLng, seLat, seLng]')
    tables = {}
    for name, lat, lng in PLACES:
        for z in ZOOMS:
            fx, fy = lng_to_x(lng, z), lat_to_y(lat, z)
            tx, ty = int(fx), int(fy)
            nw_lat, nw_lng = y_to_lat(ty, z), x_to_lng(tx, z)
            se_lat, se_lng = y_to_lat(ty + 1, z), x_to_lng(tx + 1, z)
            tables[(name, z)] = (tx, ty, nw_lat, nw_lng, se_lat, se_lng)
            print(f"  ['{name}', {lat}, {lng}, {z}, {tx}, {ty}, {num(fx - tx)}, {num(fy - ty)}, "
                  f"{num(nw_lat)}, {num(nw_lng)}, {num(se_lat)}, {num(se_lng)}],")
    print()
    print('// Nominal tile width, metres, 2 pi a cos(lat) / 2^z: [lat, z, widthM]')
    for lat in ['0', '33.5', '51.5', '60', '-33.8688']:
        for z in [15, 16, 17, 18, 19, 20, 21]:
            print(f"  [{lat}, {z}, {num(tile_width_m(lat, z))}],")
    print()
    print('// The limit of the square: atan(sinh(pi)) in degrees, from y = 0')
    print('//  ', num(y_to_lat(0, 0)))
    print()

    tx19, ty19 = tables[('london', 19)][0], tables[('london', 19)][1]
    tx16, ty16 = tables[('london', 16)][0], tables[('london', 16)][1]

    print('// Exact tile corners from an origin, ENU metres at the origin height: '
          '[z, tileX, tileY, originLat, originLng, originAlt, [east, north, up] x NW, NE, SE, SW]')
    origins = [
        (19, tx19, ty19, '51.5001', '-0.1000', '35'),
        (19, tx19, ty19, '51.50019', '-0.09993', '0'),
        (16, tx16, ty16, '51.5', '-0.1', '10'),
        (19, tables[('sydney', 19)][0], tables[('sydney', 19)][1], '-33.8688', '151.2093', '58'),
    ]
    for z, tx, ty, olat, olng, oalt in origins:
        origin = (D(olat), D(olng), D(oalt))
        corners = [corner_enu(origin, z, tx, ty), corner_enu(origin, z, tx + 1, ty),
                   corner_enu(origin, z, tx + 1, ty + 1), corner_enu(origin, z, tx, ty + 1)]
        flat = ', '.join('[' + ', '.join(num(v) for v in c) + ']' for c in corners)
        print(f"  [{z}, {tx}, {ty}, {olat}, {olng}, {oalt}, {flat}],")
    print()

    print('// Quad deviation, metres: [z, tileX, tileY, originLat, originLng, originAlt, horizontalM, verticalM, triangulatedM]')
    centre19 = (
        (y_to_lat(ty19, 19) + y_to_lat(ty19 + 1, 19)) / 2,
        (x_to_lng(tx19, 19) + x_to_lng(tx19 + 1, 19)) / 2,
        D(0),
    )
    centre16 = (
        (y_to_lat(ty16, 16) + y_to_lat(ty16 + 1, 16)) / 2,
        (x_to_lng(tx16, 16) + x_to_lng(tx16 + 1, 16)) / 2,
        D(0),
    )
    far_origin = (D('51.5013'), D('-0.0981'), D('35'))
    # The tile that holds 0.001 degrees north at 12.3 east, at z13: it lies against the equator, where the east-west figure
    # is small and its worst sample is not one a coarse grid takes (a 3 x 3 grid is 2.5 % short of it).
    tx13, ty13 = int(lng_to_x('12.3', 13)), int(lat_to_y('0.001', 13))
    centre13 = (
        (y_to_lat(ty13, 13) + y_to_lat(ty13 + 1, 13)) / 2,
        (x_to_lng(tx13, 13) + x_to_lng(tx13 + 1, 13)) / 2,
        D(0),
    )
    for z, tx, ty, origin in [
        (19, tx19, ty19, centre19),
        (16, tx16, ty16, centre16),
        (19, tx19, ty19, far_origin),
        (13, tx13, ty13, centre13),
    ]:
        h, v, tri = deviation(origin, z, tx, ty)
        lat = (y_to_lat(ty, z) + y_to_lat(ty + 1, z)) / 2
        s, c = sin_cos(rad(lat))
        closed_h = meridional_radius(lat) * (2 * PI) ** 2 * s * c / (8 * D(4) ** z)
        width = tile_width_m(lat, z)
        closed_v = width * width / (4 * A)
        print(f"  [{z}, {tx}, {ty}, {num(origin[0])}, {num(origin[1])}, {num(origin[2])}, {num(h)}, {num(v)}, {num(tri)}],"
              f"  // closed form: horizontal {num(closed_h, 6)}, vertical {num(closed_v, 6)}")
    print()

    # Ties to the research script's float64 output (research/r4_tilemath.mjs, golden vectors and corner offsets).
    tol = D('1e-9')
    r = tables[('london', 15)]
    assert (r[0], r[1]) == (16374, 10897)
    assert abs(r[2] - D('51.501904108')) < tol and abs(r[3] - D('-0.109863281')) < tol
    r = tables[('london', 19)]
    assert (r[0], r[1]) == (261998, 174356)
    assert abs(r[2] - D('51.500194359')) < tol and abs(r[3] - D('-0.100250244')) < tol
    assert abs(r[4] - D('51.499766912')) < tol and abs(r[5] - D('-0.099563599')) < tol
    r = tables[('los_angeles', 19)]
    assert (r[0], r[1]) == (91750, 210312)
    r = tables[('tromso', 19)]
    assert (r[0], r[1]) == (276707, 152253)
    r = tables[('greenwich', 19)]
    assert (r[0], r[1]) == (262143, 174410)
    r = tables[('equator', 19)]
    assert (r[0], r[1]) == (262144, 262144)
    assert abs(tile_width_m('51.5', 19) - D('47.583')) < D('0.001')
    assert abs(tile_width_m('33.5', 19) - D('63.740')) < D('0.001')
    co = (centre19[0], centre19[1], D(0))
    nw = corner_enu(co, 19, tx19, ty19)
    assert abs(nw[0] - D('-23.8404')) < D('0.0001') and abs(nw[1] - D('23.7785')) < D('0.0001')
    h, _, _ = deviation(centre19, 19, tx19, ty19)
    assert abs(h - D('5.590e-5')) < D('5e-8')
    print('// ties to the research script hold')
