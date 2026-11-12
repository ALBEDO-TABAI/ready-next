import { readReadyRefTransfer, writeReadyRefTransfer } from '../../../shared/ready-ref'
import { fileDragRef } from '../workbench/file-drag-ref'
import type React from 'react'

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

let activeDrag: { payload: GeneratedImageDragPayload; objectId: string; createdAt: number } | null = null

export function beginGeneratedImageDrag(payload: GeneratedImageDragPayload, objectId: string): void {
  activeDrag = { payload: { ...payload }, objectId, createdAt: Date.now() }
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
  const payload = getActiveGeneratedImageDrag(), dropped = readReadyRefTransfer(dataTransfer)
  return payload && dropped?.ref.kind === 'file' && dropped.ref.id === activeDrag?.objectId ? payload : null
}

export function writeGeneratedImageDragData(
  event: React.DragEvent,
  payload: GeneratedImageDragPayload,
): void {
  const ref = fileDragRef(payload.path)
  if (ref.kind !== 'file') throw new Error('生成图片必须是文件引用')
  beginGeneratedImageDrag(payload, ref.id)
  writeReadyRefTransfer(event.dataTransfer, ref, payload.name)
  event.dataTransfer.effectAllowed = 'copy'
}
