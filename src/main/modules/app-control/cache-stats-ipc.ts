/**
 * Cache stats / cleanup IPC handlers (D1).
 *
 * Wires `app:getCacheStats` and `app:clearCache` to the pure core in
 * `cache-stats-core.ts`. The core handles fs walking + size aggregation +
 * directory removal; this wrapper just supplies real Electron + Node deps.
 */
import { tmpdir } from 'node:os'
import { ipcMain, app, session, shell } from 'electron'

import {
  getCacheStatsCore,
  clearCacheCore,
  type CacheStats,
  type CacheClearResult,
} from './cache-stats-core'
import { createDiagnosticPack, type DiagnosticPackResult, type DiagnosticRawDb } from './diagnostic-pack-core'
import { getDatabase } from '../database'

interface IPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

interface ClearCachePayload {
  includePuppeteer?: boolean
}

export function setupAppCacheIPC(): void {
  ipcMain.handle('app:getCacheStats', async (): Promise<IPCResponse<CacheStats>> => {
    try {
      const userData = app.getPath('userData')
      const data = getCacheStatsCore(userData)
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(
    'app:clearCache',
    async (_, payload: ClearCachePayload | undefined): Promise<IPCResponse<CacheClearResult>> => {
      try {
        const userData = app.getPath('userData')
        const result = await clearCacheCore({
          userDataPath: userData,
          includePuppeteer: payload?.includePuppeteer === true,
          clearChromiumCache: async () => {
            await session.defaultSession.clearCache()
          },
        })
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle('app:exportDiagnosticPack', async (): Promise<IPCResponse<DiagnosticPackResult>> => {
    try {
      let rawDb: DiagnosticRawDb | null = null
      try {
        rawDb = getDatabase().getRawDb()
      } catch {
        rawDb = null
      }
      const result = await createDiagnosticPack({
        outputDir: app.getPath('downloads'),
        logDir: tmpdir(),
        appInfo: {
          appName: app.getName(),
          appVersion: app.getVersion(),
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          userDataPath: app.getPath('userData'),
          logsPath: tmpdir(),
          platform: process.platform,
          arch: process.arch,
          versions: process.versions,
        },
        rawDb,
      })
      shell.showItemInFolder(result.path)
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
