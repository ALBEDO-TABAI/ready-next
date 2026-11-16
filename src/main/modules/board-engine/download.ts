import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { z } from 'zod'
import { AssetPathSchema, CanvasIdSchema, DOWNLOAD_LIMITS, planBoardDownload, type CanvasDownloadResult, type CanvasNode, type DownloadBoard } from '../../../shared/ready-canvas'
import { checkedPath } from '../document-drafts/files'
import { sanitizeExportFolderName } from '../document-engine/export/markdown-bundle'
import { writeZipFile } from '../document-engine/export/zip-file'
import type { ExportSaveDialogRequest } from '../document-engine/ipc/export-group'
import type { CanvasService } from './canvas-service'

// 下载为 ZIP (M4 §11, 2026-11-14): the files themselves of the chosen cards, a sub-board or the whole board. The
// board is named by identity; Main reads it and its sub-boards from the library and only ever opens attachments in a
// board's own `.assets`. The destination is the one the person picks in the save dialog. Nothing in the library changes.

const RequestSchema = z.strictObject({ objectId: CanvasIdSchema, nodeIds: z.array(CanvasIdSchema).max(10000).optional(), suggestedName: z.string().max(200).optional() })
export interface CanvasDownloadDeps {
  showSaveDialog(sender: WebContents, request: ExportSaveDialogRequest): Promise<{ canceled: boolean; filePath?: string }>
  getDefaultDir(): string
  limits?: { files: number; bytes: number }
}
const megabytes = (bytes: number) => bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

export function registerCanvasDownloadIPC(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Promise<{ canvas: CanvasService }>,
  authorize: (event: IpcMainInvokeEvent, path: string) => void, deps: CanvasDownloadDeps): void {
  ipcMain.handle('canvas:downloadZip', async (event, input: unknown): Promise<CanvasDownloadResult> => {
    try {
      const request = RequestSchema.parse(input), { canvas } = await resolve(), limits = deps.limits ?? DOWNLOAD_LIMITS
      authorize(event, canvas.root)
      const open = async (objectId: string): Promise<DownloadBoard> => { const opened = await canvas.open(objectId); canvas.release(opened.handleId); return { path: opened.path, canvas: opened.canvas } }
      const board = await open(request.objectId)
      // Sub-boards are read ahead (the plan is pure): every sub-board card reachable from the chosen cards.
      const children = new Map<string, DownloadBoard | undefined>()
      const gather = async (from: DownloadBoard, depth: number): Promise<void> => {
        for (const node of from.canvas.nodes) {
          if (node.type !== 'file' || node.ready.kind !== 'subcanvas' || node.ready.ref?.kind !== 'canvas' || node.ready.trash || children.has(node.ready.ref.id)) continue
          let next: DownloadBoard | undefined
          try { next = await open(node.ready.ref.id) } catch (error) { console.warn('[canvas] download: sub-board unavailable', node.ready.ref.id, error instanceof Error ? error.message : String(error)) }
          children.set(node.ready.ref.id, next)
          if (next && depth < DOWNLOAD_LIMITS.depth) await gather(next, depth + 1)
        }
      }
      await gather(board, 1)
      const child = (node: CanvasNode) => node.ready.ref?.kind === 'canvas' ? children.get(node.ready.ref.id) : undefined
      const plan = planBoardDownload(board, request.nodeIds ? new Set(request.nodeIds) : undefined, child)
      // Attachments: only a `.assets` path inside the library, no symbolic links; sizes are known before anything is read.
      const assets: Array<{ path: string; location: string }> = []
      let bytes = 0, missing = 0
      for (const entry of plan.entries) {
        if (entry.kind === 'text') { bytes += Buffer.byteLength(entry.text); continue }
        try {
          const location = checkedPath(canvas.root, join(canvas.root, AssetPathSchema.parse(entry.file))), info = await stat(location)
          if (!info.isFile()) throw new Error('not a file')
          bytes += info.size; assets.push({ path: entry.path, location })
        } catch (error) { missing++; console.warn('[canvas] download: attachment unavailable', entry.file, error instanceof Error ? error.message : String(error)) }
      }
      const texts = plan.entries.flatMap(entry => entry.kind === 'text' ? [entry] : []), fileCount = texts.length + assets.length
      if (!fileCount) return { success: false, error: missing ? '这些卡片的附件文件已不在资料库里，没有可下载的内容' : '这些卡片没有可下载的文件（文档卡、图形和分组不含文件）' }
      if (fileCount > limits.files) return { success: false, error: `要下载的文件有 ${fileCount} 个，超过一次 ${limits.files} 个的上限；请分批选择后再下载` }
      if (bytes > limits.bytes) return { success: false, error: `要下载的文件共 ${megabytes(bytes)}，超过一次 ${megabytes(limits.bytes)} 的上限；请分批选择后再下载` }
      const name = sanitizeExportFolderName(request.suggestedName?.trim().replace(/\.zip$/i, '') || board.canvas.ready.title || '画板')
      const destination = await deps.showSaveDialog(event.sender, { title: '下载为 ZIP', defaultPath: join(deps.getDefaultDir(), `${name}.zip`), filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }] })
      if (destination.canceled || !destination.filePath) return { success: false, canceled: true }
      const zip = new JSZip()
      for (const folder of plan.folders) zip.folder(folder.slice(0, -1))
      for (const entry of texts) zip.file(entry.path, entry.text)
      // Media is already compressed: stored as it is, byte for byte.
      for (const asset of assets) zip.file(asset.path, await readFile(asset.location), { compression: 'STORE' })
      await writeZipFile(zip, destination.filePath)
      return { success: true, path: destination.filePath, fileCount, skipped: plan.skipped.length, missing }
    } catch (error) {
      return { success: false, error: `下载失败：${(error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, '')}` }
    }
  })
}
