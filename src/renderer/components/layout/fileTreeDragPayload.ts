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
  const serialized = JSON.stringify(payload)
  const paths = getWorkspaceDragPaths(payload)
  dataTransfer.setData('application/x-ready-drag', serialized)
  dataTransfer.setData('application/x-ready-file', serialized)
  dataTransfer.setData('application/x-ready-workspace-item', serialized)
  dataTransfer.setData('text/plain', paths.join('\n'))
  dataTransfer.setData('text/uri-list', paths.map((path) => `file://${encodeURI(path)}`).join('\n'))
  dataTransfer.effectAllowed = 'copyMove'
}

function isWorkspaceDragPayload(value: unknown): value is WorkspaceDragPayload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkspaceDragPayload>
  return (
    (candidate.type === 'file' || candidate.type === 'folder') &&
    typeof candidate.path === 'string' &&
    candidate.path.length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.isDirectory === 'boolean'
  )
}

export function parseWorkspaceDragPayloads(dataTransfer: ReadableDragDataTransfer): WorkspaceDragPayload[] {
  const raw = dataTransfer.getData('application/x-ready-workspace-item')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Partial<WorkspaceDragBatchPayload>).type === 'batch' &&
      Array.isArray((parsed as Partial<WorkspaceDragBatchPayload>).items)
    ) {
      return ((parsed as WorkspaceDragBatchPayload).items || []).filter(isWorkspaceDragPayload)
    }
    return isWorkspaceDragPayload(parsed) ? [parsed] : []
  } catch {
    return []
  }
}
