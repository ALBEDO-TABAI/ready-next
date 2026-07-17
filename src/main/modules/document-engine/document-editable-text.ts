import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import { EBOOK_BINARY_EXTENSIONS } from '../../../shared/ebook'
import { BINARY_EXTENSIONS } from './binary-extensions'
import {
  DOCUMENT_TEXT_READ_CAP_BYTES,
  isDocumentTextReadTooLarge,
} from './attachment-size-guards'
import { publishFileAtomically } from './atomic-file-publish'
import { getDocumentWorker } from './document-worker-bridge'

const TEXT_WRITE_BLOCKED_EXTENSIONS = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf',
  ...EBOOK_BINARY_EXTENSIONS,
])

export async function readDocumentEditableText(
  filePath: string,
): Promise<{ success: boolean; content: string; error?: string; errorCode?: string }> {
  try {
    if (!existsSync(filePath)) return { success: false, content: '', error: 'File not found' }
    const extension = extname(filePath).toLowerCase()
    if (extension === '.docx') {
      const result = await getDocumentWorker().readDocxText(filePath)
      if (!result.success) return result
      if (!result.content) return { success: false, content: '', error: 'DOCX 读取失败或正文为空' }
      return result
    }
    if (BINARY_EXTENSIONS.has(extension)) {
      return { success: false, content: '', error: `不支持直接编辑二进制文件: ${extension || 'unknown'}` }
    }
    const fileStats = await stat(filePath)
    if (isDocumentTextReadTooLarge(fileStats.size)) {
      return {
        success: false,
        content: '',
        error: `文本文件超过 ${DOCUMENT_TEXT_READ_CAP_BYTES} 字节，已停止读取。`,
        errorCode: 'TEXT_FILE_TOO_LARGE',
      }
    }
    return { success: true, content: await readFile(filePath, 'utf-8') }
  } catch (error) {
    return { success: false, content: '', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeDocumentEditableText(
  filePath: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const extension = extname(filePath).toLowerCase()
    if (extension === '.docx') return getDocumentWorker().writeDocx(filePath, content)
    if (TEXT_WRITE_BLOCKED_EXTENSIONS.has(extension)) {
      return {
        success: false,
        error: `无法直接以纯文本保存到 ${extension || 'binary'} 文件。请另存为 .md/.txt，避免损坏原文件。`,
      }
    }
    await publishFileAtomically(filePath, content)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
