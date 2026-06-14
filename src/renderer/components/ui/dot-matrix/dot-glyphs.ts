/**
 * 9×9 dot-matrix glyph bitmaps — the round-dot icon language borrowed from the
 * MIT-licensed vibe-nothing-ui-design dictionary and trimmed to the glyphs the
 * agent status indicator needs.
 *
 * Each glyph is exactly 9 rows of 9 chars: '#' = a lit cell rendered as a
 * COMPLETE circle, '.' = empty. New glyphs MUST stay 9×9 and use only complete
 * cells — never build them with mask/clip, which cuts dots into half-circles.
 */
export const DOT_GLYPH_SIZE = 9

export type DotGlyphName = 'idle' | 'running' | 'needs_input' | 'done' | 'error'

/** Rendering intent — `signal` is reserved for genuine signals (handled in CSS). */
export type DotGlyphTone = 'neutral' | 'signal'

const GLYPHS: Record<DotGlyphName, readonly string[]> = {
  // calm static marker (idle / queued)
  idle: [
    '.........',
    '.........',
    '.........',
    '....#....',
    '...###...',
    '....#....',
    '.........',
    '.........',
    '.........',
  ],
  // filled disc — pulses via CSS while active
  running: [
    '.........',
    '...###...',
    '..#####..',
    '.#######.',
    '.#######.',
    '.#######.',
    '..#####..',
    '...###...',
    '.........',
  ],
  // exclamation — a genuine "needs decision" signal
  needs_input: [
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '...###...',
    '....#....',
    '.........',
    '...###...',
    '.........',
  ],
  // check
  done: [
    '.........',
    '........#',
    '.......##',
    '......##.',
    '#....##..',
    '##..##...',
    '.####....',
    '..##.....',
    '.........',
  ],
  // cross
  error: [
    '#.......#',
    '##.....##',
    '.##...##.',
    '..##.##..',
    '...###...',
    '..##.##..',
    '.##...##.',
    '##.....##',
    '#.......#',
  ],
}

export const DOT_GLYPH_NAMES = Object.keys(GLYPHS) as DotGlyphName[]

export function dotGlyphRows(name: DotGlyphName): readonly string[] {
  return GLYPHS[name]
}

/** Flat row-major boolean grid of length DOT_GLYPH_SIZE² (81). */
export function dotGlyphCells(name: DotGlyphName): boolean[] {
  const cells: boolean[] = []
  for (const row of GLYPHS[name]) {
    for (const ch of row) cells.push(ch === '#')
  }
  return cells
}

export function dotGlyphLitCount(name: DotGlyphName): number {
  let count = 0
  for (const lit of dotGlyphCells(name)) if (lit) count += 1
  return count
}
