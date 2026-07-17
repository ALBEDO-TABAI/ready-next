import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { RendererStateFlushOutcome } from '../../../shared/renderer-state-flush'
import {
  DEFAULT_RENDERER_STATE_FLUSH_TIMEOUT_MS,
  RendererStateFlushCoordinator,
  type RendererStateFlushLease,
} from './renderer-state-flush-coordinator'

const coordinator = new RendererStateFlushCoordinator({ createRequestId: randomUUID })

export function setupRendererStateFlushIPC(): void {
  ipcMain.removeAllListeners('app:beforeQuitFlushed')
  coordinator.settleAll()
  ipcMain.on('app:beforeQuitFlushed', (event, requestId: unknown, outcome: unknown) => {
    if (typeof requestId !== 'string') return
    const parsed = outcome as Partial<RendererStateFlushOutcome> | null
    if (!parsed || typeof parsed.success !== 'boolean') return
    if (parsed.success === false && typeof parsed.error !== 'string') return
    coordinator.acknowledge(requestId, event.sender.id, parsed as RendererStateFlushOutcome)
  })
}

export function requestRendererStateFlush(
  mainWindow: BrowserWindow | null,
  timeoutMs = DEFAULT_RENDERER_STATE_FLUSH_TIMEOUT_MS,
): Promise<RendererStateFlushLease> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.resolve({ release: () => undefined })
  }
  return coordinator.request({
    id: mainWindow.webContents.id,
    send: (requestId) => mainWindow.webContents.send('app:flushBeforeQuit', requestId),
    cancel: (requestId) => {
      if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('app:cancelBeforeQuitFlush', requestId)
      }
    },
  }, timeoutMs)
}
