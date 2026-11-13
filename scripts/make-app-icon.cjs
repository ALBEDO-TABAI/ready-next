#!/usr/bin/env electron
// The app icon: the wordmark "Ready" in Instrument Serif, ink on a white tile (V30).
// Draws build/icon.svg (the source, with the font embedded) and build/icon.png (1024) in a hidden
// Electron window, then build/icon.icns (sips + iconutil, macOS) and build/icon.ico (PNG entries).
//
//   npx electron scripts/make-app-icon.cjs
//
// Geometry (1024 canvas): the tile is the macOS icon grid's 820px rounded square (x 102, radius 176);
// the word is centred on the tile by its ink, its visual middle (between cap height and descender,
// .281em above the baseline for "Ready") on the tile's centre, and it keeps WORD_WIDTH of the tile's
// width so there is air on every side.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const BUILD = path.join(ROOT, 'build')
const FONT = path.join(ROOT, 'src/renderer/design/next/fonts/InstrumentSerif.woff2')
const TILE = { x: 102, y: 102, size: 820, radius: 176, fill: '#FFFFFF' }
const INK = '#0B0B0E'
const WORD = 'Ready'
const WORD_WIDTH = 0.64 // of the tile's width
const VISUAL_MIDDLE_EM = 0.281 // above the baseline

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ready-icon-')))
app.dock?.hide()

const page = fontDataUrl => `<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c" width="1024" height="1024"></canvas><script>
window.draw = async (cfg) => {
  const face = new FontFace('Ready Icon Serif', 'url(${fontDataUrl})'); await face.load(); document.fonts.add(face)
  const c = document.getElementById('c'), g = c.getContext('2d')
  const probe = 400; g.font = probe + 'px "Ready Icon Serif"'
  const m = g.measureText(cfg.word)
  const inkWidthEm = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / probe
  const size = Math.round((cfg.tile.size * cfg.wordWidth) / inkWidthEm)
  g.font = size + 'px "Ready Icon Serif"'
  const w = g.measureText(cfg.word)
  const centre = cfg.tile.x + cfg.tile.size / 2
  const x = centre - (w.actualBoundingBoxRight - w.actualBoundingBoxLeft) / 2
  const y = centre + cfg.middleEm * size
  g.clearRect(0, 0, 1024, 1024)
  g.fillStyle = cfg.tile.fill; g.beginPath(); g.roundRect(cfg.tile.x, cfg.tile.y, cfg.tile.size, cfg.tile.size, cfg.tile.radius); g.fill()
  g.fillStyle = cfg.ink; g.textBaseline = 'alphabetic'; g.fillText(cfg.word, x, y)
  const ink = { x: x - w.actualBoundingBoxLeft, y: y - w.actualBoundingBoxAscent, width: w.actualBoundingBoxLeft + w.actualBoundingBoxRight, height: w.actualBoundingBoxAscent + w.actualBoundingBoxDescent }
  return { png: c.toDataURL('image/png'), size, x, y, ink }
}
</script>`

app.whenReady().then(async () => {
  const fontDataUrl = `data:font/woff2;base64,${fs.readFileSync(FONT).toString('base64')}`
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(fontDataUrl))}`)
  const drawn = await win.webContents.executeJavaScript(`window.draw(${JSON.stringify({ word: WORD, tile: TILE, ink: INK, wordWidth: WORD_WIDTH, middleEm: VISUAL_MIDDLE_EM })})`)
  const round = n => Math.round(n * 10) / 10
  const png = Buffer.from(drawn.png.split(',')[1], 'base64')
  fs.writeFileSync(path.join(BUILD, 'icon.png'), png)
  const ink = [drawn.ink.x, drawn.ink.y, drawn.ink.width, drawn.ink.height].map(round).join(' ')
  fs.writeFileSync(path.join(BUILD, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Ready">
  <style>@font-face { font-family: 'Ready Icon Serif'; src: url(${fontDataUrl}) format('woff2'); }</style>
  <rect x="${TILE.x}" y="${TILE.y}" width="${TILE.size}" height="${TILE.size}" rx="${TILE.radius}" fill="${TILE.fill}" />
  <text x="${round(drawn.x)}" y="${round(drawn.y)}" font-family="'Ready Icon Serif'" font-size="${drawn.size}" fill="${INK}" data-ink-box="${ink}">${WORD}</text>
</svg>
`)
  if (process.platform === 'darwin') {
    const set = path.join(app.getPath('userData'), 'icon.iconset'); fs.mkdirSync(set)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const out = path.join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)
        execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), path.join(BUILD, 'icon.png'), '--out', out], { stdio: 'ignore' })
      }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')])
    // .ico: a directory of PNG images (Vista and later read PNG entries).
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const images = sizes.map(size => {
      const out = path.join(set, `ico_${size}.png`)
      execFileSync('/usr/bin/sips', ['-z', String(size), String(size), path.join(BUILD, 'icon.png'), '--out', out], { stdio: 'ignore' })
      return fs.readFileSync(out)
    })
    const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, i) => {
      const at = 6 + 16 * i
      header.writeUInt8(size === 256 ? 0 : size, at); header.writeUInt8(size === 256 ? 0 : size, at + 1)
      header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6)
      header.writeUInt32LE(images[i].length, at + 8); header.writeUInt32LE(offset, at + 12)
      offset += images[i].length
    })
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), Buffer.concat([header, ...images]))
  } else {
    console.warn('icon.icns and icon.ico are only rebuilt on macOS (sips, iconutil)')
  }
  console.log(`icon: "${WORD}" at ${drawn.size}px, ink box ${ink}`)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
