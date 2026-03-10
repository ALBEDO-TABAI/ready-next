import type { TLEditorSnapshot } from '@tldraw/editor'
import type { MutableRefObject } from 'react'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
import type { DesignLayoutBounds, DesignLayoutDigest, DesignLayoutRegion } from '../../../shared/design-agent'

export interface ShapeLayoutSummary extends DesignLayoutBounds {
  id: TLShapeId
  type: string
  label: string
}

export function hashDesignSnapshot(snapshot: TLEditorSnapshot | null): string | null {
  if (!snapshot) return null
  const documentOnly = (snapshot as { document?: unknown }).document ?? snapshot
  const raw = JSON.stringify(documentOnly)
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i)
    hash |= 0
  }
  return `tldr-${Math.abs(hash).toString(36)}`
}

export async function waitForReadyEditor(
  editorRef: MutableRefObject<Editor | null>,
  timeoutMs = 8000,
  pollIntervalMs = 40,
): Promise<Editor | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    if (editorRef.current) return editorRef.current
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  return editorRef.current
}

function getShapeLabel(shape: TLShape): string {
  const props = ((shape as unknown) as { props?: Record<string, unknown> }).props || {}
  const text = shape.type === 'text'
    ? props.richText
    : props.title ?? props.label ?? props.value ?? props.content
  if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 32)
  if (shape.type === 'geo' && typeof props.geo === 'string') return props.geo
  return shape.type
}

export function getCurrentPageShapeIds(editor: Editor): TLShapeId[] {
  if (typeof editor.getCurrentPageShapeIds === 'function') {
    return Array.from(editor.getCurrentPageShapeIds() as Iterable<TLShapeId>)
  }

  const snapshot = editor.getSnapshot() as { document?: { shapes?: Record<string, unknown> } } | null
  return Object.keys(snapshot?.document?.shapes || {}) as TLShapeId[]
}

export function collectPageShapeSummaries(editor: Editor): ShapeLayoutSummary[] {
  return getCurrentPageShapeIds(editor)
    .map((id) => {
      const shape = editor.getShape(id) as TLShape | undefined
      const bounds = editor.getShapePageBounds(id)
      if (!shape || !bounds) return null
      return {
        id,
        type: shape.type,
        label: getShapeLabel(shape),
        x: Math.round(Number(bounds.x)),
        y: Math.round(Number(bounds.y)),
        w: Math.round(Number(bounds.w)),
        h: Math.round(Number(bounds.h)),
      }
    })
    .filter(Boolean) as ShapeLayoutSummary[]
}

function toMainBounds(shapes: ShapeLayoutSummary[]): DesignLayoutBounds | null {
  if (shapes.length === 0) return null
  const minX = Math.min(...shapes.map((shape) => shape.x))
  const minY = Math.min(...shapes.map((shape) => shape.y))
  const maxX = Math.max(...shapes.map((shape) => shape.x + shape.w))
  const maxY = Math.max(...shapes.map((shape) => shape.y + shape.h))
  return {
    x: minX,
    y: minY,
    w: Math.max(0, maxX - minX),
    h: Math.max(0, maxY - minY),
  }
}

function toSelectionBounds(editor: Editor): DesignLayoutBounds | null {
  const selectedIds = Array.from(editor.getSelectedShapeIds() as Iterable<TLShapeId>)
  if (selectedIds.length === 0) return null
  const bounds = selectedIds
    .map((id) => editor.getShapePageBounds(id))
    .filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>
  if (bounds.length === 0) return null
  const minX = Math.min(...bounds.map((shape) => shape.x))
  const minY = Math.min(...bounds.map((shape) => shape.y))
  const maxX = Math.max(...bounds.map((shape) => shape.x + shape.w))
  const maxY = Math.max(...bounds.map((shape) => shape.y + shape.h))
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.round(Math.max(0, maxX - minX)),
    h: Math.round(Math.max(0, maxY - minY)),
  }
}

export function buildDesignLayoutDigest(
  editor: Editor,
  selectionSummary: string | null,
  latestReviewSummary?: string | null,
): DesignLayoutDigest {
  const shapes = collectPageShapeSummaries(editor)
  const selectedIds = Array.from(editor.getSelectedShapeIds() as Iterable<TLShapeId>)
  const regions: DesignLayoutRegion[] = shapes
    .slice()
    .sort((a, b) => (b.w * b.h) - (a.w * a.h))
    .slice(0, 4)
    .map((shape) => ({
      id: String(shape.id),
      type: shape.type,
      label: shape.label,
      x: shape.x,
      y: shape.y,
      w: shape.w,
      h: shape.h,
    }))

  return {
    topLevelElementCount: shapes.length,
    mainBounds: toMainBounds(shapes),
    regions,
    selectionSummary,
    selectedElementCount: selectedIds.length,
    selectionBounds: toSelectionBounds(editor),
    latestReviewSummary: latestReviewSummary || null,
  }
}

export function findEmptyCanvasSpace(
  editor: Editor,
  dimensions: { w: number; h: number },
  options?: { direction?: 'right' | 'below'; padding?: number },
): { x: number; y: number; basis: 'empty-canvas' | 'existing-layout-right' | 'existing-layout-below' } {
  const direction = options?.direction || 'right'
  const padding = Number.isFinite(Number(options?.padding)) ? Math.max(24, Number(options?.padding)) : 100
  const viewport = editor.getViewportPageBounds()
  const shapes = collectPageShapeSummaries(editor)
  if (shapes.length === 0) {
    return {
      x: Math.round(viewport.x + padding),
      y: Math.round(viewport.y + padding),
      basis: 'empty-canvas',
    }
  }

  const minX = Math.min(...shapes.map((shape) => shape.x))
  const minY = Math.min(...shapes.map((shape) => shape.y))
  const maxX = Math.max(...shapes.map((shape) => shape.x + shape.w))
  const maxY = Math.max(...shapes.map((shape) => shape.y + shape.h))

  if (direction === 'below') {
    return {
      x: Math.round(Math.max(viewport.x + padding, minX)),
      y: Math.round(maxY + padding),
      basis: 'existing-layout-below',
    }
  }

  return {
    x: Math.round(maxX + padding),
    y: Math.round(Math.max(viewport.y + padding, minY)),
    basis: 'existing-layout-right',
  }
}
