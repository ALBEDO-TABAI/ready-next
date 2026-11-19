import { STARTUP_SPLASH_WORDMARK, type StartupSplashGlyph } from './startup-splash-glyphs'

/**
 * The startup splash (plan docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md): a slab of
 * liquid glass in which orange-red dots appear while Ready loads; when Ready is ready they gather on the corners of the
 * wordmark (Instrument Serif), a hairline draws each letter's outline between them, the letters fill and the dots
 * dissolve, in the DevDay "dot → line → plane" vocabulary.
 *
 * Motion contract: the page moves only opacity and transform, through CSS keyframes and transitions, so the compositor
 * plays it even while the boot blocks the main thread (no per-frame script; the one script runs once, at the finish
 * signal). The window is opaque, so the glass is drawn here rather than lent by the desktop.
 *
 * Pure: no Electron, no DOM. Main turns the markup into the splash window's data URL; the renderer's #/startup-preview
 * shows the same markup in a frame.
 */

export type StartupSplashTheme = 'light' | 'dark'

export const STARTUP_SPLASH_SIZE = { width: 650, height: 190 } as const
export const STARTUP_SPLASH_FINISH_EVENT = 'ready-startup-finish'

const FONT_SIZE = 104
const DOT_RADIUS = 3.3
const DOT_COUNT = 48            // more dots than anchors: the spare ones land on an anchor already taken and merge with it
const FIELD_ROWS = 4
const FIELD_INSET = { x: 64, y: 40 }

// Timing (ms). Intro: from the page's first style; the finish: from the finish signal.
const INTRO_DELAY = 160
const POP_SPREAD = 400
const POP_MS = 440
const PULSE_MS = 1900
const CONVERGE_COLUMN_STEP = 20
const CONVERGE_MS = 620
const GLYPH_STEP = 45
const LINE_AT = 360
const LINE_MS = 360
const FILL_AT = LINE_AT + Math.round(LINE_MS * 0.62)
const FILL_MS = 220
const LINE_FADE_MS = 260
const DOT_OUT_AT = FILL_AT + 88
const DOT_OUT_MS = 240
const GLINT_AT = 700
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

interface Palette {
  ground: [string, string]
  /** A cool light from the top left and a warm one from the bottom right under the glass: something for it to bend. */
  tint: [string, string]
  accent: string
  ink: string
  line: string
  bloom: string
  glass: string
  rim: string
  ring: string
  sheen: string
  dotGlow: string
}

const PALETTES: Record<StartupSplashTheme, Palette> = {
  light: {
    ground: ['#fbfbfc', '#dfdfe5'],
    tint: ['rgba(178, 198, 236, .55)', 'rgba(255, 190, 160, .4)'],
    accent: '#ff5a1f',
    ink: '#0b0b0e',
    line: 'rgba(11, 11, 14, .78)',
    bloom: 'rgba(255, 90, 31, .16)',
    glass: 'linear-gradient(176deg, rgba(255, 255, 255, .64), rgba(255, 255, 255, .16) 40%, rgba(255, 255, 255, .05) 64%, rgba(255, 255, 255, .3))',
    rim: 'inset 0 1.5px 0 #fff, inset 0 -1px 0 rgba(255, 255, 255, .85), inset 0 -2px 0 rgba(11, 11, 14, .05), inset 0 20px 24px -18px rgba(255, 255, 255, .95), inset 0 -20px 26px -20px rgba(11, 11, 14, .12), inset 16px 0 24px -20px rgba(255, 255, 255, .7), inset -16px 0 24px -20px rgba(11, 11, 14, .05)',
    ring: 'conic-gradient(from 210deg, #fff, rgba(255, 255, 255, .35) 60deg, rgba(11, 11, 14, .1) 120deg, rgba(255, 255, 255, .95) 180deg, rgba(255, 255, 255, .3) 240deg, rgba(11, 11, 14, .08) 300deg, #fff)',
    sheen: 'rgba(255, 255, 255, .6)',
    dotGlow: '0 0 7px rgba(255, 90, 31, .38)',
  },
  dark: {
    ground: ['#1c1c21', '#09090b'],
    tint: ['rgba(96, 118, 170, .16)', 'rgba(255, 120, 60, .08)'],
    accent: '#ff6a2c',
    ink: '#f4f4f6',
    line: 'rgba(244, 244, 246, .9)',
    bloom: 'rgba(255, 106, 44, .3)',
    glass: 'linear-gradient(176deg, rgba(255, 255, 255, .085), rgba(255, 255, 255, .02) 42%, rgba(255, 255, 255, .012) 64%, rgba(255, 255, 255, .05))',
    rim: 'inset 0 1px 0 rgba(255, 255, 255, .3), inset 0 -1px 0 rgba(255, 255, 255, .07), inset 0 20px 26px -20px rgba(255, 255, 255, .16), inset 0 -22px 28px -20px rgba(0, 0, 0, .6), inset 16px 0 24px -20px rgba(255, 255, 255, .07), inset -16px 0 24px -20px rgba(255, 255, 255, .04)',
    ring: 'conic-gradient(from 210deg, rgba(255, 255, 255, .55), rgba(255, 255, 255, .08) 60deg, rgba(255, 255, 255, .03) 120deg, rgba(255, 255, 255, .4) 180deg, rgba(255, 255, 255, .06) 240deg, rgba(255, 255, 255, .04) 300deg, rgba(255, 255, 255, .55))',
    sheen: 'rgba(255, 255, 255, .07)',
    dotGlow: '0 0 10px rgba(255, 106, 44, .55), 0 0 2px rgba(255, 140, 90, .9)',
  },
}

/** The colour under everything: the window's own background, so its first frame matches the page. */
export function startupSplashGround(theme: StartupSplashTheme): string {
  return PALETTES[theme].ground[1]
}

// A fixed pseudo-random number in [0, 1) per seed: the same splash on every launch.
const hash = (seed: number): number => {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return value - Math.floor(value)
}
const px = (value: number): string => `${Math.round(value * 10) / 10}`
const ms = (value: number): string => `${Math.round(value)}ms`

/** Where the dots end (an anchor of the wordmark) and where they float before (a jittered grid across the slab). */
export interface StartupSplashDot {
  glyph: number
  x: number
  y: number
  startX: number
  startY: number
  column: number
}

const ORIGIN_X = (STARTUP_SPLASH_SIZE.width - STARTUP_SPLASH_WORDMARK.width * FONT_SIZE) / 2
// The wordmark's visual middle sits .281em above the baseline (measured for .shell-wordmark), on the slab's centre.
const BASELINE = STARTUP_SPLASH_SIZE.height / 2 + 0.281 * FONT_SIZE
/** Where the wordmark stands in the slab: its pen start, baseline and size (px), as text set in the font would be. */
export const STARTUP_SPLASH_WORDMARK_PLACE = { x: ORIGIN_X, baseline: BASELINE, fontSize: FONT_SIZE } as const

export function startupSplashDots(): StartupSplashDot[] {
  const anchors = STARTUP_SPLASH_WORDMARK.glyphs.flatMap((glyph, index) =>
    glyph.anchors.map(([x, y]) => ({ glyph: index, x: ORIGIN_X + (glyph.x + x) * FONT_SIZE, y: BASELINE + y * FONT_SIZE })))
  const dots = [...anchors]
  for (let spare = 0; dots.length < DOT_COUNT; spare += 1) dots.push(anchors[Math.floor(hash(spare * 13.7 + 5) * anchors.length)])
  // Columns of the field take the dots in the order of where they land, so every dot travels mostly inward.
  const columns = Math.ceil(dots.length / FIELD_ROWS)
  const { width, height } = STARTUP_SPLASH_SIZE
  const byX = [...dots].sort((a, b) => a.x - b.x)
  const placed: StartupSplashDot[] = []
  for (let column = 0; column < columns; column += 1) {
    byX.slice(column * FIELD_ROWS, (column + 1) * FIELD_ROWS).sort((a, b) => a.y - b.y).forEach((dot, row) => {
      const n = column * FIELD_ROWS + row
      placed.push({
        ...dot,
        column,
        startX: FIELD_INSET.x + (width - 2 * FIELD_INSET.x) * (column + 0.5 + (hash(n * 3.1) - 0.5) * 0.7) / columns,
        startY: FIELD_INSET.y + (height - 2 * FIELD_INSET.y) * (row + 0.5 + (hash(n * 7.7 + 1) - 0.5) * 0.7) / FIELD_ROWS,
      })
    })
  }
  return placed
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

// Four wrappers, one motion each, because a transition cannot start from where a running animation has left a value:
// .dot gathers (transition), .drift floats (animation; settled by the finish script), .pulse breathes (animation;
// settled likewise), .out dissolves (transition), and the disc itself pops in (animation).
function dotMarkup(dot: StartupSplashDot, n: number): string {
  const { width } = STARTUP_SPLASH_SIZE
  const across = Math.min(1, Math.max(0, dot.startX / width))
  const pop = INTRO_DELAY + across * POP_SPREAD + hash(n * 5.3) * 120
  const gather = dot.column * CONVERGE_COLUMN_STEP + hash(n * 2.9) * 60
  const out = dot.glyph * GLYPH_STEP + DOT_OUT_AT + hash(n * 4.4) * 60
  const driftMs = 2600 + hash(n * 9.1) * 1400
  return `<div class="dot" style="left:${px(dot.x - DOT_RADIUS)}px;top:${px(dot.y - DOT_RADIUS)}px;--sx:${px(dot.startX - dot.x)}px;--sy:${px(dot.startY - dot.y)}px;transition-delay:${ms(gather)}">`
    + `<div class="drift" style="animation-duration:${ms(driftMs)};animation-delay:${ms(-hash(n * 6.2) * driftMs)};--dx:${px((hash(n * 8.8) - 0.5) * 9)}px;--dy:${px((hash(n * 1.9) - 0.5) * 7)}px">`
    + `<div class="pulse" style="animation-delay:${ms(-(1 - across) * 0.62 * PULSE_MS)}">`
    + `<div class="out" style="transition-delay:${ms(out)}"><i style="animation-delay:${ms(pop)}"></i></div></div></div></div>`
}

function styles(theme: StartupSplashTheme): string {
  const p = PALETTES[theme]
  const radius = DOT_RADIUS * 2
  return `
:root { color-scheme: ${theme}; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: ${p.ground[1]}; }
.ground { position: absolute; inset: 0; background: radial-gradient(60% 120% at 12% 0%, ${p.tint[0]}, transparent 70%),
  radial-gradient(55% 110% at 92% 100%, ${p.tint[1]}, transparent 70%), radial-gradient(130% 150% at 28% -12%, ${p.ground[0]}, ${p.ground[1]} 72%); }
.bloom { position: absolute; inset: 0; transition: opacity 560ms ease ${ms(FILL_AT)}; }
.bloom i { position: absolute; left: 50%; top: 50%; width: 520px; height: 150px; margin: -75px 0 0 -260px; border-radius: 50%;
  background: radial-gradient(closest-side, ${p.bloom}, transparent); filter: blur(10px); opacity: 0;
  animation: splash-bloom 900ms cubic-bezier(.22, 1, .36, 1) ${ms(INTRO_DELAY)} forwards; }
.glass { position: absolute; inset: 0; border-radius: 16px; background: ${p.glass}; box-shadow: ${p.rim}; overflow: hidden; }
.glass::before { content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1.25px; background: ${p.ring};
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
.sheen { position: absolute; top: -40%; bottom: -40%; left: 0; width: 34%; background: linear-gradient(100deg, transparent, ${p.sheen} 50%, transparent);
  transform: translateX(-120%) skewX(-14deg); animation: splash-sweep 1400ms cubic-bezier(.45, 0, .2, 1) 220ms both; }
.fill, .seg { position: absolute; display: block; overflow: visible; }
.fill { fill: ${p.ink}; opacity: 0; transition: opacity ${ms(FILL_MS)} cubic-bezier(.22, 1, .36, 1); }
.seg { fill: none; stroke: ${p.line}; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; opacity: 0; transition: opacity 70ms linear; }
.lines { position: absolute; inset: 0; transition: opacity ${ms(LINE_FADE_MS)} ease; }
.dot { position: absolute; width: ${radius}px; height: ${radius}px; transform: translate(var(--sx), var(--sy)); transition: transform ${ms(CONVERGE_MS)} cubic-bezier(.3, .7, .2, 1); }
.drift, .pulse, .out, .dot i { position: absolute; inset: 0; }
.drift { animation: splash-drift ease-in-out infinite alternate; }
.pulse { animation: splash-pulse ${ms(PULSE_MS)} ease-in-out infinite; }
.out { transition: transform ${ms(DOT_OUT_MS)} cubic-bezier(.55, 0, .75, .2); }
.dot i { border-radius: 50%; background: ${p.accent}; box-shadow: ${p.dotGlow}; transform: scale(0); animation: splash-pop ${ms(POP_MS)} cubic-bezier(.34, 1.56, .64, 1) both; }
.finishing .dot { transform: none; }
.finishing .drift { transform: none; transition: transform 420ms cubic-bezier(.22, 1, .36, 1); }
.finishing .pulse { opacity: 1; transition: opacity 260ms ease; }
.finishing .out { transform: scale(0); }
.finishing .seg, .finishing .fill { opacity: 1; }
.finishing .lines, .finishing .bloom { opacity: 0; }
.finishing .sheen { animation: splash-glint ${ms(GLINT_MS)} cubic-bezier(.45, 0, .2, 1) ${ms(GLINT_AT)} both; }
@keyframes splash-bloom { to { opacity: 1; } }
@keyframes splash-sweep { to { transform: translateX(420%) skewX(-14deg); } }
@keyframes splash-glint { from { transform: translateX(-120%) skewX(-14deg); } to { transform: translateX(420%) skewX(-14deg); } }
@keyframes splash-drift { from { transform: translate(calc(var(--dx) * -1), calc(var(--dy) * -1)); } to { transform: translate(var(--dx), var(--dy)); } }
@keyframes splash-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes splash-pop { from { transform: scale(0); } to { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  .bloom, .sheen, .lines, .dot { display: none; }
  .fill { opacity: 1; transition: none; }
}`
}

// Runs once, at the finish signal: pins the floating and breathing values where they are, so the gathering starts
// from what is on screen, then lets the stylesheet take every element to its end. Closes itself if Main never does.
function finishScript(): string {
  const closeAfter = STARTUP_SPLASH_FINISH.fadeDelayMs + FADE_MS + 400
  return `(() => {
  window.addEventListener('${STARTUP_SPLASH_FINISH_EVENT}', () => {
    const root = document.documentElement;
    if (root.classList.contains('finishing')) return;
    const live = [...document.querySelectorAll('.drift, .pulse')];
    const now = live.map((element) => { const style = getComputedStyle(element); return [style.transform, style.opacity]; });
    live.forEach((element, i) => { element.style.transform = now[i][0]; element.style.opacity = now[i][1]; element.style.animation = 'none'; });
    void root.offsetWidth;
    live.forEach((element) => { element.style.transform = ''; element.style.opacity = ''; });
    root.classList.add('finishing');
    setTimeout(() => window.close(), ${closeAfter});
  });
})();`
}

/** `scriptNonce`: for a host whose content security policy admits inline scripts only by nonce (the preview's frame). */
export function renderStartupSplashMarkup(theme: StartupSplashTheme, { scriptNonce }: { scriptNonce?: string } = {}): string {
  const glyphs = STARTUP_SPLASH_WORDMARK.glyphs
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<title>Ready</title>
<style>${styles(theme)}</style>
</head>
<body>
<div class="ground"></div>
<div class="bloom"><i></i></div>
<div class="glass"><div class="sheen"></div></div>
<div class="word" role="img" aria-label="Ready">${glyphs.map(fillMarkup).join('')}${glyphs.map(lineMarkup).join('')}${startupSplashDots().map(dotMarkup).join('')}</div>
<script${scriptNonce ? ` nonce="${scriptNonce}"` : ''}>${finishScript()}</script>
</body>
</html>`
}
