import { basename, extname } from 'node:path'

import type { DocumentWorkerApi } from '../document-engine/document-worker-protocol'

export interface DocumentAttachmentTextResult {
  type: 'text'
  content: string
  name: string
}

export async function readHeavyDocumentAttachmentForAI(
  filePath: string,
  worker: Pick<DocumentWorkerApi, 'extractDocumentText'>,
): Promise<DocumentAttachmentTextResult | null> {
  const extension = extname(filePath).toLowerCase()
  const name = basename(filePath)

  if (extension === '.docx') {
    const extracted = await worker.extractDocumentText(filePath, { maxChars: 20_000 })
    if (!extracted.success) throw new Error(extracted.error || 'DOCX 解析失败')
    const fallback = Boolean(extracted.warning)
    const label = fallback ? 'DOCX(结构损坏回退文本)' : 'DOCX'
    const suffix = extracted.truncated
      ? `\n...[${fallback ? 'DOCX 回退文本' : 'DOCX 内容'}已截断]`
      : ''
    return {
      type: 'text',
      content: `--- ${label}: ${name} ---\n${extracted.text.trim()}${suffix}`,
      name,
    }
  }

  if (extension === '.xlsx' || extension === '.xls') {
    const extracted = await worker.extractDocumentText(filePath, {
      maxSheets: 6,
      maxRowsPerSheet: 40,
      maxColumns: 20,
      maxChars: 20_000,
    })
    if (!extracted.success) throw new Error(extracted.error || '表格解析失败')
    return { type: 'text', content: `--- 表格文件: ${name} ---\n${extracted.text}`, name }
  }

  if (extension === '.pdf') {
    const extracted = await worker.extractDocumentText(filePath, { maxChars: 20_000 })
    if (!extracted.success) throw new Error(extracted.error || 'PDF 解析失败')
    const suffix = extracted.truncated ? '\n...[PDF 内容已截断]' : ''
    return {
      type: 'text',
      content: `--- PDF: ${name} ---\n${extracted.text.trim()}${suffix}`,
      name,
    }
  }

  return null
}
