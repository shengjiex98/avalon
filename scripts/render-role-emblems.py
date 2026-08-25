#!/usr/bin/env python3
"""Draw the placeholder tiles for roles that have no painted portrait yet.

Six roles used to borrow another role's face — the Drunk wore the Villager's
flower basket, the Tanner wore Oberon's antlers. Until painted portraits exist
they get a gold emblem of their own instead: still wrong-looking next to a
painted bust, but at least it is *their* symbol. Replacing one is a matter of
dropping a painted 362x362 tile over the file this writes and re-running
`scripts/build-role-atlas.py`.

Setup:  python3 -m pip install pillow
Run:    python3 scripts/render-role-emblems.py [--force]

Existing tiles are left alone unless --force is passed, so this cannot paint
over a portrait that has since been drawn properly.
"""

import argparse
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from role_art import TILE

ROOT = Path(__file__).resolve().parents[1]
TILES = ROOT / "public" / "art" / "tiles"
# The frame is lifted off a painted tile so the placeholders sit in the same
# set as the portraits rather than beside them.
FRAME_SOURCE = TILES / "percival.webp"
FRAME_INNER, FRAME_OUTER = 154, 173

SS = 4                      # supersampling factor; everything is drawn 4x up
R = TILE / 2                # unit 1.0 in emblem coordinates is the tile radius

GOLD_TOP = (255, 233, 168)
GOLD_MID = (240, 201, 107)
GOLD_LOW = (176, 118, 26)
FIELD_IN = (28, 47, 92)
FIELD_OUT = (6, 12, 32)


# --- drawing kit ------------------------------------------------------------
# Emblems are written in unit coordinates: (0, 0) is the middle of the tile,
# 1.0 is its radius, y grows downwards. `Pen` maps that onto the supersampled
# mask everything is drawn into.

class Pen:
    def __init__(self):
        self.size = TILE * SS
        self.mask = Image.new("L", (self.size, self.size), 0)
        self.draw = ImageDraw.Draw(self.mask)

    def px(self, point):
        x, y = point
        return (self.size / 2 + x * R * SS, self.size / 2 + y * R * SS)

    def poly(self, points, ink=255):
        self.draw.polygon([self.px(p) for p in points], fill=ink)

    def line(self, points, width, ink=255, round_ends=True):
        pts = [self.px(p) for p in points]
        self.draw.line(pts, fill=ink, width=int(width * R * SS), joint="curve")
        if round_ends:
            for p in (pts[0], pts[-1]):
                self.dot_px(p, width / 2, ink)

    def dot_px(self, point, radius, ink=255):
        r = radius * R * SS
        x, y = point
        self.draw.ellipse([x - r, y - r, x + r, y + r], fill=ink)

    def dot(self, centre, radius, ink=255):
        self.dot_px(self.px(centre), radius, ink)

    def band(self, centre, radius, thickness, start, end, ink=255):
        """An arc drawn with real thickness, in degrees, 0 = east."""
        x, y = self.px(centre)
        r = radius * R * SS
        self.draw.arc([x - r, y - r, x + r, y + r], start, end,
                      fill=ink, width=int(thickness * R * SS))

    def result(self):
        return self.mask.resize((TILE, TILE), Image.LANCZOS)


def rotate(points, degrees, about=(0.0, 0.0)):
    a = math.radians(degrees)
    ox, oy = about
    out = []
    for x, y in points:
        dx, dy = x - ox, y - oy
        out.append((ox + dx * math.cos(a) - dy * math.sin(a),
                    oy + dx * math.sin(a) + dy * math.cos(a)))
    return out


def shift(points, dx, dy):
    return [(x + dx, y + dy) for x, y in points]


def rounded_poly(pen, points, width, ink=255):
    """A closed outline with round joins — cheaper than stroking a path."""
    pen.line(list(points) + [points[0]], width, ink)


# --- the emblems ------------------------------------------------------------

def drunk(pen):
    """A tankard, tipped, with the foam going over the side."""
    tilt = -9
    body = rotate([(-0.29, -0.18), (0.29, -0.18), (0.24, 0.42), (-0.24, 0.42)], tilt)
    pen.poly(body)
    for corner in (body[2], body[3]):
        pen.dot(corner, 0.05)

    # Handle: a thick C, rooted far enough left to be part of the tankard.
    pen.band(rotate([(0.30, 0.06)], tilt)[0], 0.21, 0.085, -80, 80)

    # The base band and the shine down the belly, cut back out of the gold.
    pen.poly(rotate([(-0.27, 0.28), (0.27, 0.28), (0.27, 0.315), (-0.27, 0.315)], tilt), ink=0)
    pen.poly(rotate([(-0.15, -0.10), (-0.09, -0.10), (-0.11, 0.20), (-0.17, 0.20)], tilt), ink=0)

    # Foam: overlapping domes riding the rim, one head spilling down the side.
    for cx, cy, r in ((-0.23, -0.23, 0.115), (-0.04, -0.29, 0.135),
                      (0.17, -0.24, 0.12), (0.30, -0.15, 0.085)):
        pen.dot(rotate([(cx, cy)], tilt)[0], r)
    pen.poly(rotate([(-0.33, -0.23), (-0.21, -0.23), (-0.19, 0.08), (-0.29, 0.06)], tilt))
    pen.dot(rotate([(-0.24, 0.10)], tilt)[0], 0.055)


def insomniac(pen):
    """An eye still open under a night sky."""
    eye = (0.0, 0.16)
    lid = [(-0.46, 0.16), (-0.22, -0.10), (0.0, -0.16), (0.22, -0.10), (0.46, 0.16),
           (0.22, 0.42), (0.0, 0.48), (-0.22, 0.42)]
    pen.poly(lid)
    pen.poly([(p[0] * 0.80, eye[1] + (p[1] - eye[1]) * 0.74) for p in lid], ink=0)
    pen.dot(eye, 0.155)
    pen.dot(eye, 0.075, ink=0)
    pen.dot((eye[0] - 0.055, eye[1] - 0.055), 0.032)

    # Lashes, splayed to say "still awake" rather than "watching".
    for angle in (-52, -26, 0, 26, 52):
        root = (eye[0] + 0.40 * math.sin(math.radians(angle)),
                eye[1] - 0.30 * math.cos(math.radians(angle)))
        pen.line([root, (root[0] * 1.30, root[1] - 0.16)], 0.035)

    # Moon and stars overhead.
    pen.dot((0.42, -0.52), 0.17)
    pen.dot((0.50, -0.58), 0.15, ink=0)
    for cx, cy, r in ((-0.44, -0.46, 0.055), (-0.62, -0.20, 0.038), (-0.24, -0.66, 0.034)):
        pen.poly([(cx, cy - r * 2.6), (cx + r * 0.6, cy - r * 0.6), (cx + r * 2.6, cy),
                  (cx + r * 0.6, cy + r * 0.6), (cx, cy + r * 2.6),
                  (cx - r * 0.6, cy + r * 0.6), (cx - r * 2.6, cy),
                  (cx - r * 0.6, cy - r * 0.6)])


def troublemaker(pen):
    """Two cards and the exchange sign: swapped, and neither one looked at."""
    for sign in (-1, 1):
        centre = (sign * 0.33, 0.36)
        pen.poly(shift(rotate([(-0.18, -0.27), (0.18, -0.27), (0.18, 0.27), (-0.18, 0.27)],
                              sign * 13), *centre))
        pen.poly(shift(rotate([(-0.12, -0.21), (0.12, -0.21), (0.12, 0.21), (-0.12, 0.21)],
                              sign * 13), *centre), ink=0)
        pen.poly(shift(rotate([(0.0, -0.10), (0.075, 0.0), (0.0, 0.10), (-0.075, 0.0)],
                              sign * 13), *centre))

    # The exchange sign above them, one arrow each way.
    for side, y in ((1, -0.38), (-1, -0.10)):
        pen.line([(side * -0.30, y), (side * 0.22, y)], 0.055)
        pen.poly([(side * 0.44, y), (side * 0.20, y - 0.115), (side * 0.20, y + 0.115)])


def mason(pen):
    """A trowel over fresh courses of brick: the pair that builds together."""
    for y, xs in ((0.26, (-0.32, 0.0, 0.32)), (0.47, (-0.48, -0.16, 0.16, 0.48))):
        for x in xs:
            rounded_poly(pen, [(x - 0.14, y - 0.073), (x + 0.14, y - 0.073),
                               (x + 0.14, y + 0.073), (x - 0.14, y + 0.073)], 0.036)

    # The trowel, laid diagonally across the wall: solid blade, short grip.
    pen.poly(rotate([(0.0, -0.62), (0.27, -0.20), (0.10, 0.14), (-0.10, 0.14),
                     (-0.27, -0.20)], 20))
    pen.line(rotate([(0.0, 0.10), (0.0, 0.22)], 20), 0.06)
    pen.line(rotate([(0.0, 0.20), (0.0, 0.52)], 20), 0.13)


def hunter(pen):
    """A bow, drawn, with the arrow already on the string."""
    pen.band((0.34, 0.0), 0.60, 0.07, 122, 238)
    for side in (-1, 1):
        pen.line([(0.02, side * 0.50), (-0.11, side * 0.63)], 0.055)
    pen.line([(0.02, -0.56), (0.02, 0.56)], 0.020)        # string

    pen.line([(0.02, 0.0), (0.60, 0.0)], 0.034)           # shaft
    pen.poly([(0.78, 0.0), (0.54, -0.115), (0.54, 0.115)])
    for side in (-1, 1):                                  # fletching
        pen.poly([(0.07, side * 0.022), (0.25, side * 0.022),
                  (0.21, side * 0.115), (0.05, side * 0.095)])


def tanner(pen):
    """A pelt hung out to dry — the job the Tanner would rather leave."""
    pen.line([(-0.62, -0.50), (0.62, -0.50)], 0.045)
    for x in (-0.62, 0.62):
        pen.line([(x, -0.62), (x, -0.38)], 0.045)

    pelt = [(-0.30, -0.60), (0.30, -0.60), (0.44, -0.32), (0.34, -0.04), (0.46, 0.20),
            (0.38, 0.54), (0.16, 0.32), (0.06, 0.52), (-0.06, 0.52), (-0.16, 0.32),
            (-0.38, 0.54), (-0.46, 0.20), (-0.34, -0.04), (-0.44, -0.32)]
    pen.poly(pelt)
    for corner in pelt:
        pen.dot(corner, 0.028)

    # A seam down the middle and the grain either side of it.
    pen.line([(0.0, -0.44), (0.0, 0.26)], 0.030, ink=0)
    for x in (-0.20, 0.20):
        pen.line([(x, -0.30), (x * 1.15, 0.06)], 0.022, ink=0)


EMBLEMS = {
    "drunk": drunk,
    "insomniac": insomniac,
    "troublemaker": troublemaker,
    "mason": mason,
    "hunter": hunter,
    "tanner": tanner,
}


# --- assembly ---------------------------------------------------------------

def gold_leaf():
    """Warm at the top, dark at the bottom, with the mid tone kept broad."""
    ramp = Image.new("RGB", (1, 256))
    for i in range(256):
        t = i / 255
        if t < 0.45:
            a, b, k = GOLD_TOP, GOLD_MID, t / 0.45
        else:
            a, b, k = GOLD_MID, GOLD_LOW, (t - 0.45) / 0.55
        ramp.putpixel((0, i), tuple(round(p + (q - p) * k) for p, q in zip(a, b)))
    return ramp.resize((TILE, TILE), Image.BILINEAR)


def field():
    """The dark radial the painted portraits sit on."""
    n = 96
    small = Image.new("RGB", (n, n))
    px = small.load()
    for y in range(n):
        for x in range(n):
            d = math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2)
            t = min(1.0, (d * 1.06) ** 1.5)
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(FIELD_IN, FIELD_OUT))
    return small.resize((TILE, TILE), Image.BICUBIC)


def disc(radius):
    big = Image.new("L", (TILE * SS, TILE * SS), 0)
    c, r = TILE * SS / 2, radius * SS
    ImageDraw.Draw(big).ellipse([c - r, c - r, c + r, c + r], fill=255)
    return big.resize((TILE, TILE), Image.LANCZOS)


def frame_ring():
    if not FRAME_SOURCE.exists():
        raise SystemExit(f"{FRAME_SOURCE} is the frame these are drawn on, and it is missing")
    source = Image.open(FRAME_SOURCE).convert("RGBA")
    big = Image.new("L", (TILE * SS, TILE * SS), 0)
    d = ImageDraw.Draw(big)
    c = TILE * SS / 2
    for radius, ink in ((FRAME_OUTER * SS, 255), (FRAME_INNER * SS, 0)):
        d.ellipse([c - radius, c - radius, c + radius, c + radius], fill=ink)
    ring = source.copy()
    ring.putalpha(ImageChops.multiply(source.getchannel("A"), big.resize((TILE, TILE), Image.LANCZOS)))
    # The atlas leaves a red halo outside the frame; it must not tint the ring.
    px = ring.load()
    for y in range(TILE):
        for x in range(TILE):
            r, g, b, a = px[x, y]
            if a and r > 120 and g < 70 and b < 70:
                px[x, y] = (0, 0, 0, 0)
    return ring


def render(role, ring):
    pen = Pen()
    EMBLEMS[role](pen)
    mask = pen.result()

    tile = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
    tile.paste(field(), (0, 0), disc(FRAME_OUTER - 6))

    glow = Image.new("RGBA", (TILE, TILE), (255, 206, 120, 0))
    glow.putalpha(mask.filter(ImageFilter.GaussianBlur(11)).point(lambda v: int(v * 0.42)))
    tile = Image.alpha_composite(tile, glow)

    shadow = Image.new("RGBA", (TILE, TILE), (3, 7, 20, 0))
    shadow.putalpha(ImageChops.offset(mask, 0, 5).filter(ImageFilter.GaussianBlur(3))
                    .point(lambda v: int(v * 0.75)))
    tile = Image.alpha_composite(tile, shadow)

    emblem = gold_leaf().convert("RGBA")
    emblem.putalpha(mask)
    tile = Image.alpha_composite(tile, emblem)

    # A hairline of the highlight tone along the top of the emblem.
    edge = ImageChops.subtract(mask, ImageChops.offset(mask, 0, 3))
    sheen = Image.new("RGBA", (TILE, TILE), GOLD_TOP + (0,))
    sheen.putalpha(edge.point(lambda v: int(v * 0.55)))
    tile = Image.alpha_composite(tile, sheen)

    tile.paste((0, 0, 0, 0), (0, 0), disc(FRAME_OUTER - 6).point(lambda v: 255 - v))
    return Image.alpha_composite(tile, ring)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="redraw tiles that already exist")
    args = parser.parse_args()

    TILES.mkdir(parents=True, exist_ok=True)
    ring = frame_ring()
    for role in EMBLEMS:
        out = TILES / f"{role}.webp"
        if out.exists() and not args.force:
            print(f"kept {out.relative_to(ROOT)}")
            continue
        render(role, ring).save(out, quality=94, method=6)
        print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
