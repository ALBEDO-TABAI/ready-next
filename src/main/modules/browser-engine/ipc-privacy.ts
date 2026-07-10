import { ipcMain } from 'electron'
import type {
  ClearBrowsingDataRequest,
  RemoveBrowserCookiePayload,
} from '../../../shared/browser-privacy'
import type { BrowserPrivacyService } from './privacy-service'

export function setupBrowserPrivacyIPC(privacyService: BrowserPrivacyService): void {
  ipcMain.handle('browser:getPrivacySummary', async () => {
    try {
      return { success: true, data: await privacyService.getSummary() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:clearBrowsingData', async (_, payload: ClearBrowsingDataRequest) => {
    try {
      if (!payload || !Array.isArray(payload.dataTypes) || payload.dataTypes.length === 0) {
        return { success: false, error: 'Missing dataTypes' }
      }
      return { success: true, data: await privacyService.clearBrowsingData(payload) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:listCookies', async () => {
    try {
      return { success: true, data: await privacyService.listCookies() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:removeCookie', async (_, payload: RemoveBrowserCookiePayload) => {
    try {
      if (!payload?.domain || !payload?.name) {
        return { success: false, error: 'Missing cookie domain or name' }
      }
      return {
        success: true,
        data: await privacyService.removeCookie({
          domain: payload.domain,
          path: typeof payload.path === 'string' ? payload.path : '/',
          name: payload.name,
          secure: payload.secure === true,
        }),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:removeCookiesForDomain', async (_, payload: { domain: string }) => {
    try {
      if (!payload?.domain) {
        return { success: false, error: 'Missing domain' }
      }
      return { success: true, data: await privacyService.removeCookiesForDomain(payload.domain) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
