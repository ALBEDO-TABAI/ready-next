import type { ReactNode } from 'react'
import type { CanvasNode, Graphic, ReadyCanvas } from '../../../../shared/ready-canvas/schema'
import type { CanvasInverse, CanvasOperation } from '../../../../shared/ready-canvas/operations'
import type { Camera, Rect } from '../../../modules/canvas/interaction/geometry'

export interface GraphicDraft extends Rect { id: string; graphic: Graphic }
export interface FrameWork { kind: string; candidates: number; visited: number; domWrites: number }
export interface CanvasSurfaceProps {
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
  /** More 新建 items on the canvas's right-click menu (链接, 文档卡, 子画板), placed at the clicked world point. */
  extraNewItems?: (at: { x: number; y: number }, close: () => void) => ReactNode
  /** Drops the host understands (FastCard items, pages from the sidebar): return true when handled. */
  onDropData?: (data: DataTransfer, at: { x: number; y: number }) => boolean
  acceptsDrop?: (types: readonly string[]) => boolean
}
export type Tool = 'select' | 'pan' | 'rect' | 'arrow' | 'edge' | 'path'
