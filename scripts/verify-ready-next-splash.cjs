#!/usr/bin/env node
// Hidden check of the startup splash (plan docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md).
// The page the splash window loads (src/shared/startup-splash-markup.ts) is opened in a hidden Electron window of the
// same size and background as the splash window, in both themes, and driven frame by frame: every animation paused
// and seeked to a moment, the finish signal sent at a chosen moment. Nothing is shown on screen; HOME and TMPDIR live in
// a throwaway directory; no network. The wordmark is compared with "Ready" set as text in Instrument Serif (the app's
// own font file) at the same place, so the dots build the real wordmark and not some other shape.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-splash-')))
const evidence = path.join(temporary, 'evidence')
for (const dir of ['home', 'tmp', 'profile', 'evidence']) fs.mkdirSync(path.join(temporary, dir))
process.env.HOME = path.join(temporary, 'home')
process.env.TMPDIR = path.join(temporary, 'tmp')
for (const name of ['READY_REMOTE_DEBUGGING_PORT', 'READY_DB_PATH', 'ELECTRON_RUN_AS_NODE']) delete process.env[name]

require('tsx/cjs/api').register()
const splash = require('../src/shared/startup-splash-markup.ts')
const { _electron } = require('playwright')
const { PNG } = require('pngjs')

const { width: W, height: H } = splash.STARTUP_SPLASH_SIZE
const WAIT_MS = 1500 // how long Ready "loads" in the frames below; the finish signal comes then
const SETTLED_MS = splash.STARTUP_SPLASH_FINISH.settledMs
const FONT = fs.readFileSync(path.join(REPO, 'src/renderer/design/next/fonts/InstrumentSerif.woff2')).toString('base64')
const results = []
const pass = (name, detail = '') => { results.push(name); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`) }

// The page's own clock, stopped: every animation is paused and seeked to `at` ms; past `finishAt` the finish signal has
// been sent and its transitions seeked to the time since. Mirrors what the compositor would show at that moment.
async function seek(page, at, finishAt = Infinity) {
  await page.reload()
  await page.evaluate(({ at, finishAt, event }) => {
    const intro = document.getAnimations()
    intro.forEach(animation => { animation.pause(); animation.currentTime = Math.min(at, finishAt) })
    if (at < finishAt) return
    window.dispatchEvent(new Event(event))
    void getComputedStyle(document.body).opacity
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = intro.includes(animation) ? at : at - finishAt }
  }, { at, finishAt: Number.isFinite(finishAt) ? finishAt : 1e9, event: splash.STARTUP_SPLASH_FINISH_EVENT })
}

async function shot(page, name) {
  const buffer = await page.screenshot()
  fs.writeFileSync(path.join(evidence, `${name}.png`), buffer)
  return PNG.sync.read(buffer)
}

// What a frame shows: orange dots (connected blobs of the accent colour, their spread across the slab) and the ink of
// the wordmark inside its box (dark ink on light, light ink on dark).
function read(png, theme) {
  const scale = png.width / W
  const accent = new Uint8Array(png.width * png.height), ink = new Uint8Array(png.width * png.height)
  const place = splash.STARTUP_SPLASH_WORDMARK_PLACE
  const box = { x0: (place.x - 12) * scale, x1: (place.x + 2.1 * place.fontSize + 12) * scale, y0: (place.baseline - place.fontSize) * scale, y1: (place.baseline + 0.3 * place.fontSize) * scale }
  let accentCount = 0, minX = Infinity, maxX = -Infinity
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4, r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
    if (r > 120 && r - b > 70 && r - g > 45) { /* orange, also where a dot breathes dim */ accent[y * png.width + x] = 1; accentCount++; minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && (theme === 'light' ? lum < 90 : lum > 205) && Math.abs(r - b) < 40) ink[y * png.width + x] = 1
  }
  let blobs = 0
  const seen = new Uint8Array(accent.length), stack = []
  for (let start = 0; start < accent.length; start++) {
    if (!accent[start] || seen[start]) continue
    let size = 0
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const at = stack.pop(); size++
      const x = at % png.width, y = (at - x) / png.width
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * png.width + nx
        if (nx >= 0 && ny >= 0 && nx < png.width && ny < png.height && accent[n] && !seen[n]) { seen[n] = 1; stack.push(n) }
      }
    }
    if (size >= 4 * scale * scale) blobs++
  }
  return { scale, accentCount, blobs, spread: accentCount ? (maxX - minX) / png.width : 0, ink }
}

function overlap(a, b) {
  let both = 0, either = 0
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) both++; if (a[i] || b[i]) either++ }
  return either ? both / either : 0
}

const ENTRY = `const { app } = require('electron')
app.setPath('userData', ${JSON.stringify(path.join(temporary, 'profile'))})
app.on('window-all-closed', () => {})
`

async function main() {
  const entry = path.join(temporary, 'entry.cjs')
  fs.writeFileSync(entry, ENTRY)
  const app = await _electron.launch({ executablePath: require(path.join(REPO, 'node_modules', 'electron')), args: [entry], env: { ...process.env, READY_START_HIDDEN: '1' }, timeout: 60000 })
  try {
    const open = async (url, background) => {
      const pending = app.waitForEvent('window')
      await app.evaluate(({ BrowserWindow }, { url, background, width, height }) => {
        const win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, transparent: false, backgroundColor: background, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
        void win.loadURL(url)
      }, { url, background, width: W, height: H })
      const page = await pending
      await page.waitForLoadState('load')
      return page
    }

    for (const theme of ['light', 'dark']) {
      const markup = splash.renderStartupSplashMarkup(theme)
      const page = await open(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`, splash.startupSplashGround(theme))
      // No frame-by-frame script: requestAnimationFrame is counted from before the page's own script runs.
      await page.addInitScript(() => { window.__rafCalls = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = callback => { window.__rafCalls++; return raf(callback) } })

      // The reference: "Ready" set as text in the app's Instrument Serif file, where the splash says the wordmark stands.
      const reference = await open(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><body style="margin:0;background:${splash.startupSplashGround(theme)}"><canvas width="${W}" height="${H}" style="display:block;width:${W}px;height:${H}px"></canvas></body>`)}`, splash.startupSplashGround(theme))
      await reference.evaluate(async ({ font, place, ink, W, H }) => {
        const face = new FontFace('Reference Serif', Uint8Array.from(atob(font), c => c.charCodeAt(0)))
        document.fonts.add(await face.load())
        const canvas = document.querySelector('canvas'), ratio = devicePixelRatio
        canvas.width = W * ratio; canvas.height = H * ratio
        const context = canvas.getContext('2d')
        context.scale(ratio, ratio)
        context.font = `${place.fontSize}px "Reference Serif"`
        context.letterSpacing = `${-0.01 * place.fontSize}px`
        context.fillStyle = ink
        context.fillText('Ready', place.x, place.baseline)
      }, { font: FONT, place: splash.STARTUP_SPLASH_WORDMARK_PLACE, ink: theme === 'light' ? '#0b0b0e' : '#f4f4f6', W, H })
      const referenceInk = read(await shot(reference, `${theme}-reference`), theme).ink
      await reference.close()

      // 1. Before anything moves: the glass alone.
      await seek(page, 0)
      let frame = read(await shot(page, `${theme}-00-glass`), theme)
      assert.equal(frame.accentCount, 0, 'no dot before the intro')
      assert.ok(overlap(frame.ink, referenceInk) < 0.05, 'no wordmark before the intro')
      pass(`${theme}: the first frame is the glass alone`)

      // 2. While Ready loads: the dots are up, spread across the slab; the wordmark is not shown yet.
      await seek(page, WAIT_MS)
      const waiting = read(await shot(page, `${theme}-01-waiting`), theme)
      assert.ok(waiting.blobs >= 36, `dots while loading: ${waiting.blobs}`)
      assert.ok(waiting.spread >= 0.7, `dots spread across the slab: ${waiting.spread.toFixed(2)}`)
      assert.ok(overlap(waiting.ink, referenceInk) < 0.05, 'the wordmark is not revealed while loading')
      pass(`${theme}: while loading, orange dots float across the glass`, `${waiting.blobs} dots over ${(waiting.spread * 100).toFixed(0)}% of the width`)

      // 3. After the finish signal: the dots gather toward the wordmark.
      await seek(page, WAIT_MS + 420, WAIT_MS)
      const gathering = read(await shot(page, `${theme}-02-gathering`), theme)
      assert.ok(gathering.spread < waiting.spread - 0.08, `the dots gather: ${waiting.spread.toFixed(2)} → ${gathering.spread.toFixed(2)}`)
      for (const at of [150, 300, 560, 720, 880]) { await seek(page, WAIT_MS + at, WAIT_MS); await shot(page, `${theme}-03-build-${at}`) }
      pass(`${theme}: at the finish signal the dots gather`, `spread ${(gathering.spread * 100).toFixed(0)}%`)

      // 4. Settled: the wordmark alone, in Instrument Serif, where text in that font would stand; every dot gone.
      await seek(page, WAIT_MS + SETTLED_MS + 40, WAIT_MS)
      const settled = read(await shot(page, `${theme}-04-settled`), theme)
      const match = overlap(settled.ink, referenceInk)
      assert.equal(settled.accentCount, 0, `no dot left once settled: ${settled.accentCount} accent pixels`)
      assert.ok(match >= 0.85, `the wordmark matches "Ready" in Instrument Serif: ${match.toFixed(3)}`)
      pass(`${theme}: settled, the wordmark stands alone and matches Instrument Serif`, `overlap ${match.toFixed(3)}`)

      // 5. Only opacity and transform move, before and after the finish signal; no frame-by-frame script.
      await page.reload()
      const motion = await page.evaluate(async event => {
        const properties = new Set()
        const collect = () => document.getAnimations().forEach(animation => {
          if (animation.transitionProperty) properties.add(animation.transitionProperty)
          else animation.effect.getKeyframes().forEach(keyframe => Object.keys(keyframe).forEach(key => { if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) properties.add(key) }))
        })
        collect()
        window.dispatchEvent(new Event(event))
        void getComputedStyle(document.body).opacity
        collect()
        await new Promise(resolve => setTimeout(resolve, 200))
        return { properties: [...properties].sort(), raf: window.__rafCalls }
      }, splash.STARTUP_SPLASH_FINISH_EVENT)
      assert.deepEqual(motion.properties, ['opacity', 'transform'])
      assert.equal(motion.raf, 0)
      pass(`${theme}: only opacity and transform move, with no per-frame script`)

      // 6. In real time (not seeked): the finish signal at 1.5 s leaves the settled wordmark by its settle time.
      await page.reload()
      await page.waitForTimeout(WAIT_MS)
      await page.evaluate(event => window.dispatchEvent(new Event(event)), splash.STARTUP_SPLASH_FINISH_EVENT)
      await page.waitForTimeout(SETTLED_MS + 250)
      const live = read(await shot(page, `${theme}-05-real-time`), theme)
      assert.equal(live.accentCount, 0, `no dot left in real time: ${live.accentCount}`)
      assert.ok(overlap(live.ink, referenceInk) >= 0.85, 'the wordmark stands in real time')
      pass(`${theme}: in real time the same ending is reached`)

      // 7. Reduce motion: the wordmark from the first frame, no dots.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await seek(page, 0)
      const still = read(await shot(page, `${theme}-06-reduced-motion`), theme)
      assert.equal(still.accentCount, 0)
      assert.ok(overlap(still.ink, referenceInk) >= 0.85, 'with reduced motion the wordmark shows at once')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      pass(`${theme}: with reduced motion the wordmark shows at once, without dots`)

      // Frames for a person to judge, every 150 ms through the whole run.
      for (let at = 0; at <= WAIT_MS + SETTLED_MS + 300; at += 150) {
        await seek(page, at, WAIT_MS)
        await shot(page, `${theme}-run-${String(at).padStart(4, '0')}`)
      }
      await page.close()
    }
  } finally {
    await app.close().catch(() => {})
  }
  console.log(`\n${results.length} PASS. Frames: ${evidence}`)
}

main().catch(error => {
  console.error(error)
  console.error(`Frames so far: ${evidence}`)
  process.exitCode = 1
})
