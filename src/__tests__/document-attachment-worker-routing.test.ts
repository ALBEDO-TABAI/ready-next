import assert from 'node:assert/strict'
import test from 'node:test'

import { readHeavyDocumentAttachmentForAI } from '../main/modules/claude-bridge/document-attachment-text'
import type {
  DocumentTextExtractOptions,
  DocumentTextExtractResult,
} from '../main/modules/document-engine/document-worker-protocol'

test('chat attachments route DOCX, spreadsheets, and PDF through the document worker', async () => {
  const calls: Array<{ path: string; options?: DocumentTextExtractOptions }> = []
  const worker = {
    extractDocumentText: async (path: string, options?: DocumentTextExtractOptions): Promise<DocumentTextExtractResult> => {
      calls.push({ path, options })
      return {
        success: true,
        kind: path.split('.').pop() || 'unknown',
        text: `text from ${path}`,
        totalChars: 40_000,
        truncated: path.endsWith('.pdf'),
      }
    },
  }

  const docx = await readHeavyDocumentAttachmentForAI('/tmp/brief.docx', worker)
  const xlsx = await readHeavyDocumentAttachmentForAI('/tmp/table.xlsx', worker)
  const pdf = await readHeavyDocumentAttachmentForAI('/tmp/report.pdf', worker)

  assert.match(docx?.content || '', /DOCX: brief\.docx/)
  assert.match(xlsx?.content || '', /表格文件: table\.xlsx/)
  assert.match(pdf?.content || '', /PDF: report\.pdf/)
  assert.match(pdf?.content || '', /PDF 内容已截断/)
  assert.deepEqual(calls, [
    { path: '/tmp/brief.docx', options: { maxChars: 20_000 } },
    {
      path: '/tmp/table.xlsx',
      options: { maxSheets: 6, maxRowsPerSheet: 40, maxColumns: 20, maxChars: 20_000 },
    },
    { path: '/tmp/report.pdf', options: { maxChars: 20_000 } },
  ])
  assert.equal(await readHeavyDocumentAttachmentForAI('/tmp/note.md', worker), null)
  assert.equal(calls.length, 3)
})

test('chat attachment extraction surfaces worker failures without a synchronous fallback', async () => {
  const worker = {
    extractDocumentText: async (): Promise<DocumentTextExtractResult> => ({
      success: false,
      kind: 'pdf',
      text: '',
      totalChars: 0,
      truncated: false,
      error: 'worker unavailable',
    }),
  }
  await assert.rejects(
    readHeavyDocumentAttachmentForAI('/tmp/report.pdf', worker),
    /worker unavailable/,
  )
})

test('chat attachments preserve the worker-owned readable fallback for damaged DOCX files', async () => {
  const worker = {
    extractDocumentText: async (): Promise<DocumentTextExtractResult> => ({
      success: true,
      kind: 'docx',
      text: 'Recovered attachment body',
      totalChars: 25,
      truncated: false,
      offset: 0,
      nextOffset: null,
      warning: 'DOCX 文件结构损坏，已回退为原始可读文本。',
    }),
  }
  const result = await readHeavyDocumentAttachmentForAI('/tmp/damaged.docx', worker)
  assert.match(result?.content || '', /DOCX\(结构损坏回退文本\)/)
  assert.match(result?.content || '', /Recovered attachment body/)
})
