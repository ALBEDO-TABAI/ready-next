#!/usr/bin/env node

const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { app, BrowserWindow } = require('electron')

const OUT_DIR = resolve(
  process.env.READY_LIQUID_GLASS_PROBE_DIR ||
    'docs/superpowers/audits/2026-06-02-liquid-glass-residue',
)

const WINDOW_SIZE = { width: 720, height: 560 }

const VARIANTS = [
  {
    id: 'baseline',
    label: 'transparent vibrancy + backdrop-filter',
    css: '',
  },
  {
    id: 'c1-layer-promote',
    label: 'C1 contain + isolate + translateZ scroll root',
    css: `
      .probe-scroll {
        contain: paint;
        isolation: isolate;
        transform: translateZ(0);
        backface-visibility: hidden;
      }
      .probe-card {
        transform: translateZ(0);
        backface-visibility: hidden;
      }
    `,
  },
  {
    id: 'c2-painted-scroll-source',
    label: 'C2 faint painted scroll backdrop source',
    css: `
      .probe-scroll {
        contain: paint;
        isolation: isolate;
        transform: translateZ(0);
        backface-visibility: hidden;
        background: rgba(255, 255, 255, 0.045);
      }
    `,
  },
  {
    id: 'c3-window-painted-source',
    label: 'C3 faint window painted backdrop source',
    css: `
      .probe-app-bg {
        opacity: 0.12;
      }
      .probe-scroll {
        contain: paint;
        isolation: isolate;
        transform: translateZ(0);
        backface-visibility: hidden;
      }
    `,
  },
]

function pageHtml(variantCss) {
  const rows = Array.from({ length: 90 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    return `<div class="probe-row">Ready liquid glass damage row ${n} · Chromium 148 repaint source · 设置页滚动残影检测</div>`
  }).join('')

  const cards = Array.from({ length: 22 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    return `
      <section class="probe-card">
        <strong>Glass card ${n}</strong>
        <span>Backdrop blur must remain visible while this layer scrolls over text.</span>
      </section>
    `
  }).join('')

  return `<!doctype html>
  <html data-theme="light" data-skin="liquid-glass">
    <head>
      <meta charset="utf-8" />
      <style>
        html,
        body {
          margin: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: transparent;
          font-family: Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        }

        .probe-root {
          position: relative;
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          background: transparent;
          isolation: isolate;
        }

        .probe-app-bg {
          position: absolute;
          inset: 0;
          z-index: 0;
          pointer-events: none;
          opacity: 0;
          background:
            radial-gradient(780px 520px at 12% 8%, rgba(145, 181, 245, 0.25), transparent 68%),
            radial-gradient(620px 420px at 88% 18%, rgba(170, 211, 240, 0.18), transparent 70%),
            linear-gradient(142deg, rgba(246, 249, 253, 0.86), rgba(239, 245, 252, 0.62));
        }

        .probe-chrome {
          position: absolute;
          inset: 22px;
          z-index: 1;
          display: grid;
          grid-template-columns: 230px 1fr;
          gap: 18px;
        }

        .probe-sidebar,
        .probe-main {
          min-height: 0;
          border: 1px solid rgba(180, 198, 226, 0.34);
          border-radius: 24px;
          background: rgba(255, 255, 255, 0.12);
          overflow: hidden;
          backdrop-filter: blur(22px) saturate(150%);
          -webkit-backdrop-filter: blur(22px) saturate(150%);
        }

        .probe-sidebar {
          padding: 16px;
        }

        .probe-title {
          position: sticky;
          top: 0;
          z-index: 2;
          padding: 16px 18px;
          color: rgba(26, 32, 44, 0.88);
          font-size: 15px;
          font-weight: 700;
          background: rgba(255, 255, 255, 0.18);
          backdrop-filter: blur(18px) saturate(145%);
          -webkit-backdrop-filter: blur(18px) saturate(145%);
        }

        .probe-underlay {
          position: absolute;
          inset: 0;
          z-index: 0;
          padding: 76px 28px 28px;
          color: rgba(18, 28, 46, 0.28);
          font-size: 13px;
          line-height: 1.15;
          pointer-events: none;
          user-select: none;
        }

        .probe-row {
          white-space: nowrap;
          margin-bottom: 4px;
        }

        .probe-scroll {
          position: relative;
          z-index: 1;
          height: calc(100% - 51px);
          overflow: auto;
          padding: 18px;
          scrollbar-width: thin;
        }

        .probe-card {
          position: relative;
          margin: 0 0 14px;
          padding: 18px 18px;
          min-height: 96px;
          border-radius: 20px;
          border: 1px solid rgba(255, 255, 255, 0.32);
          color: rgba(22, 30, 46, 0.9);
          background: color-mix(in srgb, rgba(255, 255, 255, 0.30) 58%, transparent);
          backdrop-filter: blur(24px) saturate(150%) contrast(1.02);
          -webkit-backdrop-filter: blur(24px) saturate(150%) contrast(1.02);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.48);
        }

        .probe-card strong,
        .probe-card span {
          display: block;
        }

        .probe-card span {
          margin-top: 9px;
          color: rgba(61, 73, 96, 0.78);
          line-height: 1.45;
        }

        .probe-pill {
          display: block;
          margin-bottom: 10px;
          padding: 12px;
          border-radius: 16px;
          color: rgba(25, 35, 54, 0.82);
          background: rgba(255, 255, 255, 0.18);
          backdrop-filter: blur(16px) saturate(145%);
          -webkit-backdrop-filter: blur(16px) saturate(145%);
        }

        ${variantCss}
      </style>
    </head>
    <body>
      <div class="probe-root">
        <div class="probe-app-bg"></div>
        <div class="probe-chrome">
          <aside class="probe-sidebar">
            <span class="probe-pill">IconRail 槽</span>
            <span class="probe-pill">文件管理</span>
            <span class="probe-pill">设置导航</span>
            <span class="probe-pill">Agent 面板</span>
          </aside>
          <main class="probe-main">
            <div class="probe-title">Liquid glass residue probe</div>
            <div class="probe-underlay">${rows}</div>
            <div class="probe-scroll">${cards}</div>
          </main>
        </div>
      </div>
    </body>
  </html>`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function capture(win, name) {
  await sleep(90)
  const image = await win.webContents.capturePage()
  const png = image.toPNG()
  const file = join(OUT_DIR, `${name}.png`)
  writeFileSync(file, png)
  return image
}

function meanPixelDelta(a, b) {
  const sizeA = a.getSize()
  const sizeB = b.getSize()
  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) return Number.POSITIVE_INFINITY
  const bitmapA = a.toBitmap()
  const bitmapB = b.toBitmap()
  const stride = 4
  let total = 0
  let samples = 0
  for (let y = Math.floor(sizeA.height * 0.18); y < Math.floor(sizeA.height * 0.9); y += 2) {
    for (let x = Math.floor(sizeA.width * 0.38); x < Math.floor(sizeA.width * 0.94); x += 2) {
      const offset = (y * sizeA.width + x) * stride
      total += Math.abs(bitmapA[offset] - bitmapB[offset])
      total += Math.abs(bitmapA[offset + 1] - bitmapB[offset + 1])
      total += Math.abs(bitmapA[offset + 2] - bitmapB[offset + 2])
      samples += 3
    }
  }
  return samples > 0 ? total / samples : Number.POSITIVE_INFINITY
}

async function runVariant(variant) {
  const htmlPath = join(OUT_DIR, `${variant.id}.html`)
  writeFileSync(htmlPath, pageHtml(variant.css))

  const win = new BrowserWindow({
    ...WINDOW_SIZE,
    show: process.env.READY_LIQUID_GLASS_PROBE_SHOW !== '0',
    title: `Ready liquid glass probe: ${variant.id}`,
    backgroundColor: '#00000000',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  try {
    await win.loadFile(htmlPath)
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    `)

    const computed = await win.webContents.executeJavaScript(`
      (() => {
        const scroll = document.querySelector('.probe-scroll')
        const card = document.querySelector('.probe-card')
        const scrollStyle = getComputedStyle(scroll)
        const cardStyle = getComputedStyle(card)
        return {
          scrollContain: scrollStyle.contain,
          scrollIsolation: scrollStyle.isolation,
          scrollTransform: scrollStyle.transform,
          scrollBackground: scrollStyle.backgroundColor,
          cardBackdropFilter: cardStyle.backdropFilter || cardStyle.webkitBackdropFilter || '',
          cardTransform: cardStyle.transform,
        }
      })()
    `)

    const before = await capture(win, `${variant.id}-top-before`)
    await win.webContents.executeJavaScript(`
      (async () => {
        const scroll = document.querySelector('.probe-scroll')
        scroll.scrollTop = 720
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        scroll.scrollTop = 0
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })()
    `)
    const after = await capture(win, `${variant.id}-top-after-scroll`)
    const residueScore = meanPixelDelta(before, after)

    return {
      id: variant.id,
      label: variant.label,
      computed,
      residueScore,
      screenshots: {
        before: `${variant.id}-top-before.png`,
        after: `${variant.id}-top-after-scroll.png`,
      },
      blurPresent: /blur\(/.test(String(computed.cardBackdropFilter)),
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  app.on('window-all-closed', (event) => {
    event.preventDefault()
  })
  await app.whenReady()

  const results = []
  for (const variant of VARIANTS) {
    results.push(await runVariant(variant))
  }

  const blurSafeResults = results.filter(
    (item) => item.id !== 'baseline' && item.blurPresent && Number.isFinite(item.residueScore),
  )
  const selected = blurSafeResults.slice().sort((a, b) => a.residueScore - b.residueScore)[0] || null
  const summary = {
    timestamp: new Date().toISOString(),
    process: {
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    selectedCandidate: selected
      ? {
        id: selected.id,
        reason: 'lowest non-baseline top-before/top-after pixel residue score while computed backdrop-filter keeps blur()',
      }
      : null,
    results,
  }

  const json = JSON.stringify(summary, null, 2)
  writeFileSync(join(OUT_DIR, 'probe-summary.json'), json + '\n')
  console.log(json)

  const requirePass = process.env.READY_LIQUID_GLASS_PROBE_REQUIRE === '1'
  app.exit(requirePass && !selected ? 1 : 0)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  app.exit(1)
})
