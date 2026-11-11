import { BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { BrowserDataService } from './data-service'
import { setupBrowserClipIPC } from './ipc-clip'
import { setupBrowserClipDraggedTabIPC } from './ipc-clip-dragged-tab'
import { setupBrowserContentStudyIPC } from './ipc-content-study-dragged-tab'
import { setupBrowserDataIPC } from './ipc-data'
import { setupBrowserPrivacyIPC } from './ipc-privacy'
import { BrowserPrivacyService } from './privacy-service'
import { setupBrowserFastCardIPC } from './ipc-fastcard'
import {
  setupBrowserLockOverlayIPC
} from './ipc-browser-lock-overlay'
import { setupBrowserShellIPC } from './ipc-shell'
import { setupBrowserSupervisionIPC } from './ipc-supervision'
import { BrowserController } from './browser-controller'

export { BrowserController } from './browser-controller'
export type { BrowserTabActivity, BrowserTabOwner } from './browser-controller-contract-base'
export { isAllowedBrowserURL } from './popup-policy'

export function setupBrowserIPC(
  mainWindow: BrowserWindow,
  useMock = false,
  options?: { preloadPath?: string; rendererFile?: string },
): BrowserController {
  const controller = new BrowserController(mainWindow, useMock)
  const browserDataService = new BrowserDataService()
  setupBrowserShellIPC(controller)
  setupBrowserSupervisionIPC(controller)
  setupBrowserDataIPC(controller, browserDataService)
  setupBrowserPrivacyIPC(new BrowserPrivacyService({
    getSession: () => session.fromPartition('persist:browser'),
    data: browserDataService,
  }))
  setupBrowserClipIPC({
    getActiveTab: () => {
      const active = controller.getActiveTab()
      if (!active) return undefined
      return {
        id: active.id,
        url: active.url,
        title: active.title,
        domain: active.domain,
      }
    },
    getTab: (tabId) => {
      const tab = controller.tabs.get(tabId)
      if (!tab) return undefined
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        domain: tab.domain,
      }
    },
    executeJS: (tabId, code) => controller.executeJS(tabId, code),
  })
  setupBrowserClipDraggedTabIPC({
    sendToRenderer: (_channel, data) => controller.sendToRenderer('clip:backgroundUpdate', data),
  })
  setupBrowserContentStudyIPC({
    sendToRenderer: (channel, data) => {
      if (channel === 'clip:backgroundUpdate') {
        controller.sendToRenderer('clip:backgroundUpdate', data)
        return
      }
      if (channel === 'clip:contentStudyUpdate') {
        controller.sendToRenderer('clip:contentStudyUpdate', data)
      }
    },
  })
  setupBrowserFastCardIPC({
    getMainWindow: () => controller.getMainWindow(),
    preloadPath: options?.preloadPath || join(__dirname, '../preload/index.mjs'),
    rendererFile: options?.rendererFile || join(__dirname, '../renderer/index.html'),
  })
  setupBrowserLockOverlayIPC({
    getMainWindow: () => controller.getMainWindow(),
    preloadPath: options?.preloadPath || join(__dirname, '../preload/index.mjs'),
    rendererFile: options?.rendererFile || join(__dirname, '../renderer/index.html'),
  })

  return controller
}
