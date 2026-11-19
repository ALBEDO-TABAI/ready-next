import assert from 'node:assert/strict'
import test from 'node:test'
import { STARTUP_SPLASH_WORDMARK } from '../shared/startup-splash-glyphs'
import {
  renderStartupSplashMarkup,
  startupSplashDots,
  startupSplashGround,
  STARTUP_SPLASH_FINISH,
  STARTUP_SPLASH_SIZE,
  STARTUP_SPLASH_WORDMARK_PLACE,
} from '../shared/startup-splash-markup'

// The rendered frames, the comparison with real Instrument Serif text and the runtime motion check are in
// scripts/verify-ready-next-splash.cjs (a hidden Electron window); these are the parts that need no browser.

test('every dot ends on a corner of the wordmark, and every corner gets a dot', () => {
  const dots = startupSplashDots()
  const anchors = STARTUP_SPLASH_WORDMARK.glyphs.flatMap((glyph, index) => glyph.anchors.map(([x, y]) => ({
    glyph: index,
    x: STARTUP_SPLASH_WORDMARK_PLACE.x + (glyph.x + x) * STARTUP_SPLASH_WORDMARK_PLACE.fontSize,
    y: STARTUP_SPLASH_WORDMARK_PLACE.baseline + y * STARTUP_SPLASH_WORDMARK_PLACE.fontSize,
  })))
  const key = (point: { x: number; y: number }) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`
  const corners = new Set(anchors.map(key))
  assert.ok(dots.length > anchors.length, 'spare dots merge into corners already taken')
  for (const dot of dots) assert.ok(corners.has(key(dot)), `dot ends off the wordmark at ${key(dot)}`)
  assert.equal(new Set(dots.map(key)).size, corners.size)
})

test('before gathering, the dots float across the slab, inside its edges', () => {
  const { width, height } = STARTUP_SPLASH_SIZE
  const dots = startupSplashDots()
  for (const dot of dots) {
    assert.ok(dot.startX > 24 && dot.startX < width - 24, `start x ${dot.startX}`)
    assert.ok(dot.startY > 24 && dot.startY < height - 24, `start y ${dot.startY}`)
  }
  const xs = dots.map(dot => dot.startX)
  assert.ok((Math.max(...xs) - Math.min(...xs)) / width > 0.7)
})

test('the wordmark stands centred in the slab, set as the shell sets it', () => {
  const { x, fontSize, baseline } = STARTUP_SPLASH_WORDMARK_PLACE
  assert.equal(STARTUP_SPLASH_WORDMARK.text, 'Ready')
  assert.ok(Math.abs(x + STARTUP_SPLASH_WORDMARK.width * fontSize / 2 - STARTUP_SPLASH_SIZE.width / 2) < 0.01)
  // its visual middle (.281em above the baseline, as .shell-wordmark measures it) on the slab's centre line
  assert.ok(Math.abs(baseline - 0.281 * fontSize - STARTUP_SPLASH_SIZE.height / 2) < 0.01)
})

test('only opacity and transform are animated, and no script runs per frame', () => {
  for (const theme of ['light', 'dark'] as const) {
    const markup = renderStartupSplashMarkup(theme)
    const style = markup.slice(markup.indexOf('<style>'), markup.indexOf('</style>'))
    const keyframes = [...style.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)]
    assert.ok(keyframes.length >= 6)
    for (const [, body] of keyframes) {
      for (const [, property] of body.matchAll(/([a-z-]+):/g)) assert.ok(['opacity', 'transform'].includes(property), `keyframes animate ${property}`)
    }
    const transitions = [...style.matchAll(/transition: ([^;]+);/g)]
    assert.ok(transitions.length >= 8)
    for (const [, value] of transitions) {
      assert.ok(['opacity', 'transform', 'none'].includes(value.trim().split(' ')[0]), `transition of ${value}`)
    }
    const script = markup.slice(markup.indexOf('<script>'), markup.indexOf('</script>'))
    assert.doesNotMatch(script, /requestAnimationFrame|setInterval/)
  }
})

test('a host that admits inline scripts only by nonce gets the nonce on the one script', () => {
  assert.match(renderStartupSplashMarkup('light', { scriptNonce: 'abc' }), /<script nonce="abc">/)
  assert.equal(renderStartupSplashMarkup('light').match(/<script[ >]/g)?.length, 1)
  assert.doesNotMatch(renderStartupSplashMarkup('light'), /nonce=/)
})

test('the window background is the page ground, and the fade waits for the wordmark to settle', () => {
  for (const theme of ['light', 'dark'] as const) {
    assert.match(renderStartupSplashMarkup(theme), new RegExp(`html, body \\{[^}]*background: ${startupSplashGround(theme)};`))
  }
  assert.notEqual(startupSplashGround('light'), startupSplashGround('dark'))
  assert.ok(STARTUP_SPLASH_FINISH.fadeDelayMs > STARTUP_SPLASH_FINISH.settledMs)
})
