import type { IpcMain, Rectangle, WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CanvasExportImageResult } from '../../../shared/ready-canvas/export-image'
import { sanitizeExportFolderName } from '../document-engine/export/markdown-bundle'
import type { ExportSaveDialogRequest } from '../document-engine/ipc/export-group'

const requestSchema = z.strictObject({
  rect: z.strictObject({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }),
  suggestedName: z.string().optional(),
})
export interface CanvasImageExportDeps {
  contentSize(sender: WebContents): [number, number]
  showSaveDialog(sender: WebContents, request: ExportSaveDialogRequest): Promise<{ canceled: boolean; filePath?: string }>
  getFallbackExportDir(): string
}
function clipRect(rect: Rectangle, [width, height]: [number, number]): Rectangle {
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(width, Math.ceil(rect.x + rect.width)), bottom = Math.min(height, Math.ceil(rect.y + rect.height))
  if (right <= x || bottom <= y) throw new Error('截图区域不在当前窗口内')
  return { x, y, width: right - x, height: bottom - y }
}
export function registerCanvasImageExportIPC(ipcMain: Pick<IpcMain, 'handle'>, deps: CanvasImageExportDeps): void {
  ipcMain.handle('canvas:exportImage', async (event, input: unknown): Promise<CanvasExportImageResult> => {
    try {
      const parsed = requestSchema.safeParse(input)
      if (!parsed.success) return { success: false, error: '截图区域无效：坐标必须是有限数字，宽高必须大于零' }
      const { rect, suggestedName } = parsed.data
      const bounds = clipRect(rect, deps.contentSize(event.sender))
      // Capture before the dialog changes focus; never look up or capture another window.
      const image = await event.sender.capturePage(bounds)
      if (image.isEmpty()) throw new Error('没有截取到画板画面')
      const name = sanitizeExportFolderName(suggestedName?.trim().replace(/\.png$/i, '') || '画板')
      const destination = await deps.showSaveDialog(event.sender, { title: '导出为 PNG',
        defaultPath: join(deps.getFallbackExportDir(), `${name}.png`), filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
      if (destination.canceled || !destination.filePath) return { success: false, canceled: true }
      await writeFile(destination.filePath, image.toPNG())
      return { success: true, path: destination.filePath }
    } catch (error) {
      return { success: false, error: `画板导出失败：${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
