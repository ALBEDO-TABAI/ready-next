import type React from 'react'
import type { FileItem } from '../../../stores/useWorkspace'
import { startBrowserLocalMediaNativeFileDrag } from '../../../modules/browser/localMediaDragBridge'
import {
  buildWorkspaceDragTransferPayload,
  parseWorkspaceDragPayloads,
  writeWorkspaceDragData,
  type WorkspaceDragPayload,
} from '../fileTreeDragPayload'
import {
  beginWorkspaceDragSession,
  getActiveWorkspaceDragPayloads,
} from '../workspaceDragSession'
import type { FileTreeDropTarget } from '../fileTreeExternalDrop'

interface PutDragDataOptions {
  selectedItems?: FileItem[]
}

export function hasNativeFileDrop(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files')
}

export function putDragData(e: React.DragEvent, item: FileItem, movable = true, options: PutDragDataOptions = {}) {
  const payload = buildWorkspaceDragTransferPayload(item, movable, options.selectedItems)
  writeWorkspaceDragData(e.dataTransfer, payload)
  // Stash the dragged items so the hover indicator can read them during `dragover`,
  // when `dataTransfer.getData` is blocked by the browser's protected drag store.
  beginWorkspaceDragSession(payload.type === 'batch' ? payload.items : [payload])
  startBrowserLocalMediaNativeFileDrag(e)
}

/**
 * Read the workspace items being dragged. `parseWorkspaceDragPayloads` works on the
 * final `drop`, but returns nothing during `dragover` (protected drag store), so fall
 * back to the module-level session captured at `dragstart`.
 */
export function readWorkspaceDragPayloads(dataTransfer: DataTransfer): WorkspaceDragPayload[] {
  const parsed = parseWorkspaceDragPayloads(dataTransfer)
  return parsed.length > 0 ? parsed : getActiveWorkspaceDragPayloads()
}

export function joinPath(dir: string, name: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const normalized = dir.replace(/[\\/]+$/, '')
  return `${normalized}${separator}${name}`
}

export function splitNameForCopy(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

export function buildSelectedDragItemsByPath(
  selectedPaths: ReadonlySet<string>,
  items: readonly FileItem[],
): ReadonlyMap<string, FileItem[]> {
  if (selectedPaths.size <= 1) return new Map()
  const selectedItems = items.filter((item) => selectedPaths.has(item.path) && !item.isDirectory)
  if (selectedItems.length <= 1) return new Map()
  return new Map(selectedItems.map((item) => [item.path, selectedItems]))
}

export function fileTreeDropTargetsEqual(a: FileTreeDropTarget | null, b: FileTreeDropTarget | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'inside-directory' && b.kind === 'inside-directory') {
    return a.dirPath === b.dirPath && a.itemPath === b.itemPath && a.containerPath === b.containerPath
  }
  if (a.kind !== 'inside-directory' && b.kind !== 'inside-directory') {
    return a.anchorPath === b.anchorPath && a.containerPath === b.containerPath
  }
  return false
}
