import { resolveDocumentWidgetRenderCode } from '../shared/document-widget-render-code'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseShowWidgetFences } from '../renderer/components/document/widget-fence-parser'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import { buildWidgetReceiverSrcdoc, sanitizeWidgetHtml, widgetHtmlNeedsSandbox } from '../renderer/components/document/widget-sanitizer'
import { clampNumericInputValue } from '../renderer/components/document/widget-runtime-helpers'
import { buildDocumentWidgetFenceSource } from '../shared/document-widget-parse'
import {
  getDocumentWidgetRenderBudgetFromCodes,
  widgetNeedsManualPreview,
} from '../renderer/components/document/widget-card-helpers'

describe('document widget fence parsing', () => {
  it('parses a single widget fence into a widget segment', () => {
    const segments = parseShowWidgetFences([
      'before',
      '```show-widget',
      '{"title":"chart","widget_code":"<div>Chart</div>"}',
      '```',
      'after',
    ].join('\n'))

    assert.equal(segments.length, 3)
    assert.equal(segments[1]?.type, 'widget')
    if (segments[1]?.type === 'widget') {
      assert.equal(segments[1].data.title, 'chart')
      assert.equal(segments[1].data.widgetCode, '<div>Chart</div>')
    }
  })

  it('keeps malformed widget fences as an error block so preview does not expose source', () => {
    const segments = parseShowWidgetFences([
      'before',
      '```show-widget',
      'NOT_JSON',
      '```',
      'after',
    ].join('\n'))

    assert.equal(segments.length, 3)
    assert.equal(segments[1]?.type, 'invalid-widget')
    if (segments[1]?.type === 'invalid-widget') {
      assert.match(segments[1].reason, /JSON/)
    }
    const preview = buildStructuredNotePreview(segments.map((segment) => (
      segment.type === 'invalid-widget' ? segment.content : segment.type === 'text' ? segment.content : segment.data.rawFence
    )).join(''))
    assert.deepEqual(preview.blocks.map((block) => block.type), ['markdown', 'widget_error', 'markdown'])
  })

  it('adds widget blocks into structured note preview in order', () => {
    const preview = buildStructuredNotePreview([
      'Intro',
      '',
      '```show-widget',
      '{"title":"chart_1","widget_code":"<div>One</div>"}',
      '```',
      '',
      '## Section',
      '',
      '```show-widget',
      '{"title":"chart_2","widget_code":"<div>Two</div>"}',
      '```',
    ].join('\n'))

    assert.equal(preview.widgets.length, 2)
    assert.deepEqual(
      preview.blocks.map((block) => block.type),
      ['markdown', 'widget', 'markdown', 'widget'],
    )
  })
})

describe('document widget sanitizer', () => {
  it('strips dangerous embedding tags and non-whitelisted scripts', () => {
    const sanitized = sanitizeWidgetHtml(`
<div>safe</div>
<iframe src="https://evil.test"></iframe>
<script src="https://evil.test/evil.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>window.__ok = true;</script>
`)

    assert.ok(!sanitized.includes('<iframe'))
    assert.ok(!sanitized.includes('evil.js'))
    assert.ok(sanitized.includes('cdn.jsdelivr.net'))
    // W10c：内联脚本必须盖 CSP nonce（详见 widget-script-nonce.test.ts）
    assert.match(sanitized, /<script nonce="[^"]+">window\.__ok = true;<\/script>/)
  })

  it('removes javascript URLs', () => {
    const sanitized = sanitizeWidgetHtml(`<a href="javascript:alert(1)">x</a>`)
    assert.ok(!sanitized.includes('javascript:'))
  })

  it('rewrites supported inline handlers for the nonce-safe receiver and drops unsupported handlers', () => {
    const sanitized = sanitizeWidgetHtml(`<svg onload="alert(1)"><rect onclick="alert(1)" /></svg>`)
    assert.ok(!sanitized.includes('onload='))
    assert.ok(!sanitized.includes(' onclick='))
    assert.ok(sanitized.includes('data-ready-onclick="alert(1)"'))
    assert.equal(widgetHtmlNeedsSandbox(sanitized), true)
  })

  it('keeps inline event handlers for scripted widgets so local interactions still work', () => {
    const sanitized = sanitizeWidgetHtml(`
<button onclick="switchTab(1)">切换</button>
<script>function switchTab(){ return 1 }</script>
`)
    assert.ok(sanitized.includes('data-ready-onclick="switchTab(1)"'))
    assert.ok(!sanitized.includes(' onclick='))
  })

  it('rewrites markup handlers without corrupting JavaScript strings inside nonce scripts', () => {
    const sanitized = sanitizeWidgetHtml(`
<button onclick="switchTab(1)">切换</button>
<script>const template = '<button onclick="nested()">'; function switchTab(){ return template }</script>
`)
    assert.ok(sanitized.includes('data-ready-onclick="switchTab(1)"'))
    assert.ok(sanitized.includes(`const template = '<button onclick="nested()">'`))
    assert.ok(!sanitized.includes(`const template = '<button data-ready-onclick=`))
  })

  it('keeps inline event handlers for local interactive widgets even without script tags', () => {
    const sanitized = sanitizeWidgetHtml(`
<label>质量 <input type="number" value="80" oninput="recalc()" /></label>
<div onclick="recalc()">总分</div>
`)

    assert.ok(sanitized.includes('data-ready-oninput="recalc()"'))
    assert.ok(sanitized.includes('data-ready-onclick="recalc()"'))
  })
})

describe('document widget runtime helpers', () => {
  it('clamps numeric values into declared min and max bounds', () => {
    assert.equal(clampNumericInputValue('3211', '0', '100'), '100')
    assert.equal(clampNumericInputValue('-5', '0', '100'), '0')
    assert.equal(clampNumericInputValue('88', '0', '100'), '88')
  })

  it('keeps empty or non-numeric values untouched', () => {
    assert.equal(clampNumericInputValue('', '0', '100'), '')
    assert.equal(clampNumericInputValue('abc', '0', '100'), 'abc')
  })
})

describe('document widget renderer contract', () => {
  it('forces manual preview when a document contains too many widgets or too much widget code', () => {
    const content = [
      '```show-widget',
      '{"title":"w1","widget_code":"<div>one</div>"}',
      '```',
      '```show-widget',
      '{"title":"w2","widget_code":"<div>two</div>"}',
      '```',
      '```show-widget',
      '{"title":"w3","widget_code":"<div>three</div>"}',
      '```',
      '```show-widget',
      '{"title":"w4","widget_code":"<div>four</div>"}',
      '```',
    ].join('\n')

    const budget = getDocumentWidgetRenderBudgetFromCodes(buildStructuredNotePreview(content).widgets.map(widget => resolveDocumentWidgetRenderCode(widget).widgetCode))

    assert.equal(budget.widgetCount, 4)
    assert.equal(budget.forceManualPreviewAll, true)
  })

  it('budgets the structured runtime render instead of a stale short widget_code cache', () => {
    const content = buildDocumentWidgetFenceSource('large-current-card', '<div>old</div>', {
      componentSpec: {
        component: 'info_card',
        props: { body: '现'.repeat(13_000) },
      },
    })

    const budget = getDocumentWidgetRenderBudgetFromCodes(buildStructuredNotePreview(content).widgets.map(widget => resolveDocumentWidgetRenderCode(widget).widgetCode))

    assert.ok(budget.totalWidgetChars >= 12_000)
    assert.equal(budget.forceManualPreviewAll, true)
  })

  it('flags animation-heavy emoji-rich widgets for manual preview instead of auto-render', () => {
    const heavyWidget = `
<div style="animation: glow 2s ease-in-out infinite alternate;">
  <style>
    @keyframes glow {
      0% { opacity: 0.7; }
      100% { opacity: 1; }
    }
  </style>
  <div>🏀 篮球全明星狂欢夜 🎉 🔥 ⚡ 🏆</div>
</div>
`
    const simpleWidget = '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#eee" /></svg>'

    assert.equal(widgetNeedsManualPreview(heavyWidget), true)
    assert.equal(widgetNeedsManualPreview(simpleWidget), false)
  })

  // 渲染舞台（iframe 运行时 / 静态投影 / 休眠与启用）的行为合同已迁到真实挂载测试
  // document-widget-stage.test.tsx：沙箱 srcdoc、脚本与内联事件不进宿主、休眠态不挂 iframe。


  it('documents local inline interactivity in document widget guidance', () => {
    // 合同随实现同步（Phase C C4/C5，2026-07-05）：DirectChatEngine 退役，其内嵌
    // widget 指引随文件消亡。"允许本地内联事件"的 live 锚点 = 模型可见的工具
    // 描述面（document-tools.ts + schemas/document-schemas.ts）。
    // Phase 2.5 PR 7: widget tool descriptions moved from inline hand-rolled
    // params in document-tools.ts to zod schemas in schemas/document-schemas.ts.
    // Read both files so the guidance-string contract stays valid regardless
    // of which side holds the description.
    const documentToolsSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/tools/document-tools.ts'),
      'utf8',
    )
    const documentSchemasSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/tools/schemas/document-schemas.ts'),
      'utf8',
    )
    const widgetGuidanceSurface = `${documentToolsSource}\n${documentSchemasSource}`

    assert.match(widgetGuidanceSurface, /内联事件|oninput|onclick/)
    assert.match(widgetGuidanceSurface, /HTML\/SVG\/本地交互脚本|HTML\/SVG\/脚本/)
    // 缺位注记（随引擎退役摘除，Phase C C4）：模型侧"readyWidgetSendMessage /
    // data-ready-agent-message 消息桥"提示词在 SDK 路径暂无现役等价物（renderer
    // 运行时桥仍由下方 'bridges widget interactions back into the agent input
    // pipeline' 用例钉住）；待 SDK 侧 prompt 资产补齐后再恢复模型侧锚点。
  })


  it('declares a color-scheme matching the host theme so the transparent frame never paints an opaque canvas', () => {
    // 宿主 html[data-theme=dark] 声明 color-scheme: dark；iframe 文档若不声明一致的
    // color-scheme，Chromium 会给整个 frame 铺不透明底色，12px 圆角处露出白色弧边。
    const dark = buildWidgetReceiverSrcdoc(':root{}', true, '<div>demo</div>', 'tok')
    const light = buildWidgetReceiverSrcdoc(':root{}', false, '<div>demo</div>', 'tok')

    assert.match(dark, /<html class="dark" style="color-scheme:dark">/)
    assert.match(light, /<html class="" style="color-scheme:light dark">/)
    assert.match(dark, /document\.documentElement\.style\.colorScheme=event\.data\.isDark \? 'dark' : 'light dark'/)
  })

  it('stamps the CSP nonce on the widget receiver script so inherited CSP does not block widget startup', () => {
    // W10c（2026-07-11 dogfood）：CSP 的 script-src 同时声明 'unsafe-inline' 与 nonce——
    // 按规范 nonce 在场时 'unsafe-inline' 被忽略，裸内联接收器曾被静默拦截（widget:ready
    // 永不到达、交互预览恒降级）。修正后的合同：接收器内联但必须盖 nonce；nonce 与
    // index.html CSP 的逐字一致性由 widget-script-nonce.test.ts 单独钉住。
    const srcdoc = buildWidgetReceiverSrcdoc(':root{}', false, '<div>demo</div>', 'tok')
    const rendererHtml = readFileSync(
      resolve(process.cwd(), 'src/renderer/index.html'),
      'utf8',
    )

    assert.match(rendererHtml, /script-src 'self' 'unsafe-inline'/)
    assert.match(rendererHtml, /https:\/\/cdnjs\.cloudflare\.com/)
    assert.match(rendererHtml, /https:\/\/cdn\.jsdelivr\.net/)
    assert.match(rendererHtml, /https:\/\/unpkg\.com/)
    assert.match(rendererHtml, /https:\/\/esm\.sh/)
    assert.match(srcdoc, /<script nonce="[^"]+">\(function\(\)/)
    assert.match(srcdoc, /closest\('\[data-ready-onclick\]'\)/)
    assert.match(srcdoc, /invokeInlineHandler\(inlineClickNode, 'onclick', event\)/)
    assert.doesNotMatch(srcdoc, /<script>\(function\(\)/)
    assert.match(srcdoc, /data-widget-token="tok"/)
    assert.match(srcdoc, /<div id="__widget-root"><div class="widget-root"><div>demo<\/div><\/div><\/div>/)
    assert.doesNotMatch(srcdoc, /__widget-template/)
  })

  it('does not keep a persistent compatibility-mode notice in WidgetRenderer', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/WidgetRenderer.tsx'),
      'utf8',
    )

    assert.doesNotMatch(source, /已切换到兼容运行态/)
  })

  it('bridges widget interactions back into the agent input pipeline', () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/WidgetRenderer.tsx'),
      'utf8',
    )
    const receiverSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/widget-sanitizer.ts'),
      'utf8',
    )

    assert.match(rendererSource, /widget:message/)
    assert.match(receiverSource, /data-ready-agent-message/)
    assert.match(receiverSource, /__readyWidgetSendMessage/)
    assert.match(rendererSource, /widget:state/)
    assert.match(receiverSource, /widget:hydrate/)
  })

})
