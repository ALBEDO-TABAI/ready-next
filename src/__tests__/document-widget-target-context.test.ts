import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildComposedAgentInput } from '../renderer/modules/agent/messageComposer'
import { buildWidgetTargetUpdatePrompt, createDocumentWidgetTargetAttachment } from '../renderer/modules/agent/widget-target-attachment'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { useMode } from '../renderer/stores/useMode'

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  useMode.setState({
    appMode: 'workbench',
    workbenchMode: 'browser',
    splitMode: null,
    workbenchSplitRatio: 50,
    readySubMode: 'browser',
  })
  useDocTabs.setState({
    tabs: [{ id: 'welcome', title: '未命名', path: null, content: '', isDirty: false }],
    activeTabId: 'welcome',
    splitTabId: null,
    documentSplitRatio: 50,
    pendingReveal: null,
  })
})

describe('document widget target context', () => {
  it('creates a compact widget update prompt for the chat input', () => {
    const prompt = buildWidgetTargetUpdatePrompt('stock_price_chart')
    assert.equal(prompt, '更新当前文档里的 stock_price_chart widget：')
  })

  it('creates a widget target attachment capsule', () => {
    const attachment = createDocumentWidgetTargetAttachment({
      documentTitle: '新文档.md',
      documentPath: '/Users/user/新文档.md',
      tabId: 'doc-1',
      widgetTitle: 'stock_price_chart',
      widgetId: 'widget_stock_price_chart',
      widgetCode: '<div>demo</div>',
      widgetMode: 'scripted',
    })

    assert.equal(attachment.source, 'document-widget-target')
    assert.equal(attachment.widgetTitle, 'stock_price_chart')
    assert.equal(attachment.documentTitle, '新文档.md')
    assert.equal(attachment.tabId, 'doc-1')
    assert.equal(attachment.widgetId, 'widget_stock_price_chart')
  })

  it('injects a structured widget update context block into composed agent input', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const attachment = createDocumentWidgetTargetAttachment({
      documentTitle: '新文档.md',
      documentPath: '/Users/user/新文档.md',
      tabId: 'doc-1',
      widgetTitle: 'stock_price_chart',
      widgetId: 'widget_stock_price_chart',
      widgetCode: '<div class="card">demo</div>',
      widgetMode: 'scripted',
    })

    const composed = await buildComposedAgentInput({
      content: '更新当前文档里的 stock_price_chart widget：把边框去掉',
      attachments: [attachment],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /### Widget 更新上下文/)
    assert.match(String(composed), /目标 widget: stock_price_chart/)
    assert.match(String(composed), /标签页ID: doc-1/)
    assert.match(String(composed), /widgetId: widget_stock_price_chart/)
    assert.match(String(composed), /优先使用 document_update_widget/)
    assert.match(String(composed), /```show-widget/)
  })

  it('injects skill folder references without legacy slash commands', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const composed = await buildComposedAgentInput({
      content: '使用@[Video Expert Analyzer (VNext)]分析视频',
      attachments: [
        {
          id: 'skill-att-1',
          name: 'Video Expert Analyzer (VNext)',
          path: '/Users/user/Library/Application Support/ready/skill-runtime/skills/video-expert-analyzer',
          type: 'text',
          size: 0,
          ext: '.skill',
          source: 'skill-folder',
          skillId: 'video-expert-analyzer',
          skillFolderPath: '/Users/user/Library/Application Support/ready/skill-runtime/skills/video-expert-analyzer',
        },
      ],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /### 技能目录引用/)
    assert.match(String(composed), /skillId: video-expert-analyzer/)
    assert.doesNotMatch(String(composed), /\/skill video-expert-analyzer/)
  })

  it('does not carry widget update context into unrelated plain questions', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const attachment = createDocumentWidgetTargetAttachment({
      documentTitle: '新文档.md',
      documentPath: '/Users/user/新文档.md',
      tabId: 'doc-1',
      widgetTitle: 'stock_price_chart',
      widgetId: 'widget_stock_price_chart',
      widgetCode: '<div class="card">demo</div>',
      widgetMode: 'scripted',
    })

    const composed = await buildComposedAgentInput({
      content: '今天广州天气怎么样',
      attachments: [attachment],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /今天广州天气怎么样/)
    assert.doesNotMatch(String(composed), /### Widget 更新上下文/)
    assert.doesNotMatch(String(composed), /```show-widget/)
  })

  it('prefers active document content over generic environment text in document mode', async () => {
    useMode.getState().setWorkbenchMode('document')
    useDocTabs.setState({
      tabs: [
        {
          id: 'doc-1',
          title: '需求文档.md',
          path: '/tmp/需求文档.md',
          content: '这是当前文档的正文内容',
          isDirty: false,
        },
      ],
      activeTabId: 'doc-1',
      splitTabId: null,
      documentSplitRatio: 50,
      pendingReveal: null,
    })

    const composed = await buildComposedAgentInput({
      content: '总结当前文档',
      attachments: [],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /### 当前文档上下文/)
    assert.match(String(composed), /--- 文档摘要开始 ---/)
    assert.match(String(composed), /这是当前文档的正文内容/)
    assert.doesNotMatch(String(composed), /--- 文档内容开始 ---/)
    assert.doesNotMatch(String(composed), /## 环境信息\n- 当前模式: 文档模式/)
  })

  it('teaches the execution intent resolver to force document widget updates when the marker is present', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/agent-control/execution-intent-resolver.ts'),
      'utf8',
    )

    assert.match(source, /const envelopeHasWidgetTarget = params\.requestEnvelope\.environmentHints\.hasWidgetTargetContext/)
    assert.match(source, /const hasWidgetTargetContext = envelopeHasWidgetTarget \|\| leaseStickyEligible/)
    assert.match(source, /const explicitWidgetCreateIntent = hasExplicitDocumentWidgetCreateIntent\(contextualUserInput\)/)
    assert.match(source, /hasWidgetTargetContext && !explicitWidgetCreateIntent[\s\S]*\? 'update'/)
    assert.match(source, /const allowDocumentTools = baseVisibilityPlan\.hasTools && \([\s\S]*params\.hasWidgetTargetContext[\s\S]*shouldForceDocumentToolCall\(params\.contextualUserInput\)/)
    assert.match(source, /forceDocumentTool:\s*allowDocumentTools && \([\s\S]*params\.hasWidgetTargetContext && !params\.explicitWidgetCreateIntent[\s\S]*shouldForceDocumentToolCall\(params\.contextualUserInput\)/)
  })
})
