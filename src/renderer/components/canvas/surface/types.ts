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
  onAddToDocument?: (nodeIds: string[]) => Promise<void>
  resolveAsset?: (path: string) => string | undefined
  onOpenNode?: (node: CanvasNode) => void
  onNavigateSubcanvas?: (node: CanvasNode) => void
  breadcrumbs?: Array<{ id: string; title: string }>
  onNavigateAncestor?: (id: string) => void
  revealNode?: { nodeId?: string; requestId: string }
  initialCamera?: Camera
  onFrameWork?: (work: FrameWork) => void
}
export type Tool = 'select' | 'pan' | 'rect' | 'arrow' | 'edge' | 'path'
