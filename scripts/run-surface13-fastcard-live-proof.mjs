import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import pngjs from 'pngjs'

const port = Number(process.env.READY_REMOTE_DEBUGGING_PORT || 9333)
const outDir = resolve(process.argv[2] || 'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/evidence')
const reportPath = resolve(outDir, 'surface-13-fastcard-full-surface-stage-z-live-report.json')
const overlayShotPath = resolve(outDir, 'surface-13-fastcard-full-surface-stage-z-overlay.png')
const panelShotPath = resolve(outDir, 'surface-13-fastcard-full-surface-stage-z-live-panel.png')

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
    for (const entry of pending.values()) {
      entry.reject(error)
    }
    pending.clear()
  }
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message)
      pending.delete(message.id)
    }
  })
  ws.addEventListener('close', () => {
    rejectPending(new Error('CDP websocket closed before response'))
  })
  ws.addEventListener('error', () => {
    rejectPending(new Error('CDP websocket error before response'))
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id
    pending.set(callId, { resolve, reject })
    try {
      ws.send(JSON.stringify({ id: callId, method, params }))
    } catch (error) {
      pending.delete(callId)
      reject(error)
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
    300_000,
    'Runtime.evaluate',
  )
  if (result.result?.exceptionDetails) {
    const details = result.result.exceptionDetails
    const message = [
      details.text,
      details.exception?.description,
      details.exception?.value,
    ].filter(Boolean).join('\n')
    throw new Error(message || 'Runtime.evaluate failed')
  }
  const value = result.result?.result?.value
  return typeof value === 'string' ? JSON.parse(value) : value
}

async function waitForOverlayPayload(client, timeoutMs = 5000) {
  const startedAt = Date.now()
  let payload = null
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      payload = await evaluate(client, 'JSON.stringify({ text: document.body.innerText, url: location.href })')
      if (payload?.text?.includes('FastCard')) return payload
    } catch (error) {
      lastError = error
    }
    await wait(250)
  }
  if (!payload && lastError) {
    return { text: '', url: '', error: lastError instanceof Error ? lastError.message : String(lastError) }
  }
  return payload
}

function createVisualFixturePngDataUrl() {
  const { PNG } = pngjs
  const png = new PNG({ width: 32, height: 32 })
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4
      png.data[offset] = x < 16 ? 240 : 40
      png.data[offset + 1] = y < 16 ? 80 : 180
      png.data[offset + 2] = (x + y) % 2 === 0 ? 60 : 220
      png.data[offset + 3] = 255
    }
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`
}

const validPngDataUrl = createVisualFixturePngDataUrl()

const clipAgentFixtureHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Surface13 Clip Agent Fixture</title>
</head>
<body>
  <main>
    <h1>Surface13 Clip Agent Fixture</h1>
    <p>READY_SURFACE13_CLIP_AGENT_MARKER describes a creator workflow: collect a browser article, preserve source context, and ask the Ready agent to turn it into exactly three concise Chinese sentences.</p>
    <p>The proof should mention source context, three-sentence transformation, and that the content came from a clipped browser page.</p>
  </main>
</body>
</html>
`

function startFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === '/surface13-clip-agent.html' || request.url === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(clipAgentFixtureHtml)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('fixture server did not return a TCP address'))
        return
      }
      resolve({
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
        url: `http://127.0.0.1:${address.port}/surface13-clip-agent.html`,
      })
    })
  })
}

function buildClipAgentExpression(fixtureUrl) {
  return `(
    async () => {
      const api = window.electronAPI.browser
      const harness = window.__READY_AGENT_TEST__
      if (!harness?.submit) {
        return JSON.stringify({ ok: false, error: 'missing-agent-test-harness' })
      }

      const fixtureUrl = ${JSON.stringify(fixtureUrl)}
      const created = await api.createTab(fixtureUrl)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const tabs = await api.getTabs()
      const tabId = created.tabId || tabs.find((tab) => tab.url === fixtureUrl)?.id || tabs.find((tab) => tab.active)?.id
      if (tabId) await api.switchTab(tabId)
      await new Promise((resolve) => setTimeout(resolve, 800))
      const active = (await api.getTabs()).find((tab) => tab.active)
      const clip = await api.clipCurrentTab({
        output_subdir: 'surface-13-fastcard-clip-agent',
        flatten_path: true,
        force_render_with_placeholders: true,
      })

      let agent = null
      if (clip.ok && clip.savedPath) {
        harness.clearAttachments?.()
        const sessionSetup = await harness.createVisibleSession()
        let sessionFallback = null
        if (!sessionSetup.ok) {
          sessionFallback = await harness.newSession()
        }
        const prompt = [
          '请读取刚剪藏出来的附件文件，把 READY_SURFACE13_CLIP_AGENT_MARKER 这段剪藏内容总结成严格 3 句中文。',
          '三句里必须分别体现：来源上下文保留、三句转写、内容来自浏览器剪藏页面。',
          '不要只复述文件路径。',
        ].join('')
        const result = await harness.submit(prompt, {
          mode: 'dom',
          allowStoreFallback: false,
          timeoutMs: 180000,
          pollMs: 1000,
          attachments: [{
            path: clip.savedPath,
            name: 'Surface13 Clip Agent Fixture.md',
            type: 'text',
          }],
        })
        const snapshot = await harness.snapshot()
        const agentMessage = [...snapshot.messages].reverse().find((message) => message.type === 'agent')
        agent = {
          ok: result.ok,
          sessionSetup,
          sessionFallback: sessionFallback
            ? {
                currentScopeId: sessionFallback.currentScopeId,
                currentScopeTitle: sessionFallback.currentScopeTitle,
                messageCount: sessionFallback.messages.length,
              }
            : null,
          inputMode: result.inputMode,
          diagnostics: result.diagnostics.map((diagnostic) => ({
            id: diagnostic.id,
            severity: diagnostic.severity,
            message: diagnostic.message,
            evidence: diagnostic.evidence,
          })),
          observedToolNames: result.after.toolTrace
            .filter((item) => item.kind === 'call')
            .map((item) => item.text),
          text: String(agentMessage?.content || ''),
          taskCards: snapshot.taskCards.map((card) => ({
            title: card.title,
            phase: card.phase,
            status: card.status,
            visualState: card.visualState,
            error: card.error,
          })),
          composer: snapshot.composer,
        }
      }

      return JSON.stringify({ ok: Boolean(clip.ok && agent?.ok), fixtureUrl, created, active, clip, agent })
    }
  )()`
}

const runProbeExpression = `(
  async () => {
    const api = window.electronAPI.browser
    const source = {
      pageUrl: 'https://example.com/fastcard-fixture',
      pageTitle: 'FastCard fixture',
      domain: 'example.com',
      tabId: 'stage-z',
      capturedAt: Date.now(),
    }

    const translation = await api.translateFastCardSelection({
      text: 'Ready helps creators collect context and turn it into useful cards.',
      targetLanguage: 'zh-CN',
      source,
    })
    let image = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      image = await api.describeFastCardImage({
        imageUrl: ${JSON.stringify(validPngDataUrl)},
        source: { ...source, pageTitle: 'Valid PNG probe' },
      })
      if (image?.success && image.data?.description) break
      await new Promise((resolve) => setTimeout(resolve, 750))
    }
    const video = await api.resolveFastCardVideo({
      target: {
        kind: 'video',
        pageUrl: 'https://example.com/video',
        pageTitle: 'Video fixture',
        domain: 'example.com',
        tabId: 'stage-z',
        capturedAt: Date.now(),
        videoUrl: 'https://cdn.example.com/fastcard-demo.mp4',
        posterUrl: 'https://cdn.example.com/fastcard-demo.jpg',
        title: 'FastCard demo video',
      },
    })

    const items = [
      {
        id: 'translation-live',
        kind: 'translation',
        createdAt: Date.now(),
        originalText: translation.data?.originalText || '',
        translatedText: translation.data?.translatedText || '',
        targetLanguage: translation.data?.targetLanguage || 'zh-CN',
        source,
        tags: ['fastcard', 'translation', 'source-example.com'],
      },
      {
        id: 'image-live',
        kind: 'image-description',
        createdAt: Date.now(),
        imageUrl: image.data?.imageUrl || '',
        description: image.data?.description || '',
        title: '图片描述',
        source,
        tags: ['fastcard', 'image-description', 'source-example.com'],
      },
      {
        id: 'video-live',
        kind: 'video',
        createdAt: Date.now(),
        title: video.data?.video?.title || 'FastCard demo video',
        source,
        video: video.data?.video,
        tags: ['fastcard', 'video-reference', 'source-example.com'],
      },
    ]

    const element = document.querySelector('.browser-shell-corner-fill-left')?.parentElement
      || document.querySelector('.relative.min-h-0.min-w-0.flex-1.overflow-hidden')
    const rect = element.getBoundingClientRect()
    const snapshot = {
      mode: 'fastcard',
      items,
      resultPanel: null,
      bounds: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    }

    window.__surface13OverlayCommand = null
    const cleanup = api.onFastCardOverlayCommand((command) => {
      window.__surface13OverlayCommand = command
      cleanup?.()
    })
    const shown = await api.showFastCardOverlay(snapshot)
    return JSON.stringify({ translation, image, video, shown, itemKinds: items.map((item) => item.kind), bounds: snapshot.bounds })
  }
)()`

const fixtureServer = await startFixtureServer()
let report
try {
  const targets = await listTargets()
  const mainTarget = targets.find((target) => (
    target.type === 'page'
    && /localhost:5173/.test(target.url)
    && !/browser-fastcard-overlay/.test(target.url)
  ))
  if (!mainTarget) throw new Error('Ready workbench target not found')

  const mainClient = await connect(mainTarget)
  try {
    report = await evaluate(mainClient, runProbeExpression)
  } finally {
    mainClient.ws.close()
  }

  await wait(500)
  const overlayTarget = (await listTargets()).find((target) => (
    target.type === 'page'
    && /browser-fastcard-overlay/.test(target.url)
  ))
  if (!overlayTarget) throw new Error('FastCard overlay target not found')

  const overlayClient = await connect(overlayTarget)
  try {
    report.overlayText = await waitForOverlayPayload(overlayClient)
    await overlayClient.send('Page.reload', { ignoreCache: true })
    await wait(300)
    report.overlayReloadText = await waitForOverlayPayload(overlayClient)
    const shot = await overlayClient.send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) {
      mkdirSync(dirname(overlayShotPath), { recursive: true })
      writeFileSync(overlayShotPath, Buffer.from(shot.result.data, 'base64'))
      report.overlayScreenshotPath = overlayShotPath
    }
    await evaluate(overlayClient, 'JSON.stringify(window.electronAPI.browser.sendFastCardOverlayCommand({ type: "remove-item", id: "translation-live" }))')
  } finally {
    overlayClient.ws.close()
  }

  await wait(300)
  const commandClient = await connect(mainTarget)
  try {
    report.overlayCommand = await evaluate(commandClient, 'JSON.stringify(window.__surface13OverlayCommand || null)')
    report.browserStillVisibleText = await evaluate(commandClient, 'JSON.stringify(document.body.innerText.includes("Example Domain"))')
    await evaluate(commandClient, 'JSON.stringify(window.electronAPI.browser.hideFastCardOverlay())')
    report.clipAgent = await evaluate(commandClient, buildClipAgentExpression(fixtureServer.url))
    const panelShot = await commandClient.send('Page.captureScreenshot', { format: 'png' })
    if (panelShot.result?.data) {
      mkdirSync(dirname(panelShotPath), { recursive: true })
      writeFileSync(panelShotPath, Buffer.from(panelShot.result.data, 'base64'))
      report.panelScreenshotPath = panelShotPath
    }
  } finally {
    commandClient.ws.close()
  }

  report.browserTargetAfterClipAgent = (await listTargets()).some((target) => (
    target.type === 'page'
    && target.url === report.clipAgent?.fixtureUrl
    && /Surface13 Clip Agent Fixture/.test(target.title || '')
  ))

  const agentText = report.clipAgent?.agent?.text || ''
  const observedToolNames = report.clipAgent?.agent?.observedToolNames || []
  report.ok = Boolean(
    report.translation?.success
    && report.image?.success
    && report.video?.success
    && report.shown?.success
    && report.overlayText?.text?.includes('图片描述')
    && report.overlayText?.text?.includes('FastCard demo video')
    && report.overlayReloadText?.text?.includes('图片描述')
    && report.overlayReloadText?.text?.includes('FastCard demo video')
    && report.overlayCommand?.type === 'remove-item'
    && report.browserStillVisibleText
    && report.clipAgent?.clip?.ok
    && report.clipAgent?.agent?.ok
    && (
      observedToolNames.some((name) => /file_read_excerpt/.test(name))
      || /(READY_SURFACE13_CLIP_AGENT_MARKER|Surface13 Clip Agent|creator 工作流|创作者工作流|本地测试页面)/.test(agentText)
    )
    && /(来源上下文|原始上下文|来源信息)/.test(agentText)
    && /(三句|三条)/.test(agentText)
    && /浏览器.*剪藏/.test(agentText)
    && report.browserTargetAfterClipAgent
  )
  report.capturedAt = new Date().toISOString()

  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({
    ok: report.ok,
    reportPath,
    overlayScreenshotPath: report.overlayScreenshotPath,
    panelScreenshotPath: report.panelScreenshotPath,
    itemKinds: report.itemKinds,
    overlayCommand: report.overlayCommand,
    browserStillVisibleText: report.browserStillVisibleText,
    clipOk: report.clipAgent?.clip?.ok,
    agentOk: report.clipAgent?.agent?.ok,
    browserTargetAfterClipAgent: report.browserTargetAfterClipAgent,
  }, null, 2))
} finally {
  await fixtureServer.close()
}

process.exit(report?.ok ? 0 : 1)
