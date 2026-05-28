import { copyFileSync, existsSync, writeFileSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { extname } from 'path'
import { EBOOK_BINARY_EXTENSIONS } from '../../../shared/ebook'
import { BINARY_EXTENSIONS } from './binary-extensions'

let mammothLib: typeof import('mammoth') | null = null
let docxLib: typeof import('docx') | null = null

async function getMammoth(): Promise<typeof import('mammoth') | null> {
  if (mammothLib) return mammothLib
  try {
    mammothLib = await import('mammoth')
    return mammothLib
  } catch {
    return null
  }
}

async function getDocx(): Promise<typeof import('docx') | null> {
  if (docxLib) return docxLib
  try {
    docxLib = await import('docx')
    return docxLib
  } catch {
    return null
  }
}

const TEXT_WRITE_BLOCKED_EXTENSIONS = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf',
  ...EBOOK_BINARY_EXTENSIONS,
])

function isBinaryFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function isTextWriteBlocked(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return TEXT_WRITE_BLOCKED_EXTENSIONS.has(ext)
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
}

function normalizeDocContentForDocx(content: string): string {
  if (!content) return ''
  const hasHtml = /<[^>]+>/.test(content)
  if (!hasHtml) return content

  const withBreaks = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')

  const noTags = withBreaks.replace(/<[^>]+>/g, '')
  return decodeHtmlEntities(noTags)
}

function normalizeInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
}

function makeTimestampLabel(date = new Date()): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

async function readDocxRawText(path: string): Promise<string> {
  const mammoth = await getMammoth()
  if (!mammoth) return ''
  try {
    const buffer = await readFile(path)
    const mammothMod = (mammoth as unknown as { default?: typeof import('mammoth') }).default || mammoth
    const textResult = await mammothMod.extractRawText({ buffer })
    return (textResult.value || '').trim()
  } catch {
    return ''
  }
}

async function writeDocxFromContent(path: string, content: string): Promise<{ success: boolean; error?: string }> {
  const docx = await getDocx()
  if (!docx) {
    return { success: false, error: 'DOCX 写入库(docx)不可用' }
  }

  try {
    const normalized = normalizeDocContentForDocx(content).replace(/\r\n/g, '\n')
    const trimmed = normalized.trim()

    if (trimmed.length === 0 && existsSync(path)) {
      const previousText = await readDocxRawText(path)
      if (previousText.length > 0) {
        return {
          success: false,
          error: '检测到空内容将覆盖已有 DOCX 正文，已阻止保存。请先确认文档已正确加载。',
        }
      }
    }

    if (existsSync(path)) {
      const previousText = await readDocxRawText(path)
      const prevLen = previousText.trim().length
      const nextLen = trimmed.length
      const suspiciousShrink =
        prevLen >= 600 &&
        nextLen > 0 &&
        nextLen <= 120 &&
        nextLen / prevLen < 0.08
      if (suspiciousShrink) {
        return {
          success: false,
          error:
            '检测到将长文档覆盖为极短内容，已阻止保存以避免误写。请确认文档已正确加载后再保存。',
        }
      }
    }

    if (existsSync(path)) {
      try {
        const backupPath = `${path}.autosave-${makeTimestampLabel()}.bak.docx`
        copyFileSync(path, backupPath)
      } catch {
        // Backup failure should not block user save.
      }
    }

    const lines = normalized.split('\n')
    const paragraphs: InstanceType<typeof docx.Paragraph>[] = []

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/g, '')
      const trimmed = line.trim()
      if (!trimmed) {
        paragraphs.push(new docx.Paragraph({ text: '' }))
        continue
      }

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        const level = headingMatch[1].length
        const text = normalizeInlineMarkdown(headingMatch[2].trim())
        const heading =
          level <= 1 ? docx.HeadingLevel.HEADING_1
            : level === 2 ? docx.HeadingLevel.HEADING_2
              : level === 3 ? docx.HeadingLevel.HEADING_3
                : level === 4 ? docx.HeadingLevel.HEADING_4
                  : level === 5 ? docx.HeadingLevel.HEADING_5
                    : docx.HeadingLevel.HEADING_6
        paragraphs.push(
          new docx.Paragraph({
            text,
            heading,
          }),
        )
        continue
      }

      const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/)
      if (bulletMatch) {
        paragraphs.push(
          new docx.Paragraph({
            text: normalizeInlineMarkdown(bulletMatch[1].trim()),
            bullet: { level: 0 },
          }),
        )
        continue
      }

      const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/)
      if (orderedMatch) {
        paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(orderedMatch[1].trim()) }))
        continue
      }

      const quoteMatch = trimmed.match(/^>\s*(.+)$/)
      if (quoteMatch) {
        paragraphs.push(
          new docx.Paragraph({
            text: normalizeInlineMarkdown(quoteMatch[1].trim()),
            indent: { left: 480 },
          }),
        )
        continue
      }

      paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(trimmed) }))
    }

    const document = new docx.Document({
      sections: [
        {
          children: paragraphs.length > 0 ? paragraphs : [new docx.Paragraph({ text: '' })],
        },
      ],
    })

    const output = await docx.Packer.toBuffer(document)
    writeFileSync(path, output)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: `DOCX 写入失败: ${errorMessage}` }
  }
}

export async function readDocumentEditableText(
  filePath: string,
): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    if (!existsSync(filePath)) {
      return { success: false, content: '', error: 'File not found' }
    }
    const ext = extname(filePath).toLowerCase()
    if (ext === '.docx') {
      const text = await readDocxRawText(filePath)
      if (!text && existsSync(filePath)) {
        return { success: false, content: '', error: 'DOCX 读取失败或正文为空' }
      }
      return { success: true, content: text }
    }
    if (isBinaryFile(filePath)) {
      return { success: false, content: '', error: `不支持直接编辑二进制文件: ${ext || 'unknown'}` }
    }
    const content = await readFile(filePath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return {
      success: false,
      content: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function writeDocumentEditableText(
  filePath: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const ext = extname(filePath).toLowerCase()
    if (ext === '.docx') {
      return writeDocxFromContent(filePath, content)
    }
    if (isTextWriteBlocked(filePath)) {
      return {
        success: false,
        error: `无法直接以纯文本保存到 ${ext || 'binary'} 文件。请另存为 .md/.txt，避免损坏原文件。`,
      }
    }
    await writeFile(filePath, content, 'utf-8')
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
