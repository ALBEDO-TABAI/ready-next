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
    splitRatio: 50,
    readySubMode: 'browser',
  })
  useDocTabs.setState({
    tabs: [{ id: 'welcome', title: '未命名', path: null, content: '', isDirty: false }],
    activeTabId: 'welcome',
    splitTabId: null,
    splitRatio: 50,
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
      widgetTitle: 'stock_price_chart',
      widgetCode: '<div>demo</div>',
      widgetMode: 'scripted',
    })

    assert.equal(attachment.source, 'document-widget-target')
    assert.equal(attachment.widgetTitle, 'stock_price_chart')
    assert.equal(attachment.documentTitle, '新文档.md')
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
      widgetTitle: 'stock_price_chart',
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
    assert.match(String(composed), /优先使用 document_update_widget/)
    assert.match(String(composed), /```show-widget/)
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
      splitRatio: 50,
      pendingReveal: null,
    })

    const composed = await buildComposedAgentInput({
      content: '总结当前文档',
      attachments: [],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /### 当前文档上下文/)
    assert.match(String(composed), /这是当前文档的正文内容/)
    assert.doesNotMatch(String(composed), /## 环境信息\n- 当前模式: 文档模式/)
  })

  it('teaches direct-chat to force document widget updates when the marker is present', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/claude-bridge/direct-chat.ts'),
      'utf8',
    )

    assert.match(source, /hasWidgetTargetContext = userText\.includes\('### Widget 更新上下文'\)/)
    assert.match(source, /forceDocumentTool: hasTools && \(hasWidgetTargetContext \|\| this\.shouldForceDocumentToolCall/)
    assert.match(source, /documentWidgetTaskKind = hasWidgetTargetContext \? 'update'/)
  })
})
