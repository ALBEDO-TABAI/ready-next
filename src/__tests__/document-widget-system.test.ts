import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseShowWidgetFences } from '../renderer/components/document/widget-fence-parser'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import { buildWidgetReceiverSrcdoc, sanitizeWidgetHtml, widgetHtmlNeedsSandbox } from '../renderer/components/document/widget-sanitizer'
import { clampNumericInputValue } from '../renderer/components/document/widget-runtime-helpers'
import {
  getDocumentWidgetRenderBudget,
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

  it('keeps malformed widget fences as text so preview does not break', () => {
    const segments = parseShowWidgetFences([
      'before',
      '```show-widget',
      'NOT_JSON',
      '```',
      'after',
    ].join('\n'))

    assert.equal(segments.length, 3)
    assert.equal(segments[1]?.type, 'text')
    if (segments[1]?.type === 'text') {
      assert.match(segments[1].content, /```show-widget/)
    }
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
    assert.ok(sanitized.includes('<script>window.__ok = true;</script>'))
  })

  it('removes javascript URLs', () => {
    const sanitized = sanitizeWidgetHtml(`<a href="javascript:alert(1)">x</a>`)
    assert.ok(!sanitized.includes('javascript:'))
  })

  it('keeps local inline event handlers and still marks the widget for sandbox execution', () => {
    const sanitized = sanitizeWidgetHtml(`<svg onload="alert(1)"><rect onclick="alert(1)" /></svg>`)
    assert.ok(sanitized.includes('onload="alert(1)"'))
    assert.ok(sanitized.includes('onclick="alert(1)"'))
    assert.equal(widgetHtmlNeedsSandbox(sanitized), true)
  })

  it('keeps inline event handlers for scripted widgets so local interactions still work', () => {
    const sanitized = sanitizeWidgetHtml(`
<button onclick="switchTab(1)">切换</button>
<script>function switchTab(){ return 1 }</script>
`)
    assert.ok(sanitized.includes('onclick="switchTab(1)"'))
  })

  it('keeps inline event handlers for local interactive widgets even without script tags', () => {
    const sanitized = sanitizeWidgetHtml(`
<label>质量 <input type="number" value="80" oninput="recalc()" /></label>
<div onclick="recalc()">总分</div>
`)

    assert.ok(sanitized.includes('oninput="recalc()"'))
    assert.ok(sanitized.includes('onclick="recalc()"'))
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

    const budget = getDocumentWidgetRenderBudget(content)

    assert.equal(budget.widgetCount, 4)
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

  it('keeps widget runtime on the sandboxed iframe path instead of branching by needsSandbox', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/WidgetRenderer.tsx'),
      'utf8',
    )

    assert.match(source, /useLayoutEffect/)
    assert.match(source, /sandbox="allow-scripts"/)
    assert.doesNotMatch(source, /if\s*\(\s*!needsSandbox\s*\)/)
    assert.match(source, /srcDoc=\{srcDoc\}/)
    assert.doesNotMatch(source, /src=\{iframeBlobUrl/)
    assert.doesNotMatch(source, /onLoad=\{\(\) => setReceiverReady\(true\)\}/)
    assert.match(source, /stripWidgetScripts/)
    assert.doesNotMatch(source, /WidgetDomRuntime/)
    assert.match(source, /widgetNeedsManualPreview/)
    assert.match(source, /preferManualPreview/)
    assert.match(source, /启用预览/)
  })

  it('falls back to stripped static markup instead of executing widget scripts in the renderer document', () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/WidgetRenderer.tsx'),
      'utf8',
    )

    assert.match(rendererSource, /staticFallbackHtml/)
    assert.match(rendererSource, /dangerouslySetInnerHTML/)
    assert.match(rendererSource, /showSandboxFallback \|\| renderError/)
    assert.doesNotMatch(rendererSource, /WidgetDomRuntime/)
    assert.equal(
      existsSync(resolve(process.cwd(), 'src/renderer/components/document/WidgetDomRuntime.tsx')),
      false,
    )
  })

  it('does not describe non-script widgets as static html only', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/TiptapEditor.tsx'),
      'utf8',
    )

    assert.doesNotMatch(source, /静态 HTML/)
  })

  it('documents local inline interactivity in document widget guidance', () => {
    const directChatSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )
    const documentToolsSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/tools/document-tools.ts'),
      'utf8',
    )

    assert.match(directChatSource, /内联事件|oninput|onclick/)
    assert.match(directChatSource, /readyWidgetSendMessage|data-ready-agent-message/)
    assert.match(documentToolsSource, /HTML\/SVG\/本地交互脚本|HTML\/SVG\/脚本/)
  })

  it('does not keep an edit-mode placeholder that blocks scripted widget previews', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/DocumentWidgetBlockCard.tsx'),
      'utf8',
    )

    assert.doesNotMatch(source, /ScriptWidgetPreviewPlaceholder/)
    assert.doesNotMatch(source, /isScriptWidget/)
  })

  it('uses the external widget receiver bootstrap script so renderer CSP does not block widget startup', () => {
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
    assert.doesNotMatch(srcdoc, /data-widget-script-nonce=/)
    assert.match(srcdoc, /<script>\(function\(\)/)
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

  it('uses unified widget card header actions in edit and preview surfaces', () => {
    const blockCardSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/DocumentWidgetBlockCard.tsx'),
      'utf8',
    )
    const shellSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/DocumentWidgetCardShell.tsx'),
      'utf8',
    )
    const notePreviewSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/NotePreview.tsx'),
      'utf8',
    )
    const markdownEditorSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/document/MarkdownEditor.tsx'),
      'utf8',
    )

    assert.match(blockCardSource, /DocumentWidgetCardShell/)
    assert.match(shellSource, /label="引用"/)
    assert.match(shellSource, /label="导出"/)
    assert.doesNotMatch(blockCardSource, /modeLabel=\{modeLabel\}/)
    assert.doesNotMatch(blockCardSource, /hint=\{/)
    assert.match(notePreviewSource, /DocumentWidgetCardShell/)
    assert.match(markdownEditorSource, /handleWidgetQuoteToAgent/)
    assert.match(markdownEditorSource, /handleWidgetExport/)
  })
})
