import assert from 'node:assert/strict'
import test from 'node:test'
import { STARTUP_SPLASH_WORDMARK } from '../shared/startup-splash-glyphs'
import {
  renderStartupSplashMarkup,
  startupSplashDots,
  STARTUP_SPLASH_FINISH,
  STARTUP_SPLASH_SIZE,
  STARTUP_SPLASH_SLAB,
  STARTUP_SPLASH_WORDMARK_PLACE,
} from '../shared/startup-splash-markup'

// The rendered frames, the comparison with real Instrument Serif text and the runtime motion check are in
// scripts/verify-ready-next-splash.cjs (a hidden Electron window); these are the parts that need no browser.

test('each corner of the five letters gets one dot, which appears just beside it', () => {
  const dots = startupSplashDots()
  const anchors = STARTUP_SPLASH_WORDMARK.glyphs.flatMap((glyph, index) => glyph.anchors.map(([x, y]) => ({
    glyph: index,
    x: STARTUP_SPLASH_WORDMARK_PLACE.x + (glyph.x + x) * STARTUP_SPLASH_WORDMARK_PLACE.fontSize,
    y: STARTUP_SPLASH_WORDMARK_PLACE.baseline + y * STARTUP_SPLASH_WORDMARK_PLACE.fontSize,
  })))
  assert.equal(STARTUP_SPLASH_WORDMARK.glyphs.length, 5)
  assert.equal(dots.length, anchors.length)
  dots.forEach((dot, i) => {
    assert.equal(dot.glyph, anchors[i].glyph)
    assert.ok(Math.abs(dot.x - anchors[i].x) < 1e-9 && Math.abs(dot.y - anchors[i].y) < 1e-9, `dot ${i} lands on its corner`)
    const away = Math.hypot(dot.startX - dot.x, dot.startY - dot.y)
    assert.ok(away >= 8 && away <= 20, `dot ${i} appears ${away.toFixed(1)}px from its corner`)
  })
})

test('over the native glass the page draws no slab of its own, only the same wordmark and dots', () => {
  for (const theme of ['light', 'dark'] as const) {
    const drawn = renderStartupSplashMarkup(theme), native = renderStartupSplashMarkup(theme, { glass: 'native' })
    assert.match(drawn, /<div class="glass">/)
    assert.doesNotMatch(native, /class="glass"|class="sheen"/)
    const wordOf = (markup: string) => markup.slice(markup.indexOf('<div class="word"'), markup.indexOf('<script'))
    assert.equal(wordOf(native), wordOf(drawn))
    assert.equal(native.match(/class="dot"/g)?.length, startupSplashDots().length)
  }
  // nothing twinkles while loading: the page has no loading motion besides the drawn glass's one sweep
  assert.doesNotMatch(renderStartupSplashMarkup('light'), /speck|twinkle/)
})

test('the wordmark stands centred on the slab, set as the shell sets it', () => {
  const { x, fontSize, baseline } = STARTUP_SPLASH_WORDMARK_PLACE
  const slab = STARTUP_SPLASH_SLAB
  assert.equal(STARTUP_SPLASH_WORDMARK.text, 'Ready')
  assert.ok(Math.abs(x + STARTUP_SPLASH_WORDMARK.width * fontSize / 2 - (slab.x + slab.width / 2)) < 0.01)
  // its visual middle (.281em above the baseline, as .shell-wordmark measures it) on the slab's centre line
  assert.ok(Math.abs(baseline - 0.281 * fontSize - (slab.y + slab.height / 2)) < 0.01)
  // the slab sits inside the window with room for its shadow on every side
  assert.equal(slab.x * 2 + slab.width, STARTUP_SPLASH_SIZE.width)
  assert.equal(slab.y * 2 + slab.height, STARTUP_SPLASH_SIZE.height)
})

test('only opacity and transform are animated, and no script runs per frame', () => {
  for (const theme of ['light', 'dark'] as const) {
    const markup = renderStartupSplashMarkup(theme)
    const style = markup.slice(markup.indexOf('<style>'), markup.indexOf('</style>'))
    const keyframes = [...style.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)]
    assert.ok(keyframes.length >= 2)
    for (const [, body] of keyframes) {
      for (const [, property] of body.matchAll(/([a-z-]+):/g)) assert.ok(['opacity', 'transform'].includes(property), `keyframes animate ${property}`)
    }
    const transitions = [...style.matchAll(/transition: ([^;]+);/g)]
    assert.ok(transitions.length >= 7)
    for (const [, value] of transitions) {
      assert.ok(['opacity', 'transform', 'none'].includes(value.trim().split(' ')[0]), `transition of ${value}`)
    }
    const script = markup.slice(markup.indexOf('<script>'), markup.indexOf('</script>'))
    assert.doesNotMatch(script, /requestAnimationFrame|setInterval/)
  }
})

test('the page is see-through around the slab, and the glass has no colour of its own', () => {
  for (const theme of ['light', 'dark'] as const) {
    const markup = renderStartupSplashMarkup(theme)
    assert.match(markup, /html, body \{[^}]*background: transparent;/)
    const glass = markup.match(/\.glass \{[^}]*\}/)?.[0] ?? ''
    for (const [, r, g, b] of glass.matchAll(/rgba\((\d+), (\d+), (\d+),/g)) assert.ok(r === g && g === b, `glass colour rgba(${r}, ${g}, ${b})`)
  }
  // the glass and the white, glowing wordmark are the same in both appearances; only the dots' orange follows the system
  const glassOf = (theme: 'light' | 'dark') => renderStartupSplashMarkup(theme).match(/\.glass \{[^}]*\}/)?.[0]
  assert.equal(glassOf('light'), glassOf('dark'))
  const fillOf = (theme: 'light' | 'dark') => renderStartupSplashMarkup(theme).match(/\.fill \{[^}]*\}/)?.[0] ?? ''
  assert.equal(fillOf('light'), fillOf('dark'))
  assert.match(fillOf('light'), /fill: #ffffff; filter: drop-shadow\(0 0 [\d.]+px rgba\(255, 255, 255,/)
  assert.ok(STARTUP_SPLASH_FINISH.fadeDelayMs > STARTUP_SPLASH_FINISH.settledMs)
})

test("the slab's shadow ends inside the window, so the window edge never cuts it", () => {
  const glass = renderStartupSplashMarkup('light').match(/\.glass \{[^}]*box-shadow: ([^;]+);/)?.[1] ?? ''
  const shadows = glass.split(/,(?![^(]*\))/).map(part => part.trim()).filter(part => !part.startsWith('inset'))
  assert.ok(shadows.length >= 2)
  for (const shadow of shadows) {
    const [x, y, blur = 0, spread = 0] = [...shadow.matchAll(/(-?[\d.]+)px|(?<![\w.])0(?= )/g)].map(match => Number(match[1] ?? 0))
    const reach = Math.max(Math.abs(x), Math.abs(y)) + blur + spread
    assert.ok(reach <= STARTUP_SPLASH_SLAB.x && reach <= STARTUP_SPLASH_SLAB.y, `"${shadow}" reaches ${reach}px past the slab`)
  }
})

test('a host that admits inline scripts only by nonce gets the nonce on the one script', () => {
  assert.match(renderStartupSplashMarkup('light', { scriptNonce: 'abc' }), /<script nonce="abc">/)
  assert.equal(renderStartupSplashMarkup('light').match(/<script[ >]/g)?.length, 1)
  assert.doesNotMatch(renderStartupSplashMarkup('light'), /nonce=/)
})
