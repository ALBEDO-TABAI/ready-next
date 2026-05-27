#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_OUT_DIR = 'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/evidence'
const DEFAULT_FIXTURE_PATH = '/private/tmp/ready-stage-z-surface05-agent-widget.md'

const options = parseArgs(process.argv.slice(2))
const outDir = resolve(options.outDir || DEFAULT_OUT_DIR)
const fixturePath = options.fixturePath || DEFAULT_FIXTURE_PATH
mkdirSync(outDir, { recursive: true })
writeFileSync(fixturePath, [
  '# Surface 05 Agent Widget Fixture',
  '',
  'Ready 是一个集成式创作工作台，当前验收需要确认 agent 能读取当前文档并写入 show-widget 信息卡。',
  '验收重点：不能只输出普通文字，必须在当前文档中留下可预览的信息卡。',
  '',
].join('\n'))

const target = await findReadyTarget(options.port)
const client = await connectCdp(target.webSocketDebuggerUrl)

try {
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await enableHarness(client)
  await waitForHarness(client)
  const report = await evaluate(client, buildPageRunnerSource({ fixturePath }))
  report.target = { title: target.title, url: target.url }
  report.fixturePath = fixturePath
  report.outDir = outDir

  const reportPath = resolve(outDir, 'surface-05-document-widgets-stage-z-agent-report.json')
  const screenshotPath = resolve(outDir, 'surface-05-document-widgets-stage-z-agent-after.png')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
  })
  if (screenshot.result?.data) {
    mkdirSync(dirname(screenshotPath), { recursive: true })
    writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
  }

  console.log(JSON.stringify({
    ok: report.ok,
    reportPath,
    screenshotPath,
    inputMode: report.inputMode,
    observedToolNames: report.observedToolNames,
    widgetCount: report.widgetCount,
    diagnostics: report.diagnostics.map((item) => item.id),
  }, null, 2))
  process.exit(report.ok ? 0 : 1)
} finally {
  client.close()
}

function parseArgs(argv) {
  const parsed = {
    port: 9333,
    outDir: DEFAULT_OUT_DIR,
    fixturePath: DEFAULT_FIXTURE_PATH,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') {
      parsed.port = Number(argv[++index] || parsed.port)
    } else if (arg === '--out-dir') {
      parsed.outDir = argv[++index] || parsed.outDir
    } else if (arg === '--fixture-path') {
      parsed.fixturePath = argv[++index] || parsed.fixturePath
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

async function findReadyTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((item) => {
    const url = String(item.url || '')
    return item.type === 'page'
      && (
        /^http:\/\/localhost:\d+\//.test(url)
        || /^http:\/\/127\.0\.0\.1:\d+\//.test(url)
      )
  })
  if (!target?.webSocketDebuggerUrl) throw new Error('Ready renderer target not found.')
  return target
}

async function connectCdp(url) {
  const ws = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  return {
    send(method, params = {}) {
      return new Promise((resolveSend) => {
        const id = ++nextId
        pending.set(id, resolveSend)
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      ws.close()
    },
  }
}

async function enableHarness(client) {
  await evaluate(client, [
    'localStorage.setItem("ready.agentPanelTest", "1")',
    'localStorage.setItem("ready:agent:test", "1")',
    'try { window.__READY_AGENT_TEST__?.dispose?.() } catch (_) {}',
    'location.reload()',
    'true',
  ].join(';'))
}

async function waitForHarness(client) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    const ready = await evaluate(client, 'Boolean(window.__READY_AGENT_TEST__?.submit)')
    if (ready === true) return
    await delay(250)
  }
  throw new Error('Agent panel test harness did not become available.')
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.error) throw new Error(response.error.message || 'Runtime.evaluate failed.')
  if (response.result?.exceptionDetails) {
    const exception = response.result.exceptionDetails.exception || {}
    throw new Error(exception.description || response.result.exceptionDetails.text || 'Runtime.evaluate failed.')
  }
  return response.result?.result?.value
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function buildPageRunnerSource(input) {
  const root = process.cwd().replace(/\\/g, '/')
  return `(${pageRunner.toString()})(${JSON.stringify({
    ...input,
    parserPath: `/@fs/${root}/src/shared/document-widget-parse.ts`,
  })})`
}

async function pageRunner(input) {
  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
  const mode = await import('/stores/useMode.ts')
  const doc = await import('/stores/useDocTabs.ts')
  const parser = await import(input.parserPath)
  const harness = window.__READY_AGENT_TEST__
  if (!harness) throw new Error('missing __READY_AGENT_TEST__')

  const seed = [
    '# Surface 05 Agent Widget Fixture',
    '',
    'Ready 是一个集成式创作工作台，当前验收需要确认 agent 能读取当前文档并写入 show-widget 信息卡。',
    '验收重点：不能只输出普通文字，必须在当前文档中留下可预览的信息卡。',
    '',
  ].join('\n')
  mode.useMode.setState({ appMode: 'workbench', workbenchMode: 'document', splitMode: null })
  doc.useDocTabs.setState({
    tabs: [{
      id: 'surface05-agent-widget',
      path: input.fixturePath,
      title: 'surface05-agent-widget.md',
      content: seed,
      isDirty: false,
    }],
    activeTabId: 'surface05-agent-widget',
    splitTabId: null,
  })
  await delay(800)
  await harness.newSession()
  await harness.waitForIdle?.({ timeoutMs: 30_000, pollMs: 100 })
  harness.clearEvents()

  const submit = await harness.submit(
    '请根据当前文档生成一张摘要信息卡，直接写入当前文档末尾。必须使用 show-widget 信息卡，不要只回复普通文字。',
    {
      mode: 'dom',
      timeoutMs: 360000,
      expectedToolNames: ['document_insert_widget'],
      forbiddenToolNames: ['web_search', 'map_plan_route'],
      allowStoreFallback: true,
    },
  )
  const active = doc.useDocTabs.getState().tabs.find((tab) => tab.id === doc.useDocTabs.getState().activeTabId)
  const widgets = active ? parser.collectDocumentWidgets(active.content) : []
  const observedToolNames = Array.from(new Set(submit.after.toolTrace
    .filter((item) => item.kind === 'call')
    .map((item) => {
      const match = String(item.text || '').trim().match(/^([a-zA-Z0-9_:-]+)\s*(?:\(|:)/)
      return match?.[1] || null
    })
    .filter(Boolean)))
  const diagnostics = [...submit.diagnostics]
  if (!active?.content.includes('```show-widget')) {
    diagnostics.push({
      id: 'show_widget_missing_from_document',
      severity: 'error',
      layer: 'document',
      message: 'Agent 运行结束后，当前文档没有 show-widget fence。',
      evidence: { contentPreview: active?.content?.slice(0, 1200) || '' },
    })
  }
  if (widgets.length === 0) {
    diagnostics.push({
      id: 'document_widget_parse_empty',
      severity: 'error',
      layer: 'document',
      message: '当前文档无法解析出 widget。',
      evidence: { contentPreview: active?.content?.slice(0, 1200) || '' },
    })
  }

  const previewButton = document.querySelector('.draggable-mode-switch__label--preview')
  if (previewButton instanceof HTMLElement) previewButton.click()
  await delay(1500)
  const enablePreview = document.querySelector('.ready-doc-widget-card-action')
  if (enablePreview instanceof HTMLElement && /启用预览/.test(enablePreview.textContent || '')) {
    enablePreview.click()
    await delay(1200)
  }

  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    inputMode: submit.inputMode,
    observedToolNames,
    diagnostics,
    widgetCount: widgets.length,
    widgetTitles: widgets.map((widget) => widget.title),
    assistantMessages: submit.after.messages
      .filter((message) => message.type !== 'user' && message.type !== 'ask_user_questions')
      .map((message) => String(message.content || '').slice(0, 1200)),
    activeTab: active ? {
      id: active.id,
      path: active.path,
      title: active.title,
      isDirty: active.isDirty,
      contentPreview: active.content.slice(0, 2000),
    } : null,
    after: {
      composer: submit.after.composer,
      runtime: submit.after.runtime,
      taskCards: submit.after.taskCards,
    },
    events: harness.events(),
  }
}
