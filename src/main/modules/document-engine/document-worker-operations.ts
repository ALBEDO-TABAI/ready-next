import { copyFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'

import { publishFileAtomically } from './atomic-file-publish'
import type {
  DocumentTextExtractOptions,
  DocumentTextExtractResult,
} from './document-worker-protocol'

function looksLikeReadableText(value: string): boolean {
  if (!value || value.trim().length === 0) return false
  const sample = value.slice(0, 4000)
  let printable = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13
    if (!isControl) printable += 1
  }
  return printable / sample.length > 0.88
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
  if (!/<[^>]+>/.test(content)) return content
  const withBreaks = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
  return decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ''))
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
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ]
  return parts.join('')
}

async function getMammoth() {
  const module = await import('mammoth')
  return (module as unknown as { default?: typeof import('mammoth') }).default || module
}

export async function readDocxTextOperation(
  path: string,
): Promise<{ success: boolean; content: string; warning?: string; error?: string }> {
  try {
    if (!existsSync(path)) return { success: false, content: '', error: 'File not found' }
    const mammoth = await getMammoth()
    const buffer = await readFile(path)
    const result = await mammoth.extractRawText({ buffer })
    return { success: true, content: (result.value || '').trim() }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (/end of central directory|zip file/i.test(errorMessage)) {
      try {
        const fallbackText = await readFile(path, 'utf8')
        if (looksLikeReadableText(fallbackText)) {
          return {
            success: true,
            content: fallbackText.trim(),
            warning: 'DOCX 文件结构损坏，已回退为原始可读文本。',
          }
        }
      } catch {
        // Preserve the original parse error.
      }
    }
    return { success: false, content: '', error: errorMessage }
  }
}

export async function parseDocxOperation(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) {
    return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND', file: path }
  }
  try {
    const mammoth = await getMammoth()
    const buffer = await readFile(path)
    const [htmlResult, textResult] = await Promise.all([
      mammoth.convertToHtml({ buffer }),
      mammoth.extractRawText({ buffer }),
    ])
    return {
      success: true,
      data: { html: htmlResult.value, rawText: textResult.value, messages: htmlResult.messages },
      content: htmlResult.value,
      html: htmlResult.value,
      file: path,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (/end of central directory|zip file/i.test(errorMessage)) {
      try {
        const rawText = await readFile(path, 'utf-8')
        if (looksLikeReadableText(rawText)) {
          const html = `<pre>${escapeHtml(rawText)}</pre>`
          return {
            success: true,
            data: {
              html,
              rawText,
              messages: [{
                type: 'warning',
                message: 'DOCX 文件结构损坏，已回退为原始文本视图（文件可能曾被当作纯文本覆盖保存）。',
              }],
            },
            content: html,
            html,
            file: path,
          }
        }
      } catch {
        // Preserve the original parse error.
      }
    }
    return {
      success: false,
      error: `Failed to parse DOCX: ${errorMessage}`,
      errorCode: 'PARSE_ERROR',
      file: path,
    }
  }
}

export async function parseXlsxOperation(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) {
    return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND', file: path }
  }
  try {
    const module = await import('xlsx')
    const xlsx = (module as unknown as { default?: typeof import('xlsx') }).default || module
    const workbook = xlsx.read(await readFile(path), { type: 'buffer' })
    const sheets: Array<{ name: string; data: unknown[][] }> = []
    const sheetData: Record<string, unknown[][]> = {}
    for (const name of workbook.SheetNames) {
      const rows = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1 }) as unknown[][]
      sheets.push({ name, data: rows })
      sheetData[name] = rows
    }
    return {
      success: true,
      data: { sheets },
      sheets: workbook.SheetNames,
      sheetData,
      file: path,
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse XLSX: ${error instanceof Error ? error.message : String(error)}`,
      errorCode: 'PARSE_ERROR',
      file: path,
    }
  }
}

export function getDocxOverwriteBlockReason(previousText: string, nextText: string): string | null {
  const previous = previousText.trim()
  const next = nextText.trim()
  if (!next && previous) {
    return '检测到空内容将覆盖已有 DOCX 正文，已阻止保存。请先确认文档已正确加载。'
  }
  if (previous.length >= 600 && next.length > 0 && next.length <= 120 && next.length / previous.length < 0.08) {
    return '检测到将长文档覆盖为极短内容，已阻止保存以避免误写。请确认文档已正确加载后再保存。'
  }
  return null
}

export async function writeDocxOperation(
  path: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const normalized = normalizeDocContentForDocx(content).replace(/\r\n/g, '\n')
    const existed = existsSync(path)
    const previousResult = existed ? await readDocxTextOperation(path) : null
    const previousText = previousResult?.success ? previousResult.content : ''
    const blockReason = getDocxOverwriteBlockReason(previousText, normalized)
    if (blockReason) return { success: false, error: blockReason }

    const docx = await import('docx')
    const paragraphs: InstanceType<typeof docx.Paragraph>[] = []
    for (const rawLine of normalized.split('\n')) {
      const line = rawLine.replace(/\s+$/g, '')
      const trimmed = line.trim()
      if (!trimmed) {
        paragraphs.push(new docx.Paragraph({ text: '' }))
        continue
      }
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        const level = headingMatch[1].length
        const headings = [
          docx.HeadingLevel.HEADING_1,
          docx.HeadingLevel.HEADING_2,
          docx.HeadingLevel.HEADING_3,
          docx.HeadingLevel.HEADING_4,
          docx.HeadingLevel.HEADING_5,
          docx.HeadingLevel.HEADING_6,
        ]
        paragraphs.push(new docx.Paragraph({
          text: normalizeInlineMarkdown(headingMatch[2].trim()),
          heading: headings[Math.min(level, 6) - 1],
        }))
        continue
      }
      const bullet = trimmed.match(/^[-*]\s+(.+)$/)
      if (bullet) {
        paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(bullet[1].trim()), bullet: { level: 0 } }))
        continue
      }
      const ordered = trimmed.match(/^\d+\.\s+(.+)$/)
      if (ordered) {
        paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(ordered[1].trim()) }))
        continue
      }
      const quote = trimmed.match(/^>\s*(.+)$/)
      if (quote) {
        paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(quote[1].trim()), indent: { left: 480 } }))
        continue
      }
      paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(trimmed) }))
    }

    const document = new docx.Document({
      sections: [{ children: paragraphs.length > 0 ? paragraphs : [new docx.Paragraph({ text: '' })] }],
    })
    const output = await docx.Packer.toBuffer(document)
    if (existed) {
      await copyFile(path, `${path}.autosave-${makeTimestampLabel()}.bak.docx`).catch(() => undefined)
    }
    await publishFileAtomically(path, output)
    return { success: true }
  } catch (error) {
    return { success: false, error: `DOCX 写入失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function importEpubOperation(sourcePath: string): Promise<Record<string, unknown>> {
  const { importEpubAsMarkdown } = await import('./ebook-importer')
  return importEpubAsMarkdown(sourcePath) as unknown as Record<string, unknown>
}

function stringifyCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function finishTextExtraction(
  kind: string,
  text: string,
  options: DocumentTextExtractOptions,
): DocumentTextExtractResult {
  const offset = typeof options.offset === 'number' && Number.isFinite(options.offset)
    ? Math.max(0, Math.floor(options.offset))
    : 0
  const maxChars = typeof options.maxChars === 'number' && Number.isFinite(options.maxChars)
    ? Math.max(1, Math.floor(options.maxChars))
    : text.length
  const end = Math.min(text.length, offset + maxChars)
  const nextOffset = end < text.length ? end : null
  return {
    success: true,
    kind,
    text: text.slice(offset, end),
    totalChars: text.length,
    truncated: nextOffset !== null,
    offset,
    nextOffset,
  }
}

function failedTextExtraction(
  kind: string,
  error: string,
  options: DocumentTextExtractOptions,
): DocumentTextExtractResult {
  const offset = typeof options.offset === 'number' && Number.isFinite(options.offset)
    ? Math.max(0, Math.floor(options.offset))
    : 0
  return { success: false, kind, text: '', totalChars: 0, truncated: false, offset, nextOffset: null, error }
}

export async function extractDocumentTextOperation(
  path: string,
  options: DocumentTextExtractOptions = {},
): Promise<DocumentTextExtractResult> {
  const extension = extname(path).toLowerCase()
  if (!existsSync(path)) {
    return failedTextExtraction(extension.slice(1) || 'unknown', 'File not found', options)
  }
  try {
    if (extension === '.docx') {
      const parsed = await readDocxTextOperation(path)
      if (!parsed.success) {
        return failedTextExtraction('docx', parsed.error || 'DOCX parse failed', options)
      }
      const extracted = finishTextExtraction('docx', parsed.content, options)
      return parsed.warning ? { ...extracted, warning: parsed.warning } : extracted
    }

    if (extension === '.xlsx' || extension === '.xls') {
      const module = await import('xlsx')
      const xlsx = (module as unknown as { default?: typeof import('xlsx') }).default || module
      const workbook = xlsx.read(await readFile(path), { type: 'buffer' })
      const maxSheets = Math.max(1, Math.floor(options.maxSheets ?? workbook.SheetNames.length))
      const maxRows = Math.max(1, Math.floor(options.maxRowsPerSheet ?? 200))
      const maxColumns = Math.max(1, Math.floor(options.maxColumns ?? Number.MAX_SAFE_INTEGER))
      const sections: string[] = []
      for (const sheetName of workbook.SheetNames.slice(0, maxSheets)) {
        const sheet = workbook.Sheets[sheetName]
        const sheetRange = sheet['!ref'] ? xlsx.utils.decode_range(sheet['!ref']) : null
        const boundedRange = sheetRange
          ? xlsx.utils.encode_range({
              s: sheetRange.s,
              e: {
                r: Math.min(sheetRange.e.r, sheetRange.s.r + maxRows - 1),
                c: Math.min(sheetRange.e.c, sheetRange.s.c + maxColumns - 1),
              },
            })
          : undefined
        const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, range: boundedRange }) as unknown[][]
        sections.push(`# ${sheetName}`)
        for (const row of rows) {
          sections.push((Array.isArray(row) ? row : [row]).map(stringifyCell).join('\t').trimEnd())
        }
      }
      return finishTextExtraction('spreadsheet', sections.join('\n'), options)
    }

    if (extension === '.pdf') {
      const previousDisableLogs = process.env.PDF2JSON_DISABLE_LOGS
      process.env.PDF2JSON_DISABLE_LOGS = '1'
      try {
        const { default: PDFParser } = await import('pdf2json')
        const buffer = await readFile(path)
        const text = await new Promise<string>((resolve, reject) => {
          const parser = new PDFParser(null, true)
          const timer = setTimeout(() => reject(new Error('PDF text extraction timed out')), 15_000)
          timer.unref?.()
          parser.on('pdfParser_dataError', (errorData: Error | { parserError: Error }) => {
            clearTimeout(timer)
            reject(errorData instanceof Error ? errorData : errorData.parserError)
          })
          parser.on('pdfParser_dataReady', () => {
            clearTimeout(timer)
            resolve(parser.getRawTextContent())
          })
          parser.parseBuffer(buffer)
        })
        return finishTextExtraction('pdf', text, options)
      } finally {
        if (previousDisableLogs === undefined) delete process.env.PDF2JSON_DISABLE_LOGS
        else process.env.PDF2JSON_DISABLE_LOGS = previousDisableLogs
      }
    }

    return failedTextExtraction(
      extension.slice(1) || 'unknown',
      `Unsupported document extraction type: ${extension || 'unknown'}`,
      options,
    )
  } catch (error) {
    return failedTextExtraction(
      extension.slice(1) || 'unknown',
      error instanceof Error ? error.message : String(error),
      options,
    )
  }
}
