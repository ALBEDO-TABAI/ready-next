import { app, BrowserWindow, dialog, ipcMain, type FileFilter } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ReadyBoardAssetKind } from '../../../shared/ready-board'
import {
  ReadyBoardService,
  type BoardServiceResponse,
} from './board-service'
import { broadcastDirectoryChanged } from '../document-engine/ipc/directory-change-broadcast'

const BOARD_CHANNELS = [
  'board:create',
  'board:open',
  'board:setActive',
  'board:save',
  'board:ackExternalAssets',
  'board:importAsset',
  'board:importRemoteImage',
  'board:pickAsset',
  'board:openInDocument',
] as const

type PickAssetKind = ReadyBoardAssetKind | 'any'

interface BoardIPCOptions {
  getMainWindow: () => BrowserWindow | null
}

function templatePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'board', 'board-template.html')
    : join(app.getAppPath(), 'assets', 'board', 'board-template.html')
}

async function readBoardTemplate(): Promise<string> {
  const path = templatePath()
  if (!existsSync(path)) {
    throw new Error(`Board template not found: ${path}`)
  }
  return readFile(path, 'utf8')
}

function filtersForKind(kind: PickAssetKind | undefined): FileFilter[] {
  if (kind === 'image') {
    return [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'] },
      { name: '所有文件', extensions: ['*'] },
    ]
  }
  if (kind === 'video') {
    return [
      { name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogg'] },
      { name: '所有文件', extensions: ['*'] },
    ]
  }
  if (kind === 'markdown') {
    return [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: '所有文件', extensions: ['*'] },
    ]
  }
  return [
    { name: '画板素材', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'mp4', 'webm', 'mov', 'm4v', 'ogg', 'md', 'markdown'] },
    { name: '所有文件', extensions: ['*'] },
  ]
}

let service: ReadyBoardService | null = null

export function getReadyBoardService(): ReadyBoardService {
  if (!service) {
    service = new ReadyBoardService({
      readTemplate: readBoardTemplate,
      onDirectoryChanged: (paths) => broadcastDirectoryChanged(paths),
    })
  }
  return service
}

async function wrap<T>(work: () => Promise<BoardServiceResponse<T>>): Promise<BoardServiceResponse<T>> {
  try {
    return await work()
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'BOARD_IPC_ERROR',
    }
  }
}

export function setupBoardIPC(options: BoardIPCOptions): void {
  for (const channel of BOARD_CHANNELS) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
  }

  ipcMain.handle('board:create', async (_, payload: { parentDir?: string }) => {
    const parentDir = String(payload?.parentDir || '').trim()
    return wrap(() => getReadyBoardService().create(parentDir))
  })

  ipcMain.handle('board:open', async (_, payload: { path?: string }) => {
    const path = String(payload?.path || '').trim()
    return wrap(() => getReadyBoardService().open(path))
  })

  ipcMain.handle('board:setActive', (_, payload: { boardId?: string | null; expectedBoardId?: string }) => {
    return getReadyBoardService().setActive(payload?.boardId || null, payload?.expectedBoardId)
  })

  ipcMain.handle('board:save', async (_, payload: { boardId?: string; state?: unknown }) => {
    const boardId = String(payload?.boardId || '').trim()
    return wrap(() => getReadyBoardService().save(boardId, payload?.state))
  })

  ipcMain.handle('board:ackExternalAssets', async (_, payload: { boardId?: string; receiptIds?: unknown }) => {
    const boardId = String(payload?.boardId || '').trim()
    const receiptIds = Array.isArray(payload?.receiptIds)
      ? payload.receiptIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []
    return wrap(() => getReadyBoardService().acknowledgeExternalAssets(boardId, receiptIds))
  })

  ipcMain.handle('board:importAsset', async (_, payload: { boardId?: string; srcPath?: string; kind?: ReadyBoardAssetKind }) => {
    const boardId = String(payload?.boardId || '').trim()
    const srcPath = String(payload?.srcPath || '').trim()
    return wrap(() => getReadyBoardService().importAsset(boardId, srcPath, payload?.kind))
  })

  ipcMain.handle('board:importRemoteImage', async (_, payload: { boardId?: string; url?: string }) => {
    const boardId = String(payload?.boardId || '').trim()
    const url = String(payload?.url || '').trim()
    return wrap(() => getReadyBoardService().importRemoteImage(boardId, url))
  })

  ipcMain.handle('board:pickAsset', async (event, payload: { boardId?: string; kind?: PickAssetKind }) => {
    const boardId = String(payload?.boardId || '').trim()
    const win = BrowserWindow.fromWebContents(event.sender) || options.getMainWindow()
    if (!win || win.isDestroyed()) {
      return { success: false, error: '主窗口不可用', errorCode: 'NO_WINDOW' }
    }
    const kind = payload?.kind || 'any'
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'image' ? '添加图片' : kind === 'video' ? '添加视频' : kind === 'markdown' ? '添加 Markdown' : '添加画板素材',
      properties: ['openFile'],
      filters: filtersForKind(kind),
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'cancelled', errorCode: 'CANCELLED' }
    }
    const requestedKind = kind === 'any' ? undefined : kind
    return wrap(() => getReadyBoardService().importAsset(boardId, result.filePaths[0], requestedKind))
  })

  ipcMain.handle('board:openInDocument', async (_, payload: { boardId?: string; relativePath?: string }) => {
    const boardId = String(payload?.boardId || '').trim()
    const relativePath = String(payload?.relativePath || '').trim()
    return wrap(() => getReadyBoardService().openInDocument(boardId, relativePath))
  })
}
