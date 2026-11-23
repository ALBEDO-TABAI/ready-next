#!/usr/bin/env node
// Hidden check of the startup splash (plan docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md).
// The page the splash window loads (src/shared/startup-splash-markup.ts) is opened in a hidden Electron window of the
// same size as the splash window, over a flat stand-in for the desktop (the splash window itself is transparent), in
// both themes, and driven frame by frame: every animation paused and seeked to a moment, the finish signal sent at a
// chosen moment. The frames kept for a person to judge are drawn over a colourful stand-in wallpaper. Nothing is shown on screen; HOME and TMPDIR live in
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
// What shows through the clear glass: a flat mid-grey and a flat dark desktop for the measurements (the wordmark is white
// in both appearances, so it is measured where white stands out), a colourful one for the frames a person looks at.
const DESKTOP = { light: '#6f7884', dark: '#1e2734' }
const WALLPAPER = 'html { background: radial-gradient(70% 120% at 15% 10%, #f2b38a, transparent 60%), radial-gradient(60% 110% at 85% 90%, #6f8fd8, transparent 65%), linear-gradient(120deg, #2c3e66, #a35d6a 55%, #e7c27d) !important; }'
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
// the wordmark inside its box (its white core; the glow around it is dimmer).
function read(png) {
  const scale = png.width / W
  const accent = new Uint8Array(png.width * png.height), ink = new Uint8Array(png.width * png.height)
  const place = splash.STARTUP_SPLASH_WORDMARK_PLACE
  const box = { x0: (place.x - 12) * scale, x1: (place.x + 2.1 * place.fontSize + 12) * scale, y0: (place.baseline - place.fontSize) * scale, y1: (place.baseline + 0.3 * place.fontSize) * scale }
  let accentCount = 0, minX = Infinity, maxX = -Infinity
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4, r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
    if (r > 120 && r - b > 70 && r - g > 45) { /* orange, also where a dot breathes dim */ accent[y * png.width + x] = 1; accentCount++; minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && lum > 235 && Math.abs(r - b) < 40) ink[y * png.width + x] = 1
  }
  let blobs = 0, largest = 0, outside = 0
  const near = { x0: (place.x - 34) * scale, x1: (place.x + 2.05 * place.fontSize + 34) * scale, y0: (place.baseline - 0.8 * place.fontSize - 34) * scale, y1: (place.baseline + 0.25 * place.fontSize + 34) * scale }
  const seen = new Uint8Array(accent.length), stack = []
  for (let start = 0; start < accent.length; start++) {
    if (!accent[start] || seen[start]) continue
    let size = 0
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const at = stack.pop(); size++
      const x = at % png.width, y = (at - x) / png.width
      if (x < near.x0 || x > near.x1 || y < near.y0 || y > near.y1) outside++
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * png.width + nx
        if (nx >= 0 && ny >= 0 && nx < png.width && ny < png.height && accent[n] && !seen[n]) { seen[n] = 1; stack.push(n) }
      }
    }
    if (size >= 2 * scale * scale) blobs++
    largest = Math.max(largest, size / (scale * scale))
  }
  return { scale, accentCount, blobs, largest, outside, spread: accentCount ? (maxX - minX) / png.width : 0, ink }
}

function overlap(a, b) {
  let both = 0, either = 0
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) both++; if (a[i] || b[i]) either++ }
  return either ? both / either : 0
}

const ENTRY = `const { app } = require('electron')
app.setPath('userData', ${JSON.stringify(path.join(temporary, 'profile'))})
app.on('window-all-closed', () => {})
globalThis.__loadNative = file => { const loaded = { exports: {} }; process.dlopen(loaded, file); return loaded.exports }
`
// The splash's native glass layer as Main loads it in development (src/main/startup-glass.ts), built by rebuild:native.
const NATIVE_GLASS = path.join(REPO, 'native', 'startup-glass', 'build', 'Release', 'ready_glass.node')

async function main() {
  const entry = path.join(temporary, 'entry.cjs')
  fs.writeFileSync(entry, ENTRY)
  const app = await _electron.launch({ executablePath: require(path.join(REPO, 'node_modules', 'electron')), args: [entry], env: { ...process.env, READY_START_HIDDEN: '1' }, timeout: 60000 })
  try {
    const open = async (url, background, transparent = false) => {
      const pending = app.waitForEvent('window')
      await app.evaluate(({ BrowserWindow }, { url, background, width, height, transparent }) => {
        const win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, transparent, backgroundColor: transparent ? '#00000000' : background, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } })
        void win.loadURL(url)
      }, { url, background, width: W, height: H, transparent })
      const page = await pending
      await page.waitForLoadState('load')
      return page
    }

    for (const theme of ['light', 'dark']) {
      const markup = splash.renderStartupSplashMarkup(theme)
      const page = await open(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`, DESKTOP[theme])
      // No frame-by-frame script: requestAnimationFrame is counted from before the page's own script runs.
      await page.addInitScript(() => { window.__rafCalls = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = callback => { window.__rafCalls++; return raf(callback) } })

      // The reference: "Ready" set as text in the app's Instrument Serif file, where the splash says the wordmark stands.
      const reference = await open(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><body style="margin:0;background:${DESKTOP[theme]}"><canvas width="${W}" height="${H}" style="display:block;width:${W}px;height:${H}px"></canvas></body>`)}`, DESKTOP[theme])
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
      }, { font: FONT, place: splash.STARTUP_SPLASH_WORDMARK_PLACE, ink: '#ffffff', W, H })
      const referenceInk = read(await shot(reference, `${theme}-reference`)).ink
      await reference.close()

      // 1. Before anything moves: the glass alone.
      await seek(page, 0)
      let frame = read(await shot(page, `${theme}-00-glass`))
      assert.equal(frame.accentCount, 0, 'no dot before the intro')
      assert.ok(overlap(frame.ink, referenceInk) < 0.05, 'no wordmark before the intro')
      pass(`${theme}: the first frame is the clear glass alone`)

      // 2. While Ready loads the page stays as it is: no dot, no wordmark (on macOS 26+ the water moves in the native
      // layer under the page, plan §6).
      for (const at of [900, 1200, WAIT_MS]) {
        await seek(page, at)
        const loading = read(await shot(page, `${theme}-01-loading-${at}`))
        assert.equal(loading.accentCount, 0, `no dot while loading: ${loading.accentCount} accent pixels`)
        assert.ok(overlap(loading.ink, referenceInk) < 0.05, 'the wordmark is not revealed while loading')
      }
      pass(`${theme}: while loading, the page shows no dot and no wordmark`)

      // 3. At the finish signal: dots appear beside the five letters (nowhere else), before any letter shows.
      await seek(page, WAIT_MS + 300, WAIT_MS)
      const appearing = read(await shot(page, `${theme}-02-dots-appear`))
      assert.ok(appearing.blobs >= 20, `dots beside the letters: ${appearing.blobs}`)
      assert.ok(appearing.outside === 0, `every dot is beside the wordmark (${appearing.outside} px outside)`)
      assert.ok(overlap(appearing.ink, referenceInk) < 0.2, 'the letters are not there yet')
      for (const at of [150, 450, 650, 800, 950, 1100]) { await seek(page, WAIT_MS + at, WAIT_MS); await shot(page, `${theme}-03-build-${at}`) }
      pass(`${theme}: when Ready is about to open, dots appear beside the five letters`, `${appearing.blobs} dots`)

      // 4. Settled: the wordmark alone, in Instrument Serif, where text in that font would stand; every dot gone.
      await seek(page, WAIT_MS + SETTLED_MS + 40, WAIT_MS)
      const settled = read(await shot(page, `${theme}-04-settled`))
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
      const live = read(await shot(page, `${theme}-05-real-time`))
      assert.equal(live.accentCount, 0, `no dot left in real time: ${live.accentCount}`)
      assert.ok(overlap(live.ink, referenceInk) >= 0.85, 'the wordmark stands in real time')
      pass(`${theme}: in real time the same ending is reached`)

      // 7. Reduce motion: the wordmark from the first frame, no dots.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await seek(page, 0)
      const still = read(await shot(page, `${theme}-06-reduced-motion`))
      assert.equal(still.accentCount, 0)
      assert.ok(overlap(still.ink, referenceInk) >= 0.85, 'with reduced motion the wordmark shows at once')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      pass(`${theme}: with reduced motion the wordmark shows at once, without dots`)

      // 8. See-through: in a transparent window like the splash window, nothing is painted around the slab, and the
      // glass itself lets most of the desktop through.
      const clear = await open(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`, null, true)
      await seek(clear, 0)
      const glassPng = PNG.sync.read(await clear.screenshot({ omitBackground: true }))
      const alphaAt = (x, y) => glassPng.data[(Math.round(y * glassPng.width / W) * glassPng.width + Math.round(x * glassPng.width / W)) * 4 + 3]
      const slab = splash.STARTUP_SPLASH_SLAB
      for (const [x, y] of [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]]) assert.equal(alphaAt(x, y), 0, `the window corner (${x}, ${y}) is see-through`)
      let alphaSum = 0, alphaCount = 0
      for (let y = slab.y + 30; y < slab.y + slab.height - 30; y += 4) for (let x = slab.x + 40; x < slab.x + slab.width - 40; x += 4) { alphaSum += alphaAt(x, y); alphaCount++ }
      const meanAlpha = alphaSum / alphaCount / 255
      assert.ok(meanAlpha < 0.2, `the glass lets the desktop through: mean opacity ${meanAlpha.toFixed(2)}`)
      await clear.close()
      // Over the system's glass (macOS 26+) the page paints nothing where the slab is, until the wordmark comes.
      const bare = await open(`data:text/html;charset=utf-8,${encodeURIComponent(splash.renderStartupSplashMarkup(theme, { glass: 'native' }))}`, null, true)
      await seek(bare, WAIT_MS)
      const barePng = PNG.sync.read(await bare.screenshot({ omitBackground: true }))
      let painted = 0
      for (let i = 3; i < barePng.data.length; i += 4) if (barePng.data[i]) painted++
      assert.equal(painted, 0, `over the native glass nothing is painted while loading: ${painted} pixels`)
      await bare.close()
      pass(`${theme}: see-through around the slab, and the glass is clear; over the native glass the page is empty`, `glass opacity ${(meanAlpha * 100).toFixed(0)}%`)

      // Frames for a person to judge, every 150 ms through the whole run, over the colourful wallpaper.
      await page.addInitScript(css => document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = css; document.head.append(style) }), WALLPAPER)
      for (let at = 0; at <= WAIT_MS + SETTLED_MS + 300; at += 150) {
        await seek(page, at, WAIT_MS)
        await shot(page, `${theme}-run-${String(at).padStart(4, '0')}`)
      }
      await page.close()
    }

    // 9. On macOS 26+, the native glass layer loads in Electron and attaches the glass and the water under a hidden
    // transparent window of the splash's size, calms and clears (how it looks on a real desktop needs a person).
    const major = Number((await app.evaluate(() => process.getSystemVersion())).split('.')[0])
    if (process.platform === 'darwin' && major >= 26 && fs.existsSync(NATIVE_GLASS)) {
      const added = await app.evaluate(async ({ BrowserWindow }, { file, slab, width, height }) => {
        const glass = globalThis.__loadNative(file)
        const win = new BrowserWindow({ width, height, show: false, frame: false, transparent: true, backgroundColor: '#00000000' })
        const result = glass.attach(win.getNativeWindowHandle(), slab.x, slab.y, slab.width, slab.height, slab.radius, 18, 200)
        glass.calm(0.2)
        await new Promise(resolve => setTimeout(resolve, 300))
        const cleared = glass.clear()
        win.destroy()
        return `${result} / ${cleared}`
      }, { file: NATIVE_GLASS, slab: splash.STARTUP_SPLASH_SLAB, width: W, height: H })
      assert.equal(added, 'glass ripples / clear')
      pass('native glass: loads in Electron, attaches the glass and the water, calms and clears', added)
    } else console.log(`SKIP native glass: needs macOS 26+ and ${path.relative(REPO, NATIVE_GLASS)} (npm run rebuild:native)`)
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
