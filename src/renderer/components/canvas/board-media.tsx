import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Paperclip, RefreshCw } from 'lucide-react'
import type { CanvasOpen } from '../../../main/modules/board-engine/canvas-service'
import type { CanvasCommand, CanvasNode, CanvasOperation } from '../../../shared/ready-canvas'
import { clipboardImageFiles, intakeFiles, intakeKind, measureMedia, transferFiles, AUDIO_CARD } from '../../modules/canvas/media-intake'
import { createLinkPreviews } from '../../modules/canvas/link-preview-cache'
import { stopAudio } from '../../modules/canvas/audio-player'
import { toLocalFileUrl } from '../../utils/dragDrop'
import { showToast, type MenuEntry } from '../ui'
import { AudioCard } from './cards/AudioCard'
import { ImageCard, VideoCard } from './cards/ImageCard'
import { LinkCard, type LinkPreviewData } from './cards/LinkCard'
import { RecordTool } from './surface/RecordTool'
import { boardSlides, closeSlideshow, openSlideshow } from './surface/Slideshow'

// Media on a board document (M4 2026-11-14): recording, files dropped / pasted / picked, the media cards, the
// slideshow and link previews with their covers. One hook, so the board document and the shared surface files
// carry only a few lines each; everything it writes goes through the board's handle like any other edit.

/** What the surface lends its host: its undoable commit, where the person is looking, the selection, its element. */
export interface CanvasSurfaceApi {
  commit(operations: CanvasOperation[]): Promise<boolean>
  centre(): { x: number; y: number }
  select(ids: string[]): void
  element(): HTMLElement | null
}
const confirmed = <T,>(result: { ok: true; value: T } | { ok: false; error: string }): T => { if (!result.ok) throw new Error(result.error.replace(/^Error:\s*/, '')); return result.value }
const PICK_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,audio/*,video/mp4,video/quicktime,video/webm,.md,.markdown,.txt'
/** The system file picker (文件…): only what the person picks comes back. */
export function pickFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'; input.multiple = true; input.accept = PICK_ACCEPT
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

export function useBoardMedia({ opened, root, write, report, pick = pickFiles }: {
  opened: CanvasOpen | null; root: string
  write(commands: CanvasCommand[]): Promise<void>; report(cause: unknown): void
  pick?: () => Promise<File[]>
}) {
  const api = window.electronAPI, objectId = opened?.objectId
  const surface = useRef<CanvasSurfaceApi | null>(null), latest = useRef({ opened, write, report })
  latest.current = { opened, write, report }
  const [transcriptionAvailable, setTranscriptionAvailable] = useState<boolean>()
  useEffect(() => {
    let current = true
    void api.canvasMedia.transcription().then(result => { if (current && result.ok) setTranscriptionAvailable(result.value.available) }, () => undefined)
    return () => { current = false }
  }, [api])
  // The board closed or changed: nothing keeps playing, no slideshow of another board stays up.
  useEffect(() => () => { stopAudio(); closeSlideshow() }, [objectId])
  const pointerDown = useRef(false)
  useEffect(() => {
    const down = () => { pointerDown.current = true }, up = () => { pointerDown.current = false }
    window.addEventListener('pointerdown', down, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true) }
  }, [])
  const resolveAsset = useCallback((path: string) => root ? toLocalFileUrl(`${root}/${path}`) : undefined, [root])

  const add = useCallback(async (files: readonly File[], at: { x: number; y: number }, options?: Parameters<typeof intakeFiles>[3]) => {
    const { opened, write } = latest.current
    if (!opened) throw new Error('画板尚未打开')
    const result = await intakeFiles(files, at, { boardPath: opened.path, write, measure: measureMedia,
      stage: async input => confirmed(await api.canvasMedia.stage(input)) }, options)
    surface.current?.select(result.nodeIds)
    if (result.skipped.length) showToast(`有 ${result.skipped.length} 个文件不是画板接收的类型，没有放入`)
  }, [api])

  // A link's preview is kept on its card. A first read fills it once, when nothing else is happening on the board
  // (no pointer down, no write in flight), as an ordinary undoable edit; 刷新预览 replaces it.
  const previews = useMemo(() => createLinkPreviews(async url => {
    if (!objectId) throw new Error('画板尚未打开')
    return confirmed(await api.canvasMedia.linkPreview({ objectId, url }))
  }), [api, objectId])
  const filled = useRef(new Set<string>())
  useEffect(() => { filled.current = new Set() }, [objectId])
  const keep = useCallback(async (nodeId: string, preview: LinkPreviewData, force: boolean): Promise<boolean> => {
    const board = latest.current.opened?.objectId
    for (let attempt = 0; attempt < 20 && latest.current.opened?.objectId === board; attempt++) {
      const node = latest.current.opened?.canvas.nodes.find(item => item.id === nodeId)
      if (!node || node.type !== 'link' || node.ready.trash || (!force && node.ready.preview?.fetchedAt)) return false
      if (!pointerDown.current && surface.current) {
        const { title, description, site, image } = preview
        const next = { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(site ? { site } : {}), ...(image ? { image } : {}), fetchedAt: preview.fetchedAt ?? new Date().toISOString() }
        if (await surface.current.commit([{ type: 'replaceNode', node: { ...node, ready: { ...node.ready, preview: next } } }])) return true
      }
      await new Promise(resolve => setTimeout(resolve, 600))
    }
    return false
  }, [])
  const onPreview = useCallback((node: CanvasNode, preview: LinkPreviewData) => {
    if (filled.current.has(node.id)) return
    filled.current.add(node.id)
    void keep(node.id, preview, false)
  }, [keep])

  const renderCard = (node: CanvasNode): ReactNode | undefined => {
    if (node.ready.ref?.kind === 'event') return undefined
    if (node.type === 'link') return <LinkCard node={node} source={previews} resolveAsset={resolveAsset} onPreview={onPreview} />
    if (node.type !== 'file') return undefined
    const src = resolveAsset(node.file)
    if (node.ready.kind === 'audio') return <AudioCard node={node} src={src} transcriptionAvailable={transcriptionAvailable} />
    if (node.ready.kind === 'image') return <ImageCard node={node} src={src} />
    if (node.ready.kind === 'video') return <VideoCard node={node} src={src} />
    return undefined
  }
  const fail = (cause: unknown) => latest.current.report(cause)
  return {
    surfaceApi: (value: CanvasSurfaceApi | null) => { surface.current = value },
    renderCard, add,
    dockTools: <RecordTool report={fail} onRecorded={(file, durationMs) => {
      const centre = surface.current?.centre() ?? { x: 0, y: 0 }
      return add([file], { x: centre.x - AUDIO_CARD.width / 2, y: centre.y - AUDIO_CARD.height / 2 }, { durationMs, capturedAt: new Date(), title: '录音' })
    }} />,
    acceptsDrop: (types: readonly string[]) => types.includes('Files'),
    /** Files dropped from Finder; true when the drop carried files (the cards are written in the background). */
    dropFiles(data: DataTransfer, at: { x: number; y: number }): boolean {
      const files = transferFiles(data)
      if (!files.length) return false
      void add(files, at).catch(fail)
      return true
    },
    /** Pictures or files on the clipboard become cards; false when the clipboard carries none (text, a link). */
    async pasteMedia(at: { x: number; y: number }, data: DataTransfer | null): Promise<boolean> {
      const files = (data ? transferFiles(data) : await clipboardImageFiles()).filter(file => intakeKind(file))
      if (!files.length) return false
      await add(files, { x: at.x - 150, y: at.y - 100 })
      return true
    },
    /** Double-click on a picture: the slideshow. */
    openNode(node: CanvasNode): boolean {
      const board = latest.current.opened
      if (!board || node.type !== 'file' || node.ready.kind !== 'image') return false
      openSlideshow(boardSlides(board.canvas, resolveAsset), node.id, () => surface.current?.element() ?? null, () => surface.current?.element()?.focus({ preventScroll: true }))
      return true
    },
    cardItems(nodes: CanvasNode[]): MenuEntry[] {
      const node = nodes.length === 1 ? nodes[0] : undefined
      if (!node || node.type !== 'link' || node.ready.ref?.kind === 'event') return []
      return [{ id: 'refresh-preview', label: '刷新预览', icon: <RefreshCw />, onSelect: () => {
        void previews.refresh(node.url).then(preview => keep(node.id, preview, true)).then(done => showToast(done ? '已刷新预览' : '画板正忙，预览没有保存，请再试一次'), fail)
      } }]
    },
    newItems: (at: { x: number; y: number }): MenuEntry[] => [{ id: 'file', label: '文件…', icon: <Paperclip />, onSelect: () => {
      void pick().then(files => files.length ? add(files, { x: at.x - 130, y: at.y - 40 }) : undefined).catch(fail)
    } }],
  }
}
