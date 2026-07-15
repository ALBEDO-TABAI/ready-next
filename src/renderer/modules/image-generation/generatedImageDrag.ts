import type React from 'react'

export const READY_GENERATED_IMAGE_MIME = 'application/x-ready-generated-image'
export const GENERATED_IMAGE_DRAG_STATE_EVENT = 'ready:generated-image-drag-state'
const GENERATED_IMAGE_DRAG_TTL_MS = 60_000

export interface GeneratedImageDragPayload {
  type: 'generated-image'
  id: string
  path: string
  name: string
  ext: string
  size: number
  mimeType: string
}

let activeDrag: { payload: GeneratedImageDragPayload; createdAt: number } | null = null

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export function parseGeneratedImageDragPayload(raw: string | null | undefined): GeneratedImageDragPayload | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<GeneratedImageDragPayload>
    if (value.type !== 'generated-image' || !value.id || !value.path || !value.name || !isAbsolutePath(value.path)) return null
    return {
      type: 'generated-image',
      id: value.id,
      path: value.path,
      name: value.name,
      ext: typeof value.ext === 'string' ? value.ext : '',
      size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : 0,
      mimeType: typeof value.mimeType === 'string' ? value.mimeType : 'image/png',
    }
  } catch {
    // silent-catch: malformed drag payloads are rejected; the caller may still use the validated in-memory drag state.
    return null
  }
}

export function beginGeneratedImageDrag(payload: GeneratedImageDragPayload): void {
  activeDrag = { payload: { ...payload }, createdAt: Date.now() }
}

export function getActiveGeneratedImageDrag(): GeneratedImageDragPayload | null {
  if (!activeDrag) return null
  if (Date.now() - activeDrag.createdAt > GENERATED_IMAGE_DRAG_TTL_MS) {
    activeDrag = null
    return null
  }
  return { ...activeDrag.payload }
}

export function endGeneratedImageDrag(): void {
  activeDrag = null
}

export function announceGeneratedImageDragState(active: boolean): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(GENERATED_IMAGE_DRAG_STATE_EVENT, {
    detail: { active },
  }))
}

export function getGeneratedImageDragPayload(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): GeneratedImageDragPayload | null {
  return parseGeneratedImageDragPayload(dataTransfer.getData(READY_GENERATED_IMAGE_MIME))
    || getActiveGeneratedImageDrag()
}

export function writeGeneratedImageDragData(
  event: React.DragEvent,
  payload: GeneratedImageDragPayload,
): void {
  beginGeneratedImageDrag(payload)
  const serialized = JSON.stringify(payload)
  event.dataTransfer.setData(READY_GENERATED_IMAGE_MIME, serialized)
  event.dataTransfer.setData('application/x-ready-drag', JSON.stringify({
    type: 'file',
    path: payload.path,
    name: payload.name,
    ext: payload.ext,
    size: payload.size,
  }))
  event.dataTransfer.effectAllowed = 'copy'
}
