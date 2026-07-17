import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import pngjs from 'pngjs'

const { PNG } = pngjs

const port = Number(process.env.READY_REMOTE_DEBUGGING_PORT || 9333)
const outPath = resolve(process.argv[2] || 'outputs/agent-audit/live/p7c3-native-lock-overlay-report.json')
const outDir = dirname(outPath)
const browserViewShotPath = resolve(outDir, 'p7c3-browser-view-only.png')
const browserViewCdpShotPath = resolve(outDir, 'p7c3-browser-view-cdp.png')
const compositedShotPath = resolve(outDir, 'p7c3-composited-overlay.png')
const mainWindowShotPath = resolve(outDir, 'p7c3-main-window-capture.png')
const afterHideShotPath = resolve(outDir, 'p7c3-after-hide.png')

const PAGE_MARKER = { r: 0, g: 255, b: 0 }
const OVERLAY_MARKER = { r: 255, g: 0, b: 255 }
const OVERLAY_MARKER_HEX = '#ff00ff'
const PROOF_SAMPLE = { x: 18, y: 18 }

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`)
  return response.json()
}

async function connect(target) {
  let id = 0
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const rejectPending = (error) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message)
      pending.delete(message.id)
    }
  })
  ws.addEventListener('close', () => rejectPending(new Error('CDP websocket closed before response')))
  ws.addEventListener('error', () => rejectPending(new Error('CDP websocket error before response')))
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const callId = ++id
    pending.set(callId, { resolve: resolveSend, reject: rejectSend })
    try {
      ws.send(JSON.stringify({ id: callId, method, params }))
    } catch (error) {
      pending.delete(callId)
      rejectSend(error)
    }
  })
  await send('Runtime.enable')
  return { ws, send }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function evaluate(client, expression) {
  const result = await withTimeout(
    client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }),
    30_000,
    'Runtime.evaluate',
  )
  if (result.result?.exceptionDetails) {
    const details = result.result.exceptionDetails
    throw new Error(details.exception?.description || details.text || 'Runtime.evaluate failed')
  }
  const value = result.result?.result?.value
  return typeof value === 'string' ? JSON.parse(value) : value
}

async function findTarget(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastCount = 0
  do {
    const targets = await listTargets()
    lastCount = targets.length
    const found = targets.find(predicate)
    if (found) return found
    await wait(250)
  } while (Date.now() < deadline)
  throw new Error(`${label} target not found among ${lastCount} target(s)`)
}

async function readRendererGlobalString(client, name, chunkSize = 120_000) {
  const length = await evaluate(client, `JSON.stringify(String(window[${JSON.stringify(name)}] || '').length)`)
  let output = ''
  for (let offset = 0; offset < length; offset += chunkSize) {
    const chunk = await evaluate(
      client,
      `JSON.stringify(String(window[${JSON.stringify(name)}] || '').slice(${offset}, ${offset + chunkSize}))`,
    )
    output += chunk
  }
  return output
}

async function startFixtureServer() {
  const server = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
<html>
  <head>
    <title>P7c3 BrowserView Fixture</title>
    <style>
      html, body { margin: 0; width: 100%; min-height: 2400px; background: rgb(0, 255, 0); }
      #ready-p7c3-focus { position: absolute; left: 24px; top: 420px; width: 180px; height: 34px; }
      #ready-p7c3-label { position: absolute; left: 24px; top: 24px; color: #003300; font: 700 18px system-ui; }
    </style>
  </head>
  <body>
    <div id="ready-p7c3-label">P7c3 BrowserView green marker</div>
    <input id="ready-p7c3-focus" aria-label="P7c3 focus target" value="p7c3" />
    <script>
      const input = document.getElementById('ready-p7c3-focus')
      if (input) input.focus()
      window.scrollTo(0, 360)
    </script>
  </body>
</html>`)
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

function writeBase64Png(filePath, base64) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, Buffer.from(base64, 'base64'))
}

function readPng(filePath) {
  return PNG.sync.read(readFileSync(filePath))
}

function samplePng(filePath, point) {
  const png = readPng(filePath)
  const x = Math.max(0, Math.min(png.width - 1, Math.round(point.x)))
  const y = Math.max(0, Math.min(png.height - 1, Math.round(point.y)))
  const index = (png.width * y + x) << 2
  return {
    r: png.data[index],
    g: png.data[index + 1],
    b: png.data[index + 2],
    a: png.data[index + 3],
    x,
    y,
    width: png.width,
    height: png.height,
  }
}

function colorDistance(a, b) {
  return Math.sqrt(
    Math.pow((a.r || 0) - b.r, 2)
    + Math.pow((a.g || 0) - b.g, 2)
    + Math.pow((a.b || 0) - b.b, 2),
  )
}

function nearColor(sample, expected, tolerance = 80) {
  return colorDistance(sample, expected) <= tolerance
}

function hasVisiblePixels(filePath) {
  const png = readPng(filePath)
  const stepX = Math.max(1, Math.floor(png.width / 80))
  const stepY = Math.max(1, Math.floor(png.height / 80))
  for (let y = 0; y < png.height; y += stepY) {
    for (let x = 0; x < png.width; x += stepX) {
      const index = (png.width * y + x) << 2
      if (png.data[index] !== 0 || png.data[index + 1] !== 0 || png.data[index + 2] !== 0) {
        return true
      }
    }
  }
  return false
}

function captureScreen(filePath) {
  if (process.platform !== 'darwin') {
    throw new Error(`OS composited screenshot proof is only implemented on macOS, got ${process.platform}`)
  }
  mkdirSync(dirname(filePath), { recursive: true })
  execFileSync('screencapture', ['-x', filePath], { stdio: 'ignore', timeout: 10_000 })
}

function tryCaptureScreen(filePath) {
  try {
    captureScreen(filePath)
    return {
      attempted: true,
      available: hasVisiblePixels(filePath),
      path: filePath,
    }
  } catch (error) {
    return {
      attempted: true,
      available: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function tryCaptureTargetScreenshot(target, filePath) {
  const client = await connect(target)
  try {
    await client.send('Page.enable')
    const result = await withTimeout(
      client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
      20_000,
      'Page.captureScreenshot',
    )
    const data = result.result?.data
    if (!data) throw new Error('Page.captureScreenshot returned no data')
    writeBase64Png(filePath, data)
    return { ok: true, path: filePath }
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    client.ws.close()
  }
}

async function inspectFixtureTarget(target) {
  const client = await connect(target)
  try {
    return await evaluate(client, `JSON.stringify({
      url: location.href,
      title: document.title,
      bodyBackgroundColor: getComputedStyle(document.body).backgroundColor,
      labelText: document.querySelector('#ready-p7c3-label')?.textContent || null,
      activeElementId: document.activeElement?.id || null,
      scrollY: window.scrollY,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    })`)
  } finally {
    client.ws.close()
  }
}

function buildMainProbeExpression(fixtureUrl) {
  return `(
    async () => {
      const api = window.electronAPI?.browser
      const fail = (error, detail = null) => JSON.stringify({ ok: false, error, detail })
      if (!api?.createTab || !api?.switchTab || !api?.getTabs || !api?.sendIntent || !api?.showBrowserLockOverlay || !api?.hideBrowserLockOverlay || !api?.getBrowserLockOverlaySnapshot || !api?.getBrowserAgentPointerSnapshot || !api?.p7cLiveProofAgentClick || !api?.p7cLiveProofFinishAgentAction) {
        return fail('missing-p7c3-browser-api')
      }
      window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'browser' } }))
      const modeReadyStartedAt = performance.now()
      while (performance.now() - modeReadyStartedAt < 5000) {
        const panel = document.querySelector('[data-workbench-mode-panel="browser"]')
        if (panel?.getAttribute('data-mode-visual-state') === 'current') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const created = await api.createTab(${JSON.stringify(fixtureUrl)})
      if (!created?.success || !created.tabId) return fail('failed-to-create-fixture-tab', created?.error || created)
      await api.switchTab(created.tabId)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      let frame = document.querySelector('[data-browser-content-frame]')
      if (!frame) {
        // A direct proof-only create can race the renderer's initial empty-tab
        // hydration. A real mode round-trip makes the renderer reconcile the
        // already-created native tab before geometry is measured.
        window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'document' } }))
        await new Promise((resolve) => setTimeout(resolve, 700))
        window.dispatchEvent(new CustomEvent('ready:workbench-mode-change-request', { detail: { mode: 'browser' } }))
        const frameReadyStartedAt = performance.now()
        while (performance.now() - frameReadyStartedAt < 5000) {
          frame = document.querySelector('[data-browser-content-frame]')
          if (frame) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      if (!frame) return fail('missing-browser-content-frame')
      const rect = frame.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return fail('invalid-browser-content-frame', { width: rect.width, height: rect.height })
      const hostShown = api.sendIntent({
        kind: 'show',
        intentId: Date.now(),
        tabId: created.tabId,
        bounds: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        reason: 'tab-activate',
      })
      if (!hostShown?.success) return fail('failed-to-show-fixture-host', hostShown?.error || hostShown)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const lifecycleStarted = await api.p7cLiveProofAgentClick(140, 160)
      if (!lifecycleStarted?.success) return fail('failed-to-start-agent-action-lifecycle', lifecycleStarted?.error || lifecycleStarted)
      const tabsBefore = await api.getTabs()
      const activeBefore = Array.isArray(tabsBefore) ? tabsBefore.find((tab) => tab.id === created.tabId) : null
      const snapshot = {
        kind: 'agent-current',
        label: 'P7c3 原生锁层证明',
        detail: 'Native child BrowserWindow overlay',
        tone: 'agent',
        bounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        proof: { enabled: true, color: ${JSON.stringify(OVERLAY_MARKER_HEX)}, samplePoint: ${JSON.stringify(PROOF_SAMPLE)} },
      }
      let shown = await api.showBrowserLockOverlay(snapshot)
      if (!shown?.success) return fail('failed-to-show-lock-overlay', shown?.error || shown)
      await new Promise((resolve) => setTimeout(resolve, 700))
      let shownSnapshot = await api.getBrowserLockOverlaySnapshot()
      if (!shownSnapshot?.success || !shownSnapshot.data) {
        await new Promise((resolve) => setTimeout(resolve, 800))
        shown = await api.showBrowserLockOverlay(snapshot)
        if (!shown?.success) return fail('failed-to-reshow-lock-overlay', shown?.error || shown)
        await new Promise((resolve) => setTimeout(resolve, 500))
        shownSnapshot = await api.getBrowserLockOverlaySnapshot()
      }
      if (!shownSnapshot?.success || !shownSnapshot.data) return fail('lock-overlay-did-not-stabilize', shownSnapshot)
      const tabsAfter = await api.getTabs()
      const activeAfter = Array.isArray(tabsAfter) ? tabsAfter.find((tab) => tab.id === created.tabId) : null
      return JSON.stringify({
        ok: true,
        created,
        activeBefore,
        activeAfter,
        hostShown,
        lifecycleStarted,
        shownSnapshot,
        snapshot,
        frameBounds: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        devicePixelRatio: window.devicePixelRatio || 1,
        screen: { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight },
      })
    }
  )()`
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const fixture = await startFixtureServer()
  let report
  let mainClient = null
  let overlayClient = null
  let pointerClient = null
  try {
    const mainTarget = await findTarget((target) => (
      target.type === 'page'
      && target.webSocketDebuggerUrl
      && typeof target.url === 'string'
      && target.url.startsWith('http://localhost:5173/')
      && !/(browser-lock-overlay|browser-agent-pointer)/.test(target.url)
    ), 20_000, 'Ready renderer')
    mainClient = await connect(mainTarget)
    const probe = await evaluate(mainClient, buildMainProbeExpression(fixture.url))
    if (!probe?.ok) throw new Error(probe?.error || 'main probe failed')

    const overlayTarget = await findTarget((target) => (
      target.type === 'page'
      && target.webSocketDebuggerUrl
      && typeof target.url === 'string'
      && /browser-lock-overlay/.test(target.url)
    ), 8_000, 'browser lock overlay')
    overlayClient = await connect(overlayTarget)
    const overlayMetrics = await evaluate(overlayClient, `JSON.stringify({
      text: document.body.innerText,
      url: location.href,
      marker: Boolean(document.querySelector('[data-p7c3-proof-marker]')),
      visibilityState: document.visibilityState,
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      screenAvailLeft: window.screen.availLeft || 0,
      screenAvailTop: window.screen.availTop || 0,
      proofMarkerRectContainsSample: (() => {
        const marker = document.querySelector('[data-p7c3-proof-marker]')
        if (!marker) return false
        const rect = marker.getBoundingClientRect()
        return rect.left <= ${PROOF_SAMPLE.x}
          && rect.right >= ${PROOF_SAMPLE.x}
          && rect.top <= ${PROOF_SAMPLE.y}
          && rect.bottom >= ${PROOF_SAMPLE.y}
      })(),
      proofMarkerColor: document.querySelector('[data-p7c3-proof-marker]')
        ? getComputedStyle(document.querySelector('[data-p7c3-proof-marker]')).backgroundColor
        : null
    })`)

    const fixtureTarget = await findTarget((target) => (
      target.type === 'page'
      && target.webSocketDebuggerUrl
      && target.url === fixture.url
    ), 8_000, 'P7c3 BrowserView fixture')
    const fixtureRuntime = await inspectFixtureTarget(fixtureTarget)
    const fixtureScreenshot = await tryCaptureTargetScreenshot(fixtureTarget, browserViewCdpShotPath)
    const browserViewSample = fixtureScreenshot.ok
      ? samplePng(browserViewCdpShotPath, { x: 40, y: 120 })
      : null
    const browserViewVisible = fixtureRuntime.url === fixture.url
      && fixtureRuntime.title === 'P7c3 BrowserView Fixture'
      && fixtureRuntime.bodyBackgroundColor === 'rgb(0, 255, 0)'
      && fixtureRuntime.activeElementId === 'ready-p7c3-focus'
    const screenCapture = tryCaptureScreen(compositedShotPath)

    const mainContentX = Number(probe.screen?.x || 0)
    const mainContentY = Number(probe.screen?.y || 0)
    const expectedOverlay = {
      x: mainContentX + Number(probe.frameBounds.left || 0) + Number(probe.frameBounds.width || 0) - Number(overlayMetrics.outerWidth || 0) - 12,
      y: mainContentY + Number(probe.frameBounds.top || 0) + 12,
      width: Number(overlayMetrics.outerWidth || 0),
      height: Number(overlayMetrics.outerHeight || 0),
    }
    const browserFrameScreenBounds = {
      x: mainContentX + Number(probe.frameBounds.left || 0),
      y: mainContentY + Number(probe.frameBounds.top || 0),
      width: Number(probe.frameBounds.width || 0),
      height: Number(probe.frameBounds.height || 0),
    }
    const overlayBounds = {
      x: Number(overlayMetrics.screenX || 0),
      y: Number(overlayMetrics.screenY || 0),
      width: Number(overlayMetrics.outerWidth || 0),
      height: Number(overlayMetrics.outerHeight || 0),
    }
    const overlayMatchesExpected = Math.abs(overlayBounds.x - expectedOverlay.x) <= 2
      && Math.abs(overlayBounds.y - expectedOverlay.y) <= 2
      && overlayBounds.width === expectedOverlay.width
      && overlayBounds.height === expectedOverlay.height
    const overlayWithinBrowserFrame = overlayBounds.x >= browserFrameScreenBounds.x
      && overlayBounds.y >= browserFrameScreenBounds.y
      && overlayBounds.x + overlayBounds.width <= browserFrameScreenBounds.x + browserFrameScreenBounds.width
      && overlayBounds.y + overlayBounds.height <= browserFrameScreenBounds.y + browserFrameScreenBounds.height
    const overlayRenders = Boolean(
      overlayMetrics.marker
      && overlayMetrics.proofMarkerRectContainsSample
      && /rgb\(255, 0, 255\)/.test(String(overlayMetrics.proofMarkerColor || '')),
    )

    const closeButtonClicked = await evaluate(overlayClient, `JSON.stringify((() => {
      const button = document.querySelector('button[aria-label="关闭 Agent 控制提示"]')
      if (!button) return false
      button.click()
      return true
    })())`)
    await wait(400)
    const overlayAfterClose = await evaluate(overlayClient, `JSON.stringify({
      visibilityState: document.visibilityState,
      rootPresent: Boolean(document.querySelector('[data-browser-lock-overlay-root]'))
    })`)
    const closeButtonDismissesOverlay = Boolean(closeButtonClicked && overlayAfterClose.visibilityState === 'hidden')

    const clickResult = await evaluate(mainClient, `(async () => {
      const click = await window.electronAPI.browser.p7cLiveProofAgentClick(140, 160)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const pointerSnapshot = await window.electronAPI.browser.getBrowserAgentPointerSnapshot()
      return JSON.stringify({ click, pointerSnapshot })
    })()`)
    const pointerTarget = await findTarget((target) => (
      target.type === 'page'
      && target.webSocketDebuggerUrl
      && typeof target.url === 'string'
      && /browser-agent-pointer/.test(target.url)
    ), 8_000, 'browser agent pointer')
    pointerClient = await connect(pointerTarget)
    const pointerMetrics = await evaluate(pointerClient, `JSON.stringify((() => {
      const root = document.querySelector('[data-browser-agent-pointer-root]')
      const ring = document.querySelector('[data-browser-agent-pointer-ring]')
      const ringRect = ring?.getBoundingClientRect()
      return {
        url: location.href,
        visibilityState: document.visibilityState,
        phase: root?.getAttribute('data-pointer-phase') || null,
        ringCenter: ringRect ? { x: ringRect.left + ringRect.width / 2, y: ringRect.top + ringRect.height / 2 } : null,
        screenX: window.screenX,
        screenY: window.screenY,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
      }
    })())`)
    const pointerSnapshot = clickResult.pointerSnapshot?.data
    const pointerBounds = {
      x: Number(pointerMetrics.screenX || 0),
      y: Number(pointerMetrics.screenY || 0),
      width: Number(pointerMetrics.outerWidth || 0),
      height: Number(pointerMetrics.outerHeight || 0),
    }
    const pointerMatchesTrustedInput = Boolean(
      clickResult.click?.success
      && clickResult.pointerSnapshot?.success
      && pointerSnapshot?.phase === 'release'
      && pointerMetrics.phase === 'release'
      && pointerMetrics.visibilityState === 'visible'
      && Math.abs(Number(pointerSnapshot?.x) - Number(clickResult.click?.x)) <= 1
      && Math.abs(Number(pointerSnapshot?.y) - Number(clickResult.click?.y)) <= 1
      && Math.abs(Number(pointerMetrics.ringCenter?.x) - Number(clickResult.click?.x)) <= 2
      && Math.abs(Number(pointerMetrics.ringCenter?.y) - Number(clickResult.click?.y)) <= 2
      && Math.abs(pointerBounds.x - browserFrameScreenBounds.x) <= 2
      && Math.abs(pointerBounds.y - browserFrameScreenBounds.y) <= 2
      && Math.abs(pointerBounds.width - browserFrameScreenBounds.width) <= 2
      && Math.abs(pointerBounds.height - browserFrameScreenBounds.height) <= 2
    )

    const hostHideResult = await evaluate(mainClient, `(async () => {
      const api = window.electronAPI.browser
      const hide = api.sendIntent({
        kind: 'hide',
        intentId: Date.now(),
        tabId: ${JSON.stringify(probe.created.tabId)},
        reason: 'mode-switch',
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const pointer = await api.getBrowserAgentPointerSnapshot()
      return JSON.stringify({ hide, pointer })
    })()`)
    const pointerAfterHostHide = await evaluate(pointerClient, `JSON.stringify({ visibilityState: document.visibilityState })`)
    const pointerClearsWhenHostHidden = Boolean(
      hostHideResult.hide?.success
      && hostHideResult.pointer?.success
      && hostHideResult.pointer.data === null
      && pointerAfterHostHide.visibilityState === 'hidden'
    )
    const restoreAndClickResult = await evaluate(mainClient, `(async () => {
      const api = window.electronAPI.browser
      const show = api.sendIntent({
        kind: 'show',
        intentId: Date.now(),
        tabId: ${JSON.stringify(probe.created.tabId)},
        bounds: ${JSON.stringify({
          x: probe.frameBounds.left,
          y: probe.frameBounds.top,
          w: probe.frameBounds.width,
          h: probe.frameBounds.height,
        })},
        reason: 'tab-activate',
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const click = await api.p7cLiveProofAgentClick(140, 160)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const pointer = await api.getBrowserAgentPointerSnapshot()
      return JSON.stringify({ show, click, pointer })
    })()`)
    const pointerReturnsAfterHostRestore = Boolean(
      restoreAndClickResult.show?.success
      && restoreAndClickResult.click?.success
      && restoreAndClickResult.pointer?.success
      && restoreAndClickResult.pointer.data?.phase === 'release'
    )

    const finishResult = await evaluate(mainClient, `(async () => JSON.stringify(
      await window.electronAPI.browser.p7cLiveProofFinishAgentAction('finish')
    ))()`)
    await wait(1_100)
    const terminalSnapshots = await evaluate(mainClient, `(async () => JSON.stringify({
      pointer: await window.electronAPI.browser.getBrowserAgentPointerSnapshot(),
      overlay: await window.electronAPI.browser.getBrowserLockOverlaySnapshot()
    }))()`)
    const terminalOverlayState = await evaluate(overlayClient, `JSON.stringify({ visibilityState: document.visibilityState })`)
    const terminalPointerState = await evaluate(pointerClient, `JSON.stringify({ visibilityState: document.visibilityState })`)
    const pointerClearsAfterTerminal = Boolean(
      finishResult?.success
      && terminalSnapshots.pointer?.success
      && terminalSnapshots.pointer.data === null
      && terminalPointerState.visibilityState === 'hidden'
      && terminalOverlayState.visibilityState === 'hidden'
    )

    const hideResult = await evaluate(mainClient, `(async () => {
      const hide = await window.electronAPI.browser.hideBrowserLockOverlay()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const snapshot = await window.electronAPI.browser.getBrowserLockOverlaySnapshot()
      return JSON.stringify({ hide, snapshot })
    })()`)
    await wait(500)
    const clears = Boolean(hideResult.hide?.success && hideResult.snapshot?.success && hideResult.snapshot.data === null)
    const activeTabPreserved = probe.activeBefore?.id === probe.activeAfter?.id
      && probe.activeBefore?.url === probe.activeAfter?.url

    report = {
      ok: Boolean(
        overlayRenders
        && overlayMatchesExpected
        && overlayWithinBrowserFrame
        && browserViewVisible
        && closeButtonDismissesOverlay
        && pointerMatchesTrustedInput
        && pointerClearsWhenHostHidden
        && pointerReturnsAfterHostRestore
        && pointerClearsAfterTerminal
        && clears
        && activeTabPreserved
      ),
      scope: 'P7c3-browserview-proof-native-lock-overlay',
      generatedAt: new Date().toISOString(),
      error: null,
      environment: {
        platform: process.platform,
        remoteDebuggingPort: port,
        rendererDevicePixelRatio: probe.devicePixelRatio,
        overlayDevicePixelRatio: overlayMetrics.devicePixelRatio,
        shellScreenCapture: screenCapture,
      },
      overlay: {
        mechanism: 'native-child-browser-window',
        visible: Boolean(overlayMetrics.marker),
        route: '/browser-lock-overlay',
        bounds: {
          x: overlayMetrics.screenX,
          y: overlayMetrics.screenY,
          width: overlayMetrics.outerWidth,
          height: overlayMetrics.outerHeight,
        },
        text: overlayMetrics.text,
      },
      pointer: {
        mechanism: 'click-through-native-child-window',
        route: '/browser-agent-pointer',
        bounds: pointerBounds,
        snapshot: pointerSnapshot,
      },
      browserViewFixture: {
        activeTabId: probe.created.tabId,
        fixtureUrl: fixture.url,
        frameBounds: probe.frameBounds,
        pageMarkerColor: PAGE_MARKER,
        overlayMarkerColor: OVERLAY_MARKER,
      },
      captures: {
        browserViewCdpPath: fixtureScreenshot.ok ? browserViewCdpShotPath : null,
        osCompositedAttemptPath: compositedShotPath,
      },
      assertions: {
        lockStateMatchesOverlay: {
          ok: Boolean(overlayMetrics.marker && /P7c3/.test(overlayMetrics.text || '')),
          kind: probe.snapshot.kind,
        },
        overlayWindowRendersProofMarker: {
          ok: overlayRenders,
          source: 'overlay-window-dom',
          proofMarkerRectContainsSample: overlayMetrics.proofMarkerRectContainsSample,
          proofMarkerColor: overlayMetrics.proofMarkerColor,
          expected: OVERLAY_MARKER,
        },
        nativeOverlayBoundsIntersectBrowserView: {
          ok: Boolean(overlayMatchesExpected && overlayWithinBrowserFrame),
          source: 'runtime-native-child-window-geometry',
          overlayBounds,
          expectedOverlay,
          browserFrameScreenBounds,
        },
        browserViewTargetRendersFixture: {
          ok: browserViewVisible,
          source: 'browser-webcontents-runtime-eval',
          runtime: fixtureRuntime,
          screenshot: fixtureScreenshot,
          browserViewSample,
          expected: PAGE_MARKER,
        },
        overlayClearsAfterUnlock: {
          ok: clears,
          source: 'browser-lock-overlay-snapshot',
          hideResult,
        },
        closeButtonDismissesOverlay: {
          ok: closeButtonDismissesOverlay,
          source: 'native-overlay-close-button',
          closeButtonClicked,
          after: overlayAfterClose,
        },
        pointerMatchesTrustedInput: {
          ok: pointerMatchesTrustedInput,
          source: 'trusted-cdp-input-and-native-pointer-geometry',
          clickResult,
          pointerMetrics,
          pointerBounds,
          browserFrameScreenBounds,
        },
        pointerClearsOnBrowserViewLifecycle: {
          ok: Boolean(pointerClearsWhenHostHidden && pointerReturnsAfterHostRestore),
          source: 'native-browserview-hide-show-lifecycle',
          hostHideResult,
          pointerAfterHostHide,
          restoreAndClickResult,
        },
        pointerClearsAfterTerminal: {
          ok: pointerClearsAfterTerminal,
          source: 'agent-action-terminal-lifecycle',
          finishResult,
          terminalSnapshots,
          terminalOverlayState,
          terminalPointerState,
        },
        activeTabPreserved: {
          ok: activeTabPreserved,
          before: probe.activeBefore,
          after: probe.activeAfter,
        },
        fullIsolationDeferred: {
          ok: true,
          separatePartitionImplemented: false,
        },
      },
    }
    if (!report.ok) {
      report.error = 'p7c3-native-lock-overlay-proof-failed'
    }
  } catch (error) {
    report = {
      ok: false,
      scope: 'P7c3-browserview-proof-native-lock-overlay',
      generatedAt: new Date().toISOString(),
      error: error instanceof Error ? (error.stack || error.message) : String(error),
      assertions: {},
    }
  } finally {
    if (mainClient) {
      await evaluate(mainClient, `(async () => JSON.stringify(
        await window.electronAPI?.browser?.p7cLiveProofFinishAgentAction?.('abort')
      ))()`).catch(() => undefined)
      await evaluate(mainClient, '(async () => JSON.stringify(await window.electronAPI?.browser?.hideBrowserLockOverlay?.()))()').catch(() => undefined)
      mainClient.ws.close()
    }
    overlayClient?.ws.close()
    pointerClient?.ws.close()
    await fixture.close()
  }

  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) {
    console.error(`[p7c3-lock-overlay] wrote failing report: ${outPath}`)
    console.error(`[p7c3-lock-overlay] ${report.error || 'unknown failure'}`)
    process.exit(1)
  }
  console.log(`[p7c3-lock-overlay] wrote ${outPath}`)
}

main().catch((error) => {
  console.error(`[p7c3-lock-overlay] ${error instanceof Error ? (error.stack || error.message) : String(error)}`)
  process.exit(1)
})
