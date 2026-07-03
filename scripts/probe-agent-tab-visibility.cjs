#!/usr/bin/env node
/**
 * P1-R0.1 (2026-07-03) — Phase 0 verification for the lane-decoupling plan's
 * live-host visibility item (never actually run before). It proves, at the
 * Electron level and independent of any site, whether an agent tab's page goes
 * `document.visibilityState === 'hidden'` — and whether IntersectionObserver /
 * requestAnimationFrame stop firing — when the host view is parked offscreen
 * (hideHost's 1x1 offscreen bounds) or detached (a background tab that was
 * never surfaced). Those are exactly the two states an agent collection tab
 * runs in today, and XHS-style lazy-load / login rendering gate on visibility.
 *
 * Run: electron scripts/probe-agent-tab-visibility.cjs   (or npm run verify:agent-tab-visibility)
 * Exit 0 = probe completed. Exit 1 = probe error. The JSON verdict is printed.
 */
const { app, BrowserWindow, WebContentsView } = require('electron')

// Mirror host-layout-service.createHost webPreferences (backgroundThrottling off).
const HOST_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  spellcheck: true,
  webSecurity: true,
  backgroundThrottling: false,
}

// Mirror host-layout-service.offscreenBounds (hideHost target).
const OFFSCREEN_BOUNDS = { x: -100000, y: -100000, width: 1, height: 1 }
const VISIBLE_BOUNDS = { x: 0, y: 0, width: 800, height: 600 }
const SETTLE_MS = 1500

function instrumentationPage() {
  // A tall page with a below-the-fold element observed by IntersectionObserver,
  // a running rAF tick counter, and a visibilitychange log. The driver scrolls
  // the element into view in each state and reads whether IO fired + rAF ticked.
  return String.raw`
    <!doctype html><html><head><meta charset="utf-8"></head>
    <body style="margin:0">
      <div style="height:2000px">spacer</div>
      <div id="target" style="height:200px;background:#0a0">below-fold target</div>
      <script>
        window.__probe = { rafTicks: 0, ioFires: 0, visLog: [] };
        window.__probe.visLog.push(document.visibilityState);
        document.addEventListener('visibilitychange', () => {
          window.__probe.visLog.push(document.visibilityState);
        });
        const loop = () => { window.__probe.rafTicks++; requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) { if (e.isIntersecting) window.__probe.ioFires++; }
        }, { threshold: 0.01 });
        io.observe(document.getElementById('target'));
        window.__snap = (label) => {
          const before = window.__probe.rafTicks;
          return new Promise((resolve) => {
            // scroll target into view so a *visible* page fires IO
            document.getElementById('target').scrollIntoView();
            setTimeout(() => {
              resolve({
                label,
                visibilityState: document.visibilityState,
                hidden: document.hidden,
                rafTicksDelta: window.__probe.rafTicks - before,
                ioFires: window.__probe.ioFires,
                visLog: window.__probe.visLog.slice(),
              });
            }, ${SETTLE_MS});
          });
        };
      </script>
    </body></html>
  `
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({ width: 820, height: 640, show: true, webPreferences: { contextIsolation: true } })
  const view = new WebContentsView({ webPreferences: HOST_WEB_PREFERENCES })
  const wc = view.webContents

  const html = 'data:text/html;charset=utf-8,' + encodeURIComponent(instrumentationPage())

  // ── State A: attached + visible bounds (secondary-pane-style live host) ──
  win.contentView.addChildView(view)
  view.setBounds(VISIBLE_BOUNDS)
  await wc.loadURL(html)
  await sleep(300)
  const visible = await wc.executeJavaScript('window.__snap("attached_visible_bounds")', true)

  // ── State B: attached + offscreen 1x1 (exactly hideHost) ──
  view.setBounds(OFFSCREEN_BOUNDS)
  await sleep(300)
  const offscreen = await wc.executeJavaScript('window.__snap("attached_offscreen_1x1")', true)

  // ── State C: detached (background tab never surfaced) ──
  win.contentView.removeChildView(view)
  await sleep(300)
  const detached = await wc.executeJavaScript('window.__snap("detached_background")', true)

  const states = { visible, offscreen, detached }
  const verdict = {
    // The load-bearing question: do offscreen / detached report hidden?
    offscreenIsHidden: offscreen.visibilityState === 'hidden' || offscreen.hidden === true,
    detachedIsHidden: detached.visibilityState === 'hidden' || detached.hidden === true,
    visibleIsVisible: visible.visibilityState === 'visible',
    // Secondary confirmation: observers/rAF stall when hidden.
    offscreenIoStalled: offscreen.ioFires === 0,
    detachedIoStalled: detached.ioFires === 0,
  }
  const conclusion =
    (verdict.offscreenIsHidden || verdict.detachedIsHidden)
      ? 'CONFIRMED: an offscreen/detached agent tab reports visibilityState=hidden — visibility-gated sites (XHS lazy-load/login) will not render, matching the 0-candidate collection failures.'
      : 'NOT CONFIRMED: offscreen/detached did not report hidden on this Electron build — the collection-0 root lies elsewhere.'

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    settleMs: SETTLE_MS,
    states,
    verdict,
    conclusion,
  }, null, 2))

  try { win.destroy() } catch { /* ignore */ }
  app.exit(0)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  app.exit(1)
})
