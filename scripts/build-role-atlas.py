#!/usr/bin/env python3
"""Compose the role portrait atlas from the per-role tiles.

`public/art/tiles/<role>.webp` is the art; `public/art/jrpg-role-atlas.webp` is
what the browser loads, one request for every portrait in both games. To change
a role's portrait, drop a 362x362 tile over its file and run this.

Setup:  python3 -m pip install pillow
Run:    python3 scripts/build-role-atlas.py
"""

from pathlib import Path

from PIL import Image

from role_art import COLS, ROWS, SLOTS, TILE

ROOT = Path(__file__).resolve().parents[1]
TILES = ROOT / "public" / "art" / "tiles"
ATLAS = ROOT / "public" / "art" / "jrpg-role-atlas.webp"


def main():
    atlas = Image.new("RGBA", (COLS * TILE, ROWS * TILE), (0, 0, 0, 0))
    missing = []
    for row, names in enumerate(SLOTS):
        for col, role in enumerate(names):
            if role is None:
                continue
            path = TILES / f"{role}.webp"
            if not path.exists():
                missing.append(role)
                continue
            tile = Image.open(path).convert("RGBA")
            if tile.size != (TILE, TILE):
                tile = tile.resize((TILE, TILE), Image.LANCZOS)
            atlas.paste(tile, (col * TILE, row * TILE))
    if missing:
        raise SystemExit(f"no tile for: {', '.join(sorted(missing))}")

    atlas.save(ATLAS, quality=92, method=6)
    print(f"wrote {ATLAS.relative_to(ROOT)} "
          f"({atlas.width}x{atlas.height}, {ATLAS.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
