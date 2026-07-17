import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IpcMain } from 'electron'

import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

export type ParserGroupDeps = Pick<
  EngineDeps,
  | 'useMock'
  | 'getDocumentWriteIndexHook'
  | 'parseDocxInWorker'
  | 'parseXlsxInWorker'
  | 'importEbookInWorker'
>

const CHANNELS = [
  'document:parseDocx',
  'document:parseXlsx',
  'document:importEbookAsMarkdown',
] as const

function getErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return fallback
}

export const parserGroup: IpcChannelGroup<ParserGroupDeps> = {
  namespace: 'document:parser',

  register(ipcMain: IpcMain, deps: ParserGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* handler may not exist */ }
    }

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
        if (!sourcePath) return { success: false, error: '缺少电子书路径', errorCode: 'INVALID_INPUT' }
        const result = await deps.importEbookInWorker(sourcePath) as {
          success?: boolean
          indexPath?: string
          [key: string]: unknown
        }
        const writeIndexHook = deps.getDocumentWriteIndexHook()
        if (result.success && result.indexPath && writeIndexHook) {
          try {
            writeIndexHook(result.indexPath, await readFile(result.indexPath, 'utf-8'))
          } catch (hookError) {
            console.warn('[document-engine] ebook import index hook failed', hookError)
          }
        }
        return result
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          errorCode: getErrorCode(error, 'EBOOK_IMPORT_FAILED'),
        }
      }
    })

    ipcMain.handle('document:parseDocx', async (_, path: string) => {
      if (deps.useMock) {
        return {
          success: true,
          data: {
            html: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
            rawText: '[Mock] DOCX parsing requires mammoth.js',
          },
          content: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
          html: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
          mock: true,
        }
      }
      try {
        return await deps.parseDocxInWorker(path)
      } catch (error) {
        return {
          success: false,
          error: `Failed to parse DOCX: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: getErrorCode(error, 'PARSE_ERROR'),
          file: path,
        }
      }
    })

    ipcMain.handle('document:parseXlsx', async (_, path: string) => {
      if (deps.useMock) {
        return {
          success: true,
          data: { sheets: [{ name: 'Sheet1', data: [['A1', 'B1'], ['A2', 'B2']] }] },
          sheets: ['Sheet1'],
          file: path,
          mock: true,
        }
      }
      try {
        return await deps.parseXlsxInWorker(path)
      } catch (error) {
        return {
          success: false,
          error: `Failed to parse XLSX: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: getErrorCode(error, 'PARSE_ERROR'),
          file: path,
        }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* already removed */ }
        }
      },
    }
  },
}

export const _parserGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
