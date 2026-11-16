import type { ReactNode } from 'react'
import type { FloatAnchor, MenuEntry } from '../../ui'
import type { CanvasNode, Graphic, ReadyCanvas } from '../../../../shared/ready-canvas/schema'
import type { CanvasInverse, CanvasOperation } from '../../../../shared/ready-canvas/operations'
import type { Camera, Rect } from '../../../modules/canvas/interaction/geometry'

export interface GraphicDraft extends Rect { id: string; graphic: Graphic }
export interface FrameWork { kind: string; candidates: number; visited: number; domWrites: number }
export interface CanvasSurfaceProps extends CanvasSurfaceMediaProps {
  canvas: ReadyCanvas
  /** Resolve only when the caller accepts this batch into its authoritative buffer. Reject on failure.
   * This acknowledgement does not claim disk persistence. Main saving belongs to the caller. */
  onOperations: (operations: CanvasOperation[], context: { objectId: string; before: ReadyCanvas; after: ReadyCanvas; inverse: CanvasInverse[]; direction: 'edit' | 'undo' | 'redo' }) => void | Promise<void>
  /** Prepare the derived SVG attachment before a graphic add/resize operation is emitted. */
  prepareGraphic?: (draft: GraphicDraft) => Promise<string>
  renderTextEditor?: (context: { node: CanvasNode; commit: (operations: CanvasOperation[]) => Promise<boolean>; close: () => void }) => ReactNode
  renderCard?: (node: CanvasNode) => ReactNode
  onScheduleNode?: (node: CanvasNode) => void
  /** Sends the selected cards to the AI chat as a structured, read-only selection. */
  onAskAI?: (nodeIds: string[]) => Promise<void>
  onAddToDocument?: (nodeIds: string[]) => Promise<void>
  resolveAsset?: (path: string) => string | undefined
  onOpenNode?: (node: CanvasNode) => void
  onNavigateSubcanvas?: (node: CanvasNode) => void
  breadcrumbs?: Array<{ id: string; title: string }>
  onNavigateAncestor?: (id: string) => void
  revealNode?: { nodeId?: string; requestId: string }
  initialCamera?: Camera
  onFrameWork?: (work: FrameWork) => void
  /** More 新建 items on the canvas's right-click menu (链接, 文档卡, 子画板), placed at the clicked world point. A follow-up
   * form opens as its own float at `place.anchor` (the pointer), kept inside `place.bounds` (the board). */
  extraNewItems?: (at: { x: number; y: number }, place: { anchor: FloatAnchor; bounds: () => FloatAnchor }) => MenuEntry[]
  /** Sub-boards (M4 §9): the host moves cards between this board and its sub-boards; what is absent is not offered.
   * `undo` takes back the last cross-board move and is used when the board's own history is empty. */
  subBoards?: {
    collect?(nodeIds: string[]): void; moveOut?(nodeIds: string[]): void; moveInto?(nodeIds: string[], target: CanvasNode): void
    openParent?(): void; undo?(): void
  }
  /** More entries for the corner's 更多 menu, after the exports. */
  moreItems?: MenuEntry[]
  /** Drops the host understands (FastCard items, pages from the sidebar): return true when handled. */
  onDropData?: (data: DataTransfer, at: { x: number; y: number }) => boolean
  acceptsDrop?: (types: readonly string[]) => boolean
  /** 导出 Markdown / PDF of the chosen cards, or the whole board when none are chosen. */
  onExport?: (kind: 'md' | 'pdf', nodeIds: string[]) => Promise<void>
  /** 下载为 ZIP: the files themselves of the chosen cards (a sub-board card: its whole board as a folder), or of the whole board when none are chosen. */
  onDownload?: (nodeIds: string[]) => Promise<void>
  /** Save the given window rectangle as a PNG (Main captures it); the surface hides its chrome and frames the cards first. */
  captureImage?: (rect: { x: number; y: number; width: number; height: number }, title: string) => Promise<void>
}
// [cv-media] What the host adds for media (M4 2026-11-14); see components/canvas/board-media.tsx.
export interface CanvasSurfaceMediaProps {
  /** More tools in the dock (the record tool), after the drawing tools. */
  dockTools?: ReactNode
  /** More items on a card's right-click menu, for the chosen cards (刷新预览). */
  extraCardItems?: (nodes: CanvasNode[]) => MenuEntry[]
  /** Paste clipboard files or pictures onto the board at a world point; resolves true when it placed something.
   * `data` is the paste event's transfer (read synchronously), or null to read the system clipboard. Call it first
   * from any paste handler; text and links are the caller's when it resolves false. */
  onPasteMedia?: (at: { x: number; y: number }, data: DataTransfer | null) => Promise<boolean>
  /** The surface lends its undoable commit, the view centre (world), the selection and its element; null on unmount. */
  surfaceApi?: (api: { commit(operations: CanvasOperation[]): Promise<boolean>; centre(): { x: number; y: number }; select(ids: string[]): void; element(): HTMLElement | null } | null) => void
}
// [/cv-media]
export type Tool = 'select' | 'pan' | 'rect' | 'arrow' | 'edge' | 'path'
