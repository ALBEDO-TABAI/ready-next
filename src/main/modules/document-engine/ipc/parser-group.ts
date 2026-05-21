// Stage V V2.3e — document-engine ParserGroup channel cluster.
//
// Bundles the 3 channels that drive renderer-initiated parse pipelines
// (binary office formats + ebook import):
//
//   document:parseDocx              (mammoth → html + rawText, with a
//                                    text-fallback for corrupted zip headers)
//   document:parseXlsx              (SheetJS → per-sheet [][] grids + a
//                                    legacy flat-data map for old callers)
//   document:importEbookAsMarkdown  (epub → on-disk markdown + assets,
//                                    fans the resulting index.md back into
//                                    the search-engine via the host's write
//                                    hook)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.3e follows
// the V2.3a/V2.3b/V2.3c/V2.3d move + thin-wrapper shape). The handlers do
// NOT import the parser libraries directly: the lazy mammoth/xlsx getters
// and the epub importer are wrapped behind small facades on
// `ParserGroupDeps`. This keeps the group testable with a stub host and a
// future move out of document-engine stays mechanical.
//
// The 3 channels live in one group despite mixing two raw-parse flows
// (`parseDocx`/`parseXlsx` — pure binary → structured data) with a
// side-effecting import (`importEbookAsMarkdown` — writes a tree of
// markdown + assets AND notifies the host's write-index hook) because they
// share:
//   • the same domain concept (turn a non-markdown source file into
//     something the document widget can render or further edit)
//   • the same dispose lifecycle (the "open this file" UI wires them as
//     one feature toggle)
//   • the same dep surface (mock flag + lazy-loaded parser modules + the
//     ebook importer + the write-index hook — no dialog, no shell, no
//     marks repo, no window resolution)
// Splitting the ebook importer off would create a single-handler group
// whose deps largely overlap (the write-index hook is also useful when a
// future parser flow wants to seed the search index); pinning the docx
// and xlsx parsers on their own would silently leak the ebook companion
// back into the host. The grouping is mixed-surface by design, mirroring
// V2.3c's FileMutationGroup (mutations + stat) and V2.3d's WorkspaceGroup
// (dialog flows + getHome read).
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { IpcMain } from 'electron'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Result shape returned by `ParserGroupDeps.importEbookAsMarkdown`.
 * Mirror of the host's `importEpubAsMarkdown` return value, narrowed to
 * the fields the handler reads (`success`, `indexPath`) and forwarded
 * verbatim to the renderer otherwise.
 */
export interface EbookImportResult {
  success: boolean
  indexPath?: string
  outputDir?: string
  assetCount?: number
  warnings?: string[]
  error?: string
  errorCode?: string
}

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these members; nothing more is required to exercise
 * the 3 handler bodies.
 */
export type ParserGroupDeps = Pick<
  EngineDeps,
  | 'useMock'
  | 'getDocumentWriteIndexHook'
  | 'getMammothModule'
  | 'getXlsxModule'
  | 'importEbookAsMarkdown'
>

const CHANNELS = [
  'document:parseDocx',
  'document:parseXlsx',
  'document:importEbookAsMarkdown',
] as const

/**
 * Heuristic: does this string look like printable text (so a corrupted
 * `.docx` is actually a plain-text file that was mis-saved with the
 * `.docx` extension)? Lifted verbatim from `ipc-handler.ts` as a private
 * helper because it is a pure transformation with no host-owned state —
 * the same rationale that kept `escapeHtml` below inline rather than on
 * the dep surface.
 */
function looksLikeReadableText(value: string): boolean {
  if (!value || value.trim().length === 0) return false
  const sample = value.slice(0, 4000)
  let printable = 0
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13
    if (!isControl) printable += 1
  }
  return printable / sample.length > 0.88
}

/**
 * Minimal HTML entity escaper used by the docx text-fallback path. Pure
 * function — see `looksLikeReadableText` for the rationale on inlining
 * rather than lifting to deps.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export const parserGroup: IpcChannelGroup<ParserGroupDeps> = {
  namespace: 'document:parser',

  register(ipcMain: IpcMain, deps: ParserGroupDeps): IpcDisposeHandle {
    // setupDocumentIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the pre-extraction defensive pattern used by
    // V2.3a MarkGroup, V2.3b FileIoGroup, V2.3c FileMutationGroup, V2.3d
    // WorkspaceGroup, and the rss-engine groups (V2.2a).
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    // Import an EPUB (or other supported ebook archive) as on-disk
    // markdown + assets. Side effect: when the importer succeeds and a
    // write-index hook is registered, the resulting `index.md` is fanned
    // back into the search engine so the new markdown surface is
    // immediately searchable (same wiring as `document:write`).
    ipcMain.handle('document:importEbookAsMarkdown', async (_, payload: { sourcePath?: string }) => {
      try {
        if (deps.useMock) {
          const sourcePath = payload?.sourcePath || 'book.epub'
          return {
            success: true,
            outputDir: dirname(sourcePath),
            indexPath: join(dirname(sourcePath), 'index.md'),
            assetCount: 0,
            warnings: [],
            mock: true,
          }
        }
        const sourcePath = typeof payload?.sourcePath === 'string' ? payload.sourcePath : ''
        if (!sourcePath) {
          return { success: false, error: '缺少电子书路径', errorCode: 'INVALID_INPUT' }
        }
        const result = await deps.importEbookAsMarkdown(sourcePath)
        const writeIndexHook = deps.getDocumentWriteIndexHook()
        if (result.success && result.indexPath && writeIndexHook) {
          try {
            const content = await readFile(result.indexPath, 'utf-8')
            writeIndexHook(result.indexPath, content)
          } catch (hookError) {
            console.warn('[document-engine] ebook import index hook failed', hookError)
          }
        }
        return result
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorCode: 'EBOOK_IMPORT_FAILED',
        }
      }
    })

    // Parse docx — real parsing with mammoth, returns { html, rawText }
    ipcMain.handle('document:parseDocx', async (_, path: string) => {
      try {
        if (deps.useMock) {
          return {
            success: true,
            data: {
              html: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
              rawText: '[Mock] DOCX parsing requires mammoth.js'
            },
            // backward compat
            content: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
            html: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
            mock: true
          }
        }

        if (!existsSync(path)) {
          return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND', file: path }
        }

        const mammoth = await deps.getMammothModule()
        if (!mammoth) {
          return {
            success: false,
            error: 'DOCX parsing library (mammoth) is not installed. Run: npm install mammoth',
            errorCode: 'LIBRARY_NOT_INSTALLED'
          }
        }

        const buffer = await readFile(path)

        // Use the mammoth module — handle both default and named exports
        const mammothMod = (mammoth as unknown as { default?: typeof import('mammoth') }).default || mammoth
        const htmlResult = await mammothMod.convertToHtml({ buffer })
        const textResult = await mammothMod.extractRawText({ buffer })

        return {
          success: true,
          data: {
            html: htmlResult.value,
            rawText: textResult.value,
            messages: htmlResult.messages
          },
          // backward compat
          content: htmlResult.value,
          html: htmlResult.value,
          file: path
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
                  messages: [
                    {
                      type: 'warning',
                      message: 'DOCX 文件结构损坏，已回退为原始文本视图（文件可能曾被当作纯文本覆盖保存）。',
                    },
                  ],
                },
                content: html,
                html,
                file: path,
              }
            }
          } catch {
            // Keep original parse error below.
          }
        }
        return {
          success: false,
          error: `Failed to parse DOCX: ${errorMessage}`,
          errorCode: 'PARSE_ERROR',
          file: path
        }
      }
    })

    // Parse xlsx — real parsing with SheetJS, multi-sheet support
    ipcMain.handle('document:parseXlsx', async (_, path: string) => {
      try {
        if (deps.useMock) {
          return {
            success: true,
            data: {
              sheets: [
                { name: 'Sheet1', data: [['A1', 'B1'], ['A2', 'B2']] }
              ]
            },
            // backward compat
            sheets: ['Sheet1'],
            file: path,
            mock: true
          }
        }

        if (!existsSync(path)) {
          return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND', file: path }
        }

        const xlsx = await deps.getXlsxModule()
        if (!xlsx) {
          return {
            success: false,
            error: 'XLSX parsing library (xlsx) is not installed. Run: npm install xlsx',
            errorCode: 'LIBRARY_NOT_INSTALLED'
          }
        }

        const buffer = await readFile(path)
        const xlsxMod = (xlsx as unknown as { default?: typeof import('xlsx') }).default || xlsx
        const workbook = xlsxMod.read(buffer, { type: 'buffer' })

        // Build structured multi-sheet output: { name, data: string[][] }
        const sheets: Array<{ name: string; data: unknown[][] }> = []
        const legacyData: Record<string, unknown[][]> = {}

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const rows = xlsxMod.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]
          sheets.push({ name: sheetName, data: rows })
          legacyData[sheetName] = rows
        }

        return {
          success: true,
          data: { sheets },
          // backward compat
          sheets: workbook.SheetNames,
          // Legacy flat data map
          sheetData: legacyData,
          file: path
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          error: `Failed to parse XLSX: ${errorMessage}`,
          errorCode: 'PARSE_ERROR',
          file: path
        }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _parserGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
