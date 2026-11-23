import { STARTUP_SPLASH_WORDMARK, type StartupSplashGlyph } from './startup-splash-glyphs'

/**
 * The startup splash (plan docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md): a slab of
 * clear, colourless liquid glass over the desktop. While Ready loads the page shows nothing more (on macOS 26+ the
 * native layer under it moves water through the glass, §6). When Ready is about to open, orange-red dots appear beside
 * each of the five letters, attach to the letter's corners, a hairline draws each outline between them, the white,
 * glowing letters fill and the dots dissolve (the DevDay "dot → line → plane").
 *
 * Motion contract: the page moves only opacity and transform, through CSS keyframes and transitions (no per-frame
 * script; the one script runs once, at the finish signal). Every motion is a function of time, so a stalled frame only
 * skips ahead.
 *
 * The window is transparent. With `glass: 'drawn'` the page draws the slab inside a margin that holds its shadow; with
 * `glass: 'native'` the system's glass is under the page and the page draws only the wordmark.
 * Pure: no Electron, no DOM. Main turns the markup into the splash window's data URL; the renderer's #/startup-preview
 * shows the same markup in a frame.
 */

export type StartupSplashTheme = 'light' | 'dark'

const SLAB = { width: 650, height: 190, radius: 28 }
const MARGIN = 32 // room for the slab's shadow inside the transparent window: no shadow may reach past it
export const STARTUP_SPLASH_SIZE = { width: SLAB.width + 2 * MARGIN, height: SLAB.height + 2 * MARGIN } as const
export const STARTUP_SPLASH_FINISH_EVENT = 'ready-startup-finish'

// 80% of the first size (104), as the user set it in the demo window (2026-11-23); the dots shrink with it.
const FONT_SIZE = 83.2
const DOT_RADIUS = 2.64

// Timing (ms). The drawn glass's sweep: from the page's first style; the build: from the finish signal.
const GLINT_IN_AT = 220
const GLYPH_STEP = 55
const POP_MS = 300
const ATTACH_AT = 220
const ATTACH_MS = 420
const LINE_AT = 450
const LINE_MS = 340
const FILL_AT = LINE_AT + Math.round(LINE_MS * 0.62)
const FILL_MS = 220
const LINE_FADE_MS = 260
const DOT_OUT_AT = FILL_AT + 88
const DOT_OUT_MS = 240
const GLINT_AT = 760
const GLINT_MS = 800
const HOLD_MS = 420
const FADE_MS = 280

const GLYPH_COUNT = STARTUP_SPLASH_WORDMARK.glyphs.length
/** When the wordmark stands alone and every dot is gone, counted from the finish signal. */
const SETTLED_MS = (GLYPH_COUNT - 1) * GLYPH_STEP + Math.max(DOT_OUT_AT + 60 + DOT_OUT_MS, FILL_AT + 110 + LINE_FADE_MS)

export const STARTUP_SPLASH_FINISH = {
  settledMs: SETTLED_MS,
  /** Main starts fading the window out this long after the finish signal. */
  fadeDelayMs: SETTLED_MS + HOLD_MS,
  fadeMs: FADE_MS,
} as const

// The glass has no colour of its own and the wordmark is white and glowing in either appearance (the user's choice,
// 2026-11-23); only the orange-red of the dots follows the system's light or dark.
const ACCENT: Record<StartupSplashTheme, string> = { light: '#ff5a1f', dark: '#ff6a2c' }
const INK = {
  fill: '#ffffff',
  line: 'rgba(255, 255, 255, .95)',
  glow: 'drop-shadow(0 0 2.4px rgba(255, 255, 255, .9)) drop-shadow(0 0 9.6px rgba(255, 255, 255, .55))',
  lineGlow: 'drop-shadow(0 0 1.6px rgba(255, 255, 255, .8))',
}

const GLASS = {
  body: 'linear-gradient(180deg, rgba(255, 255, 255, .13), rgba(255, 255, 255, .04) 38%, rgba(255, 255, 255, .02) 62%, rgba(255, 255, 255, .06))',
  // outside: a hairline and a soft shadow, so the slab reads on a light wallpaper; inside: the lit top edge, the
  // thickness at the bottom and a faint caustic along it
  edge: '0 0 0 .5px rgba(0, 0, 0, .16), 0 14px 28px -14px rgba(0, 0, 0, .38), 0 3px 10px -4px rgba(0, 0, 0, .14), '
    + 'inset 0 1px 0 rgba(255, 255, 255, .72), inset 0 -1px 0 rgba(255, 255, 255, .24), inset 0 0 0 1px rgba(255, 255, 255, .14), '
    + 'inset 0 14px 22px -16px rgba(255, 255, 255, .42), inset 0 -16px 24px -18px rgba(0, 0, 0, .2), inset 0 -7px 10px -8px rgba(255, 255, 255, .3)',
  ring: 'conic-gradient(from 210deg, rgba(255, 255, 255, .95), rgba(255, 255, 255, .25) 60deg, rgba(255, 255, 255, .08) 120deg, '
    + 'rgba(255, 255, 255, .75) 180deg, rgba(255, 255, 255, .2) 240deg, rgba(255, 255, 255, .08) 300deg, rgba(255, 255, 255, .95))',
  sheen: 'rgba(255, 255, 255, .28)',
}

// A fixed pseudo-random number in [0, 1) per seed: the same splash on every launch.
const hash = (seed: number): number => {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return value - Math.floor(value)
}
const px = (value: number): string => `${Math.round(value * 10) / 10}`
const ms = (value: number): string => `${Math.round(value)}ms`

const ORIGIN_X = MARGIN + (SLAB.width - STARTUP_SPLASH_WORDMARK.width * FONT_SIZE) / 2
// The wordmark's visual middle sits .281em above the baseline (measured for .shell-wordmark), on the slab's centre.
const BASELINE = MARGIN + SLAB.height / 2 + 0.281 * FONT_SIZE
/** Where the wordmark stands in the window: its pen start, baseline and size (px), as text set in the font would be. */
export const STARTUP_SPLASH_WORDMARK_PLACE = { x: ORIGIN_X, baseline: BASELINE, fontSize: FONT_SIZE } as const
/** The slab inside the window (px). */
export const STARTUP_SPLASH_SLAB = { x: MARGIN, y: MARGIN, ...SLAB } as const

/** A dot: where it lands (a corner of a letter) and where it appears first, just beside that corner. */
export interface StartupSplashDot {
  glyph: number
  x: number
  y: number
  startX: number
  startY: number
}

export function startupSplashDots(): StartupSplashDot[] {
  return STARTUP_SPLASH_WORDMARK.glyphs.flatMap((glyph, index) => glyph.anchors.map(([ax, ay], k) => {
    const n = index * 31 + k
    const x = ORIGIN_X + (glyph.x + ax) * FONT_SIZE, y = BASELINE + ay * FONT_SIZE
    const angle = hash(n * 2.3) * Math.PI * 2, distance = 9 + hash(n * 5.9) * 10
    return { glyph: index, x, y, startX: x + Math.cos(angle) * distance, startY: y + Math.sin(angle) * distance }
  }))
}

function fillMarkup(glyph: StartupSplashGlyph, index: number): string {
  const left = ORIGIN_X + (glyph.x - 0.1) * FONT_SIZE, top = BASELINE - FONT_SIZE
  return `<svg class="fill" style="left:${px(left)}px;top:${px(top)}px;width:${px(FONT_SIZE)}px;height:${px(1.3 * FONT_SIZE)}px;transition-delay:${ms(index * GLYPH_STEP + FILL_AT)}" viewBox="-0.1 -1 1 1.3"><path d="${glyph.d}"/></svg>`
}

// A glyph's hairline is cut into short pieces that appear one after another along each contour: it draws itself while
// every piece only fades in (a composited opacity transition, unlike an animated stroke-dashoffset).
function lineMarkup(glyph: StartupSplashGlyph, index: number): string {
  const pieces: string[] = []
  for (const contour of glyph.contours) {
    const points: Array<[number, number]> = []
    for (let i = 0; i < contour.length; i += 2) points.push([ORIGIN_X + (glyph.x + contour[i]) * FONT_SIZE, BASELINE + contour[i + 1] * FONT_SIZE])
    const along = [0]
    for (let i = 1; i < points.length; i += 1) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]))
    const length = along[along.length - 1]
    const count = Math.max(4, Math.round(length / 9))
    for (let piece = 0; piece < count; piece += 1) {
      const from = (length * piece) / count, to = (length * (piece + 1)) / count
      const first = Math.max(0, along.findIndex(at => at >= from) - 1)
      let last = first
      while (last < points.length - 1 && along[last] < to) last += 1
      const run = points.slice(first, last + 1)
      if (run.length < 2) continue
      const xs = run.map(p => p[0]), ys = run.map(p => p[1])
      const left = Math.min(...xs) - 2, top = Math.min(...ys) - 2, w = Math.max(...xs) + 2 - left, h = Math.max(...ys) + 2 - top
      const d = run.map((p, i) => `${i ? 'L' : 'M'}${px(p[0] - left)} ${px(p[1] - top)}`).join('')
      pieces.push(`<svg class="seg" style="left:${px(left)}px;top:${px(top)}px;width:${px(w)}px;height:${px(h)}px;transition-delay:${ms(index * GLYPH_STEP + LINE_AT + (LINE_MS * piece) / count)}" viewBox="0 0 ${px(w)} ${px(h)}"><path d="${d}"/></svg>`)
    }
  }
  return `<div class="lines" style="transition-delay:${ms(index * GLYPH_STEP + FILL_AT + 110)}">${pieces.join('')}</div>`
}

// Three wrappers, one transition each, all started by the finish signal: .dot attaches (from beside the corner onto
// it), .pop appears, .out dissolves.
function dotMarkup(dot: StartupSplashDot, n: number): string {
  const at = dot.glyph * GLYPH_STEP
  return `<div class="dot" style="left:${px(dot.x - DOT_RADIUS)}px;top:${px(dot.y - DOT_RADIUS)}px;--sx:${px(dot.startX - dot.x)}px;--sy:${px(dot.startY - dot.y)}px;transition-delay:${ms(at + ATTACH_AT + hash(n * 2.9) * 60)}">`
    + `<div class="pop" style="transition-delay:${ms(at + hash(n * 5.3) * 80)}">`
    + `<div class="out" style="transition-delay:${ms(at + DOT_OUT_AT + hash(n * 4.4) * 60)}"><i></i></div></div></div>`
}

function styles(theme: StartupSplashTheme): string {
  const accent = ACCENT[theme]
  const radius = DOT_RADIUS * 2
  return `
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
.glass { position: absolute; left: ${MARGIN}px; top: ${MARGIN}px; width: ${SLAB.width}px; height: ${SLAB.height}px; border-radius: ${SLAB.radius}px;
  overflow: hidden; background: ${GLASS.body}; box-shadow: ${GLASS.edge}; }
.glass::before { content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1.25px; background: ${GLASS.ring};
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
.sheen { position: absolute; top: -40%; bottom: -40%; left: 0; width: 30%; background: linear-gradient(100deg, transparent, ${GLASS.sheen} 50%, transparent);
  transform: translateX(-120%) skewX(-14deg); animation: splash-sweep 1400ms cubic-bezier(.45, 0, .2, 1) ${ms(GLINT_IN_AT)} both; }
.fill, .seg { position: absolute; display: block; overflow: visible; }
.fill { fill: ${INK.fill}; filter: ${INK.glow}; opacity: 0; transition: opacity ${ms(FILL_MS)} cubic-bezier(.22, 1, .36, 1); }
.seg { fill: none; stroke: ${INK.line}; stroke-width: 1; stroke-linecap: round; stroke-linejoin: round; opacity: 0; transition: opacity 70ms linear; }
.lines { position: absolute; inset: 0; filter: ${INK.lineGlow}; transition: opacity ${ms(LINE_FADE_MS)} ease; }
.dot { position: absolute; width: ${radius}px; height: ${radius}px; transform: translate(var(--sx), var(--sy)); transition: transform ${ms(ATTACH_MS)} cubic-bezier(.3, .7, .2, 1); }
.pop, .out, .dot i { position: absolute; inset: 0; }
.pop { transform: scale(0); transition: transform ${ms(POP_MS)} cubic-bezier(.34, 1.56, .64, 1); }
.out { transition: transform ${ms(DOT_OUT_MS)} cubic-bezier(.55, 0, .75, .2); }
.dot i { border-radius: 50%; background: ${accent}; box-shadow: 0 0 6.4px ${accent}; }
.finishing .dot { transform: none; }
.finishing .pop { transform: none; }
.finishing .out { transform: scale(0); }
.finishing .seg, .finishing .fill { opacity: 1; }
.finishing .lines { opacity: 0; }
.finishing .sheen { animation: splash-glint ${ms(GLINT_MS)} cubic-bezier(.45, 0, .2, 1) ${ms(GLINT_AT)} both; }
@keyframes splash-sweep { to { transform: translateX(420%) skewX(-14deg); } }
@keyframes splash-glint { from { transform: translateX(-120%) skewX(-14deg); } to { transform: translateX(420%) skewX(-14deg); } }
@media (prefers-reduced-motion: reduce) {
  .sheen, .lines, .dot { display: none; }
  .fill { opacity: 1; transition: none; }
}`
}

// Runs once, at the finish signal: switches the page to its ending; the stylesheet's transitions do the rest. Closes the
// window itself if Main never does.
function finishScript(): string {
  const closeAfter = STARTUP_SPLASH_FINISH.fadeDelayMs + FADE_MS + 400
  return `(() => {
  window.addEventListener('${STARTUP_SPLASH_FINISH_EVENT}', () => {
    const root = document.documentElement;
    if (root.classList.contains('finishing')) return;
    root.classList.add('finishing');
    setTimeout(() => window.close(), ${closeAfter});
  });
})();`
}

/**
 * `glass`: 'drawn' (the page draws the slab) or 'native' (the system's glass is under the page, which then draws only
 * the wordmark). `scriptNonce`: for a host whose content security policy admits inline scripts only by nonce (the
 * preview's frame).
 */
export function renderStartupSplashMarkup(
  theme: StartupSplashTheme,
  { glass = 'drawn', scriptNonce }: { glass?: 'drawn' | 'native'; scriptNonce?: string } = {},
): string {
  const glyphs = STARTUP_SPLASH_WORDMARK.glyphs
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>Ready</title>
<style>${styles(theme)}</style>
</head>
<body>
${glass === 'drawn' ? '<div class="glass"><div class="sheen"></div></div>\n' : ''}<div class="word" role="img" aria-label="Ready">${glyphs.map(fillMarkup).join('')}${glyphs.map(lineMarkup).join('')}${startupSplashDots().map(dotMarkup).join('')}</div>
<script${scriptNonce ? ` nonce="${scriptNonce}"` : ''}>${finishScript()}</script>
</body>
</html>`
}
