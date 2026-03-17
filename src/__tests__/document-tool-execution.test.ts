import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { executeDocumentTool } from '../main/modules/tools/document-tools'

describe('document tool execution', () => {
  it('returns real renderer summaries when a requester is available', async () => {
    const result = await executeDocumentTool(
      'document_list_widgets',
      {},
      {
        requestModuleToolAction: async (tool, args) => {
          assert.equal(tool, 'document.listWidgets')
          assert.deepEqual(args, {})
          return {
            intent: 'document.listWidgets',
            summary: '当前文档共有 1 个 widget（新文档.md）：\n1. stock_price_chart [scripted]',
          }
        },
      },
    )

    assert.match(result, /当前文档共有 1 个 widget/)
  })

  it('falls back to queued summaries when renderer execution is unavailable', async () => {
    const result = await executeDocumentTool('document_save_tab', {})
    assert.equal(result, 'Document save queued: document.saveTab')
  })
})
