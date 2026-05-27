#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_OUT_DIR = 'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/evidence'

const options = parseArgs(process.argv.slice(2))
const outDir = resolve(options.outDir || DEFAULT_OUT_DIR)
mkdirSync(outDir, { recursive: true })

const target = await findReadyTarget(options.port)
const client = await connectCdp(target.webSocketDebuggerUrl)

try {
  await client.send('Runtime.enable')
  await client.send('Page.enable')

  const report = await evaluate(client, buildPageRunnerSource())
  report.target = { title: target.title, url: target.url }
  report.outDir = outDir

  const reportPath = resolve(outDir, 'surface-05-document-widgets-stage-z-live-report.json')
  const screenshotPath = resolve(outDir, 'surface-05-document-widgets-stage-z-preview.png')
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
    widgetShellCount: report.widgetShellCount,
    widgetFrameCount: report.widgetFrameCount,
    missingSkeletons: report.missingSkeletons,
    renderErrorCount: report.renderErrorCount,
    titles: report.titles,
  }, null, 2))
  process.exit(report.ok ? 0 : 1)
} finally {
  client.close()
}

function parseArgs(argv) {
  const parsed = {
    port: 9333,
    outDir: DEFAULT_OUT_DIR,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') {
      parsed.port = Number(argv[++index] || parsed.port)
    } else if (arg === '--out-dir') {
      parsed.outDir = argv[++index] || parsed.outDir
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

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.error) {
    throw new Error(response.error.message || 'Runtime.evaluate failed.')
  }
  if (response.result?.exceptionDetails) {
    const exception = response.result.exceptionDetails.exception || {}
    throw new Error(exception.description || response.result.exceptionDetails.text || 'Runtime.evaluate failed.')
  }
  const raw = response.result?.result?.value
  if (typeof raw !== 'string') throw new Error('Live proof did not return a JSON report.')
  return JSON.parse(raw)
}

function buildPageRunnerSource() {
  const root = process.cwd().replace(/\\/g, '/')
  const skeletonsPath = `/@fs/${root}/src/shared/document-widget-skeletons.ts`
  const parserPath = `/@fs/${root}/src/shared/document-widget-parse.ts`
  return `(${pageRunner.toString()})(${JSON.stringify({ skeletonsPath, parserPath })})`
}

async function pageRunner(input) {
  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
  try {
    const mode = await import('/stores/useMode.ts')
    const doc = await import('/stores/useDocTabs.ts')
    const skeletons = await import(input.skeletonsPath)
    const parser = await import(input.parserPath)
    const fixtures = [
      ['A 摘要卡 single_focus', {
        skeleton: 'single_focus',
        props: {
          title: 'A 摘要卡',
          body: '把当前材料压缩成一张可扫描的信息卡，保留判断、结论和下一步。',
          attribution: 'Ready Surface 05',
        },
      }],
      ['B 对比卡 dual_compare', {
        skeleton: 'dual_compare',
        props: {
          title: 'B 对比卡',
          left: { heading: '方案 A', items: ['上手快', '适合短任务'] },
          right: { heading: '方案 B', items: ['结构稳', '适合长任务'] },
        },
      }],
      ['C 指标卡 metric_grid', {
        skeleton: 'metric_grid',
        props: {
          title: 'C 指标卡',
          period: 'Stage Z',
          metrics: [
            { label: '渲染项', value: '9' },
            { label: '错误', value: '0' },
          ],
        },
      }],
      ['D 时间线 vertical_timeline', {
        skeleton: 'vertical_timeline',
        props: {
          title: 'D 时间线',
          axis_label: '验收路径',
          events: [
            { time: '1', heading: '生成卡片', status: 'done' },
            { time: '2', heading: '切到预览', status: 'active' },
            { time: '3', heading: '截图留证', status: 'pending' },
          ],
        },
      }],
      ['E 图片说明 photo_note', {
        skeleton: 'photo_note',
        props: {
          title: 'E 图片说明',
          body: '图片说明型组件以视觉占位和说明文字共同出现。',
          hero: { type: 'emoji_block', emoji: '图', aspect: '4/3' },
          tags: ['image-caption', 'fixture'],
        },
      }],
      ['F 图表 chart_focus', {
        skeleton: 'chart_focus',
        props: {
          title: 'F 图表',
          chart: {
            type: 'bar',
            data: [
              { label: 'A', value: 3 },
              { label: 'B', value: 5 },
              { label: 'C', value: 4 },
            ],
          },
          insight: '图表组件可在文档预览中正常渲染。',
        },
      }],
      ['G 清单 grid_collection', {
        skeleton: 'grid_collection',
        props: {
          title: 'G 清单',
          cols: 3,
          item_shape: 'square',
          items: [
            { label: '摘要' },
            { label: '待办' },
            { label: '引用' },
            { label: '表格' },
            { label: '代码' },
            { label: '图表' },
          ],
        },
      }],
      ['H1 精确触发 freeform_static', {
        skeleton: 'freeform_static',
        props: {
          widget_code: '<div class="widget-canvas" data-widget-skeleton="freeform_static" style="padding:20px;border-radius:16px;background:#111827;color:white;font-size:24px;font-weight:700;">把这段写成醒目的标题卡</div>',
          aspect_ratio: '4:5',
        },
      }],
      ['H2 交互 freeform_interactive', {
        skeleton: 'freeform_interactive',
        props: {
          widget_code: '<div class="widget-canvas" data-widget-skeleton="freeform_interactive" style="padding:18px;border-radius:16px;background:#ecfeff;color:#0e7490;"><button>交互控件</button><div>静态回退可见</div></div><script>window.__widgetRender=function(){}</script>',
          aspect_ratio: '1:1',
          supports_animation: true,
        },
      }],
    ]
    const fences = fixtures.map(([title, spec]) => {
      const compiled = skeletons.compileWidgetSkeletonSpec(spec)
      return parser.buildDocumentWidgetFenceSource(title, compiled.widgetCode, { skeletonSpec: spec })
    })
    const content = [
      '# Surface 05 文档 Widget 现场验收',
      '这份临时文档用于验证 show-widget 在 Ready 文档预览里的真实渲染路径。',
      ...fences,
    ].join('\n\n')
    mode.useMode.setState({ appMode: 'workbench', workbenchMode: 'document', splitMode: null })
    doc.useDocTabs.setState({
      tabs: [{
        id: 'surface05-stage-z-live',
        path: null,
        title: 'surface-05-widgets-stage-z.md',
        content,
        isDirty: false,
      }],
      activeTabId: 'surface05-stage-z-live',
      splitTabId: null,
    })
    await delay(1000)
    const previewButton = document.querySelector('.draggable-mode-switch__label--preview')
    if (previewButton instanceof HTMLElement) previewButton.click()
    await delay(2500)
    for (const button of Array.from(document.querySelectorAll('.ready-doc-widget-card-action'))) {
      if (!(button instanceof HTMLElement)) continue
      if (!/启用预览/.test(button.textContent || '')) continue
      button.click()
      await delay(120)
    }
    await delay(2500)

    const surface = document.querySelector('.document-preview-surface')
    const shells = Array.from(document.querySelectorAll('.document-widget-shell'))
    const frames = Array.from(document.querySelectorAll('.document-widget-frame'))
    const titles = Array.from(document.querySelectorAll('.document-widget-title'))
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
    const srcDocs = frames.map((frame) => frame.getAttribute('srcdoc') || '')
    const skeletonMarkers = srcDocs
      .map((src) => {
        const match = src.match(/data-widget-skeleton="([^"]+)"/)
        return match ? match[1] : null
      })
      .filter(Boolean)
    const fallbackCount = document.querySelectorAll('.document-widget-fallback-shell').length
    const renderErrorCount = document.querySelectorAll('.document-widget-error,[data-ready-widget-error="true"]').length
    const expectedSkeletons = fixtures.map(([, spec]) => spec.skeleton)
    const missingSkeletons = expectedSkeletons.filter((item) => !skeletonMarkers.includes(item))
    const report = {
      capturedAt: new Date().toISOString(),
      previewVisible: Boolean(surface),
      widgetShellCount: shells.length,
      widgetFrameCount: frames.length,
      titles,
      skeletonMarkers,
      expectedSkeletons,
      missingSkeletons,
      fallbackCount,
      renderErrorCount,
      previewButtonFound: Boolean(previewButton),
      activeTab: doc.useDocTabs.getState().tabs.find((tab) => tab.id === doc.useDocTabs.getState().activeTabId),
      surfaceText: (surface?.textContent || '').slice(0, 1200),
    }
    return JSON.stringify({
      ...report,
      ok: report.previewVisible
        && report.widgetShellCount === fixtures.length
        && report.widgetFrameCount === fixtures.length
        && report.renderErrorCount === 0
        && report.missingSkeletons.length === 0,
    })
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    })
  }
}
