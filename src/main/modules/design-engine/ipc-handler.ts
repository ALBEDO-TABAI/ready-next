import { ipcMain, BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'

interface DesignWritePayload {
  path: string
  data: unknown
}

interface DesignSaveAsPayload {
  defaultPath?: string
  data?: unknown
}

interface DesignExportPayload {
  path?: string
  format: 'png' | 'svg'
  data: string
  defaultName?: string
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function normalizeSavePath(filePath: string, ext: string): string {
  return extname(filePath).toLowerCase() === ext ? filePath : `${filePath}${ext}`
}

export function setupDesignIPC(): void {
  ipcMain.handle('design:read', async (_, path: string) => {
    try {
      if (!existsSync(path)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND' }
      }
      const raw = readFileSync(path, 'utf-8')
      if (!raw.trim()) {
        return { success: true, data: null }
      }
      return { success: true, data: JSON.parse(raw) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), errorCode: 'PARSE_ERROR' }
    }
  })

  ipcMain.handle('design:write', async (_, payload: DesignWritePayload) => {
    try {
      const { path, data } = payload
      ensureParentDir(path)
      writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), errorCode: 'WRITE_ERROR' }
    }
  })

  ipcMain.handle('design:saveAs', async (_, payload?: DesignSaveAsPayload) => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { success: false, error: 'No window' }

      const result = await dialog.showSaveDialog(win, {
        title: '另存为设计文件',
        defaultPath: payload?.defaultPath,
        filters: [{ name: 'TLDraw File', extensions: ['tldr'] }],
      })

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'cancelled' }
      }

      const filePath = normalizeSavePath(result.filePath, '.tldr')
      if (payload?.data !== undefined) {
        ensureParentDir(filePath)
        writeFileSync(filePath, JSON.stringify(payload.data, null, 2), 'utf-8')
      }

      return { success: true, path: filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), errorCode: 'SAVE_AS_ERROR' }
    }
  })

  ipcMain.handle('design:export', async (_, payload: DesignExportPayload) => {
    try {
      const { format, data, defaultName } = payload

      let outputPath = payload.path
      if (!outputPath) {
        const win = BrowserWindow.getFocusedWindow()
        if (!win) return { success: false, error: 'No window' }

        const saveResult = await dialog.showSaveDialog(win, {
          title: `导出 ${format.toUpperCase()}`,
          defaultPath: defaultName ? join(process.cwd(), defaultName) : undefined,
          filters: [{
            name: format.toUpperCase(),
            extensions: [format]
          }],
        })

        if (saveResult.canceled || !saveResult.filePath) {
          return { success: false, error: 'cancelled' }
        }
        outputPath = normalizeSavePath(saveResult.filePath, `.${format}`)
      }

      ensureParentDir(outputPath)

      if (format === 'svg') {
        writeFileSync(outputPath, data, 'utf-8')
      } else {
        const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data
        writeFileSync(outputPath, Buffer.from(base64, 'base64'))
      }

      return { success: true, path: outputPath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), errorCode: 'EXPORT_ERROR' }
    }
  })
}
