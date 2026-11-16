import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { CanvasIdSchema, type NodeReady } from '../../../shared/ready-canvas'
import type { FastCardMediaCache } from '../fastcard/media-cache'
import { getLinkPreview, persistLinkPreview, type LinkPreview } from '../link-preview'
import { stagedAttachment, type StagedKind } from './attachment-staging'
import type { CanvasService } from './canvas-service'

// Media on a board (M4 2026-11-14 contract): staging bytes for an attachment and keeping a link's preview with its
// cover in the board's attachments. The board does not transcribe (M4 §11, decided 2026-11-14).

export interface CanvasMediaDependencies {
  cache: FastCardMediaCache
  /** The shared link-preview service (private-network and size protections live there); replaced in tests. */
  preview?: (url: string) => Promise<LinkPreview>
}
export type CanvasMediaResult<T> = { ok: true; value: T } | { ok: false; error: string }
export interface StagedAttachmentReceipt { token: string; kind: StagedKind; mime: string; sha256: string; size: number }
export interface CanvasMediaAPI {
  /** Validates the bytes (type from content, size limits) and holds them for one `importAttachment` board write. */
  stage(input: { name: string; mime: string; bytes: Uint8Array }): Promise<CanvasMediaResult<StagedAttachmentReceipt>>
  /** Fetches the page's preview and copies its cover into the board's attachments; the caller writes it to the card. */
  linkPreview(input: { objectId: string; url: string }): Promise<CanvasMediaResult<NonNullable<NodeReady['preview']>>>
}

export function registerCanvasMediaIPC(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Promise<{ canvas: CanvasService }>,
  authorize: (event: IpcMainInvokeEvent, path: string) => void, dependencies: CanvasMediaDependencies): void {
  const reply = async <T>(event: IpcMainInvokeEvent, work: (canvas: CanvasService) => T | Promise<T>) => {
    try { const { canvas } = await resolve(); authorize(event, canvas.root); return { ok: true, value: await work(canvas) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle('canvasMedia:stage', (event, input: unknown) => reply(event, canvas => {
    const staged = stagedAttachment(input)
    return { token: canvas.stageAttachment(staged.bytes, staged.name), kind: staged.kind, mime: staged.mime, sha256: staged.sha256, size: staged.bytes.length }
  }))
  ipcMain.handle('canvasMedia:linkPreview', (event, input: unknown) => reply(event, async canvas => {
    const request = z.strictObject({ objectId: CanvasIdSchema, url: z.url().max(8192) }).parse(input)
    // The board's own location, from its identity: the renderer never names a path to write to.
    const opened = await canvas.open(request.objectId); canvas.release(opened.handleId)
    const target = { libraryRoot: canvas.root, relativePath: opened.path }
    const preview = await (dependencies.preview ?? getLinkPreview)(request.url)
    try { return await persistLinkPreview(preview, dependencies.cache, target) ?? {} }
    catch (error) {
      // A cover that cannot be fetched (blocked address, too large, not an image) does not cost the card its text.
      if (!preview.imageUrl) throw error
      return await persistLinkPreview({ ...preview, imageUrl: undefined }, dependencies.cache, target) ?? {}
    }
  }))
}
