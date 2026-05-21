import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { buildRequestEnvelope } from '../../main/modules/agent-control/contracts/request-envelope'
import { collectDocumentWidgets } from '../../shared/document-widget-parse'
import { performDocAction } from '../../renderer/modules/agent/documentActions'
import { useDocTabs } from '../../renderer/stores/useDocTabs'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-pipeline/document-task-pipeline-executor.ts',
)

const USER_TEXT_WITH_WIDGET_BLOCK = [
  '帮我把指引卡片的基调改成 warning。',
  '',
  '### Widget 更新上下文',
  '- 目标 widget: 指引',
  '- 路径: /notes/guide.md',
  '- 标签页ID: tab-guide',
  '- widgetId: widget_guide_fixed',
].join('\n')

const USER_TEXT_WITHOUT_WIDGET_ID = [
  '帮我把指引卡片的基调改成 warning。',
  '',
  '### Widget 更新上下文',
  '- 目标 widget: 指引',
  '- 路径: /notes/guide.md',
  '- 标签页ID: tab-guide',
].join('\n')

function buildFixtureAContent(): string {
  return [
    '# 指引',
    '',
    '```show-widget',
    JSON.stringify({
      id: 'widget_guide_fixed',
      title: '指引',
      widget_code: '<div class="p-4"><h3>heading</h3><p>body</p></div>',
      component_spec: {
        component: 'info_card',
        props: { heading: 'heading', body: 'body', tone: 'neutral' },
      },
    }),
    '```',
    '',
  ].join('\n')
}

function buildFixtureBContent(): string {
  return [
    '# 周报',
    '',
    '```show-widget',
    JSON.stringify({
      title: '本周进展',
      widget_code: '<div class="p-4"><h3>进度</h3><p>稳步推进</p></div>',
      component_spec: {
        component: 'info_card',
        props: { heading: '进度', body: '稳步推进', tone: 'info' },
      },
    }),
    '```',
    '',
  ].join('\n')
}

describe('P-5 · envelope 解析 widget_target', () => {
  it('从 "### Widget 更新上下文" 块中抽取 widgetId / 名称 / 路径 / tabId', () => {
    const envelope = buildRequestEnvelope({ userText: USER_TEXT_WITH_WIDGET_BLOCK })
    const resource = envelope.resources.find((item) => item.kind === 'widget_target')
    assert.ok(resource, 'envelope 必须包含 widget_target 资源')
    assert.equal(resource!.widgetId, 'widget_guide_fixed')
    assert.equal(resource!.name, '指引')
    assert.equal(resource!.tabId, 'tab-guide')
    assert.equal(resource!.path, '/notes/guide.md')
    assert.equal(envelope.environmentHints.hasWidgetTargetContext, true)
  })

  it('缺失 widgetId 字段时字段为 null（兼容旧 MarkdownEditor 提交）', () => {
    const envelope = buildRequestEnvelope({ userText: USER_TEXT_WITHOUT_WIDGET_ID })
    const resource = envelope.resources.find((item) => item.kind === 'widget_target')
    assert.ok(resource, '旧版本仍应解析出 widget_target 资源')
    assert.equal(resource!.widgetId, null)
    assert.equal(resource!.name, '指引')
  })
})

describe('P-5 · pipeline executor 静态契约', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('从 envelope.resources 中按 kind === "widget_target" 抓取 envelopeWidgetTarget', () => {
    assert.match(
      source,
      /envelopeWidgetTarget\s*=\s*[^\n]*resources\.find\(\s*\(resource\)\s*=>\s*resource\.kind\s*===\s*'widget_target'[\s\S]*?\)/,
    )
  })

  it('buildWidgetDraft 在 draft 未带 targetWidgetId 时从 envelope.widgetId 回填', () => {
    assert.match(
      source,
      /if \(!built\.draft\.targetWidgetId && envelopeWidgetTarget\?\.widgetId\) \{\s*built\.draft\.targetWidgetId = envelopeWidgetTarget\.widgetId\s*\}/,
    )
  })

  it('writeDocumentWidget update 分支优先按 targetWidgetId 合成 target', () => {
    assert.match(
      source,
      /if \(stage === 'update'\) \{\s*const target = String\(params\.draft\.targetWidgetId \|\| params\.draft\.targetWidgetTitle \|\| ''\)\.trim\(\)/,
    )
  })

  it('writeDocumentWidget update 下发的 document.updateWidget 载荷包含 target + componentSpecPatch', () => {
    assert.match(
      source,
      /tool\('document\.updateWidget',\s*\{\s*target,[\s\S]*?componentSpecPatch: params\.draft\.componentSpecPatch,/,
    )
  })
})

describe('P-5 · envelope widgetId → renderer patch 命中', () => {
  it('envelope 解析出的 widgetId 直接下发到 performDocAction 命中 id（Fixture A：显式 id）', async () => {
    const envelope = buildRequestEnvelope({ userText: USER_TEXT_WITH_WIDGET_BLOCK })
    const resource = envelope.resources.find((item) => item.kind === 'widget_target')!
    assert.equal(resource.widgetId, 'widget_guide_fixed')

    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, buildFixtureAContent())

    const result = await performDocAction({
      type: 'update_widget',
      target: resource.widgetId!,
      componentSpecPatch: { props: { tone: 'warning' } },
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /已更新 widget（字段级 patch）/)
    assert.match(updated?.content || '', /"tone":"warning"/)
  })

  it('匿名 widget 的 FNV 稳定 id 两次解析一致（G-B3 回归哨兵）', () => {
    const content = buildFixtureBContent()
    const first = collectDocumentWidgets(content)
    const second = collectDocumentWidgets(content)
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.match(first[0].id, /^widget_[a-z0-9]+$/)
    assert.equal(first[0].id, second[0].id, 'ensureDocumentWidgetId 必须对同一文档内容幂等')
  })

  it('匿名 widget：渲染端解析出的 id 能通过 performDocAction patch 命中同一段 fence（Fixture B）', async () => {
    const content = buildFixtureBContent()
    const records = collectDocumentWidgets(content)
    const generatedId = records[0].id

    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, content)

    const result = await performDocAction({
      type: 'update_widget',
      target: generatedId,
      componentSpecPatch: { props: { tone: 'warning' } },
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /已更新 widget（字段级 patch）/)
    assert.match(updated?.content || '', /"tone":"warning"/)
  })
})
