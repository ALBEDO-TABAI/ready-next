import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildComposedAgentInput } from '../renderer/modules/agent/messageComposer'
import { buildWidgetTargetUpdatePrompt, createDocumentWidgetTargetAttachment } from '../renderer/modules/agent/widget-target-attachment'

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
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
