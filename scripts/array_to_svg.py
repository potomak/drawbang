#!/usr/bin/env python3
"""Convert a 256-element 16x16 pixel array (JSON) to SVG of black 1x1 rects.

Value 16 = transparent (skipped); any other value renders as a black rect.

Usage:
    scripts/array_to_svg.py < pixels.json
    scripts/array_to_svg.py pixels.json > out.svg
    echo '[15,16, ...]' | scripts/array_to_svg.py
"""
import json
import sys

WIDTH = 16
HEIGHT = 16
TRANSPARENT = 16


def to_svg(pixels):
    if len(pixels) != WIDTH * HEIGHT:
        raise ValueError(f"expected {WIDTH * HEIGHT} pixels, got {len(pixels)}")
    rects = [
        f'<rect x="{i % WIDTH}" y="{i // WIDTH}" width="1" height="1"/>'
        for i, v in enumerate(pixels)
        if v != TRANSPARENT
    ]
    body = "\n  ".join(rects)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {WIDTH} {HEIGHT}" '
        f'shape-rendering="crispEdges" fill="black">\n  '
        f'{body}\n</svg>\n'
    )


def main():
    src = open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin
    pixels = json.load(src)
    sys.stdout.write(to_svg(pixels))


if __name__ == "__main__":
    main()
