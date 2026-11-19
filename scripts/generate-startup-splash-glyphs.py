#!/usr/bin/env python3
"""Writes src/shared/startup-splash-glyphs.ts: the wordmark "Ready" in Instrument Serif (the app's wordmark face,
src/renderer/design/next/fonts/InstrumentSerif.woff2), as the startup splash draws it.

For each glyph: its pen position, its outline (SVG path, for the solid fill), its contours as polylines (for the
hairline that draws itself), and up to seven anchor points (the corners where the orange dots land). Units are em,
y points down, the baseline is y = 0; the letters are set as the shell sets the wordmark (kerned, tracking -0.01em).

Needs Python 3 with fonttools, brotli and uharfbuzz:
  python3 -m pip install --target /some/tmp/dir fonttools brotli uharfbuzz
  PYTHONPATH=/some/tmp/dir python3 scripts/generate-startup-splash-glyphs.py
"""
import io
import json
import math
import os

import uharfbuzz as hb
from fontTools.pens.basePen import BasePen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(REPO, 'src/renderer/design/next/fonts/InstrumentSerif.woff2')
OUT = os.path.join(REPO, 'src/shared/startup-splash-glyphs.ts')
TEXT = 'Ready'
TRACKING = -0.01        # em, as .shell-wordmark
FLATTEN_STEP = 10       # font units between polyline points (0.01em: about a pixel at the splash size)
ANCHORS_PER_GLYPH = 7
CORNER_DEGREES = 38     # a turn sharper than this on the outline is a corner
ANCHOR_SPACING = 0.06   # em: corners closer than this count once


class Flatten(BasePen):
    """Each contour as a closed polyline in font units."""

    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.contours, self.current = [], None

    def _moveTo(self, p):
        self.current = [p]

    def _lineTo(self, p):
        self.current.append(p)

    def _sample(self, points, at):
        start = self.current[-1]
        length = sum(math.dist(a, b) for a, b in zip([start] + points[:-1], points))
        steps = max(2, int(length / FLATTEN_STEP))
        for i in range(1, steps + 1):
            self.current.append(at(start, i / steps))

    def _curveToOne(self, p1, p2, p3):
        self._sample([p1, p2, p3], lambda p0, t: tuple(
            (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * p1[k] + 3 * (1 - t) * t * t * p2[k] + t ** 3 * p3[k] for k in (0, 1)))

    def _qCurveToOne(self, p1, p2):
        self._sample([p1, p2], lambda p0, t: tuple(
            (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * p1[k] + t * t * p2[k] for k in (0, 1)))

    def _closePath(self):
        if self.current:
            if self.current[0] != self.current[-1]:
                self.current.append(self.current[0])
            self.contours.append(self.current)
        self.current = None

    _endPath = _closePath


def anchors(recording, scale):
    """The outline's corners, spread out: the places a dot can land on and still read as part of the letter."""
    contours, current = [], []
    for op, args in recording.value:
        if op == 'moveTo':
            if current:
                contours.append(current)
            current = [args[-1]]
        elif op in ('lineTo', 'curveTo', 'qCurveTo'):
            current.append(args[-1])
        elif op in ('closePath', 'endPath'):
            if current:
                contours.append(current)
            current = []
    corners = []
    for points in contours:
        if len(points) > 1 and points[0] == points[-1]:
            points = points[:-1]
        for i, here in enumerate(points):
            before, after = points[i - 1], points[(i + 1) % len(points)]
            v1, v2 = (here[0] - before[0], here[1] - before[1]), (after[0] - here[0], after[1] - here[1])
            l1, l2 = math.hypot(*v1), math.hypot(*v2)
            if l1 < 1e-6 or l2 < 1e-6:
                continue
            cosine = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)))
            if math.degrees(math.acos(cosine)) > CORNER_DEGREES:
                corners.append((here[0] * scale, -here[1] * scale))
    spread = []
    for point in corners:
        if all(math.dist(point, kept) > ANCHOR_SPACING for kept in spread):
            spread.append(point)
    if len(spread) > ANCHORS_PER_GLYPH:  # farthest-point sampling keeps them apart
        kept = [spread[0]]
        while len(kept) < ANCHORS_PER_GLYPH:
            kept.append(max(spread, key=lambda p: min(math.dist(p, q) for q in kept)))
        spread = kept
    return [[round(x, 4), round(y, 4)] for x, y in spread]


def main():
    font = TTFont(FONT)
    font.flavor = None
    raw = io.BytesIO()
    font.save(raw)
    data = raw.getvalue()
    font = TTFont(io.BytesIO(data))
    glyph_set, order = font.getGlyphSet(), font.getGlyphOrder()
    scale = 1 / font['head'].unitsPerEm

    buffer = hb.Buffer()
    buffer.add_str(TEXT)
    buffer.guess_segment_properties()
    hb.shape(hb.Font(hb.Face(hb.Blob(data))), buffer, {'kern': True, 'liga': True})

    pen_x, glyphs = 0.0, []
    for index, (info, position) in enumerate(zip(buffer.glyph_infos, buffer.glyph_positions)):
        glyph = glyph_set[order[info.codepoint]]
        outline = SVGPathPen(glyph_set, ntos=lambda v: ('%.4f' % v).rstrip('0').rstrip('.'))
        glyph.draw(TransformPen(outline, (scale, 0, 0, -scale, 0, 0)))
        recording = RecordingPen()
        glyph.draw(recording)
        flat = Flatten(glyph_set)
        glyph.draw(flat)
        glyphs.append({
            'char': TEXT[info.cluster],
            'x': round(pen_x + position.x_offset * scale, 4),
            'd': outline.getCommands(),
            'contours': [[v for x, y in contour for v in (round(x * scale, 4), round(-y * scale, 4))] for contour in flat.contours],
            'anchors': anchors(recording, scale),
        })
        pen_x += position.x_advance * scale + (TRACKING if index < len(TEXT) - 1 else 0)

    hhea = font['hhea']
    payload = {'text': TEXT, 'width': round(pen_x, 4), 'ascent': hhea.ascent * scale, 'descent': -hhea.descent * scale, 'glyphs': glyphs}
    with open(OUT, 'w') as out:
        out.write('// Generated by scripts/generate-startup-splash-glyphs.py from src/renderer/design/next/fonts/InstrumentSerif.woff2\n')
        out.write('// (Instrument Serif, SIL OFL 1.1). Do not edit by hand: change the script and run it again.\n')
        out.write('// Units are em; y points down; the baseline is y = 0. Contours are flat [x0, y0, x1, y1, …] polylines.\n\n')
        out.write('export interface StartupSplashGlyph {\n  char: string\n  x: number\n  d: string\n  contours: number[][]\n  anchors: Array<[number, number]>\n}\n\n')
        out.write('export const STARTUP_SPLASH_WORDMARK: {\n  text: string\n  width: number\n  ascent: number\n  descent: number\n  glyphs: StartupSplashGlyph[]\n} = ')
        out.write(json.dumps(payload, separators=(',', ':')))
        out.write('\n')
    print(TEXT, 'width', payload['width'], 'em;', ', '.join(f"{g['char']}: {len(g['anchors'])} anchors, {sum(len(c) // 2 for c in g['contours'])} points" for g in glyphs))
    print('wrote', os.path.relpath(OUT, REPO), os.path.getsize(OUT) // 1024, 'KB')


if __name__ == '__main__':
    main()
