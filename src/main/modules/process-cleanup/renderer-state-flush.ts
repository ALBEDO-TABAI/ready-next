import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { RendererStateFlushCoordinator } from './renderer-state-flush-coordinator'

const coordinator = new RendererStateFlushCoordinator({ createRequestId: randomUUID })

export function setupRendererStateFlushIPC(): void {
  ipcMain.removeAllListeners('app:beforeQuitFlushed')
  coordinator.settleAll()
  ipcMain.on('app:beforeQuitFlushed', (event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    coordinator.acknowledge(requestId, event.sender.id)
  })
}

export function requestRendererStateFlush(mainWindow: BrowserWindow | null, timeoutMs = 3_000): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return Promise.resolve()
  return coordinator.request({
    id: mainWindow.webContents.id,
    send: (requestId) => mainWindow.webContents.send('app:flushBeforeQuit', requestId),
  }, timeoutMs)
}
