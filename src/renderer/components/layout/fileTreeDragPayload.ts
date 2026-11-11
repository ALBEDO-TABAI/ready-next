import { writeReadyRefTransfer, readReadyRefTransfers } from '../../../shared/ready-ref'
import { fileDragRef } from '../../modules/workbench/file-drag-ref'
import { getActiveWorkspaceDragPayloads } from './workspaceDragSession'
import type { FileItem } from '../../stores/useWorkspace'

export interface WorkspaceDragPayload {
  type: 'file' | 'folder'
  path: string
  name: string
  ext?: string
  size?: number
  isDirectory: boolean
  movable: boolean
}

export interface WorkspaceDragBatchPayload {
  type: 'batch'
  items: WorkspaceDragPayload[]
}

export type WorkspaceDragTransferPayload = WorkspaceDragPayload | WorkspaceDragBatchPayload

interface WritableDragDataTransfer {
  setData: (format: string, data: string) => void
  effectAllowed: DataTransfer['effectAllowed']
}

interface ReadableDragDataTransfer {
  getData: (format: string) => string
}

function getFileExt(item: Pick<FileItem, 'name'>): string {
  const ext = item.name.split('.').pop()?.toLowerCase()
  return ext || ''
}

export function buildWorkspaceDragPayload(item: FileItem, movable: boolean): WorkspaceDragPayload {
  const ext = getFileExt(item)
  return {
    type: item.isDirectory ? 'folder' : 'file',
    path: item.path,
    name: item.name,
    ext,
    size: item.size,
    isDirectory: item.isDirectory,
    movable,
  }
}

function getSelectedBatchItems(item: FileItem, selectedItems?: FileItem[]): FileItem[] | null {
  const selectedFiles = selectedItems
    ?.filter((selectedItem) => !selectedItem.isDirectory)
    .filter((selectedItem, index, items) => items.findIndex((candidate) => candidate.path === selectedItem.path) === index)

  if (!selectedFiles || selectedFiles.length <= 1) return null
  return selectedFiles.some((selectedItem) => selectedItem.path === item.path) ? selectedFiles : null
}

export function buildWorkspaceDragTransferPayload(
  item: FileItem,
  movable = true,
  selectedItems?: FileItem[],
): WorkspaceDragTransferPayload {
  const batchItems = getSelectedBatchItems(item, selectedItems)
  if (batchItems) {
    return {
      type: 'batch',
      items: batchItems.map((selectedItem) => buildWorkspaceDragPayload(selectedItem, movable)),
    }
  }
  return buildWorkspaceDragPayload(item, movable)
}

export function getWorkspaceDragPaths(payload: WorkspaceDragTransferPayload): string[] {
  return payload.type === 'batch'
    ? payload.items.map((item) => item.path)
    : [payload.path]
}

export function writeWorkspaceDragData(
  dataTransfer: WritableDragDataTransfer,
  payload: WorkspaceDragTransferPayload,
): void {
  const items = payload.type === 'batch' ? payload.items : [payload]
  writeReadyRefTransfer(dataTransfer, items.map(item => fileDragRef(item.path)), items.map(item => item.name).join('\n'))
  dataTransfer.effectAllowed = 'copyMove'
}

export function parseWorkspaceDragPayloads(dataTransfer: ReadableDragDataTransfer): WorkspaceDragPayload[] {
  const dropped = readReadyRefTransfers(dataTransfer)
  if (!dropped.length || dropped.some(item => !['page', 'file'].includes(item.ref.kind))) return []
  return getActiveWorkspaceDragPayloads().filter(item => {
    const ref = fileDragRef(item.path)
    return 'id' in ref && dropped.some(item => 'id' in item.ref && item.ref.id === ref.id)
  })
}
