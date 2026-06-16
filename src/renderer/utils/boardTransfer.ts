import type {
  ReadyBoardAssetKind,
  ReadyBoardNode,
  ReadyBoardNodeType,
} from '../../shared/ready-board'

export const READY_BOARD_RESOURCE_MIME = 'application/x-ready-board-resource'

export interface ReadyBoardTransferFileResource {
  kind: 'file'
  nodeId: string
  nodeType: ReadyBoardAssetKind
  name: string
  path: string
  ext: string
  size?: number
  title?: string
}

export interface ReadyBoardTransferTextResource {
  kind: 'text'
  nodeId: string
  nodeType: 'text' | 'note'
  name: string
  text: string
  markdown: string
}

export type ReadyBoardTransferResource =
  | ReadyBoardTransferFileResource
  | ReadyBoardTransferTextResource

export interface ReadyBoardResourceDragPayload {
  type: 'ready-board-selection'
  source: 'readyboard'
  boardPath: string | null
  boardTitle: string
  resources: ReadyBoardTransferResource[]
  paths: string[]
  plainText: string
  markdown: string
  html: string
  createdAt: number
}

export interface WorkspaceReadyDragPayload {
  type: 'file'
  path: string
  name: string
  ext?: string
  size?: number
  isDirectory: false
  movable: false
  source: 'readyboard'
}

export interface WorkspaceReadyDragBatchPayload {
  type: 'batch'
  items: WorkspaceReadyDragPayload[]
  source: 'readyboard'
  movable: false
}

export type ReadyBoardWorkspaceDragPayload =
  | WorkspaceReadyDragPayload
  | WorkspaceReadyDragBatchPayload

interface BuildReadyBoardSelectionTransferInput {
  boardPath: string | null | undefined
  boardTitle: string
  nodes: ReadyBoardNode[]
  selectedIds: readonly string[]
}

const FILE_NODE_TYPES = new Set<ReadyBoardNodeType>(['image', 'video', 'markdown'])

function dirname(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash >= 0 ? path.slice(0, slash) : ''
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function extname(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function joinPath(dir: string, relPath: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const cleanDir = dir.replace(/[\\/]+$/, '')
  const cleanRel = relPath.replace(/^[\\/]+/, '')
  return `${cleanDir}${separator}${cleanRel}`
}

function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const encoded = encodeURI(normalized).replace(/#/g, '%23')
  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return char
    }
  })
}

function nodeTitle(node: ReadyBoardNode): string {
  if (node.type === 'image' || node.type === 'video') return node.title || basename(node.src)
  if (node.type === 'markdown') return node.title || basename(node.src)
  if (node.type === 'note') return '画板便签'
  if (node.type === 'text') return '画板文字'
  return '画板内容'
}

function fileResourceForNode(boardPath: string | null | undefined, node: ReadyBoardNode): ReadyBoardTransferFileResource | null {
  if (!boardPath || !FILE_NODE_TYPES.has(node.type)) return null
  if (node.type !== 'image' && node.type !== 'video' && node.type !== 'markdown') return null
  const name = basename(node.src)
  return {
    kind: 'file',
    nodeId: node.id,
    nodeType: node.type,
    name,
    path: joinPath(dirname(boardPath), node.src),
    ext: extname(name),
    title: nodeTitle(node),
  }
}

function textResourceForNode(node: ReadyBoardNode): ReadyBoardTransferTextResource | null {
  if (node.type !== 'text' && node.type !== 'note') return null
  const text = node.text.trim()
  if (!text) return null
  const name = node.type === 'note' ? '画板便签' : '画板文字'
  return {
    kind: 'text',
    nodeId: node.id,
    nodeType: node.type,
    name,
    text,
    markdown: text,
  }
}

function buildMarkdown(resources: ReadyBoardTransferResource[]): string {
  return resources.map((resource) => {
    if (resource.kind === 'file') {
      const label = resource.title || resource.name
      if (resource.nodeType === 'image') return `![${label}](${fileUrl(resource.path)})`
      return `- [${label}](${fileUrl(resource.path)})`
    }
    return resource.markdown
  }).join('\n\n')
}

function buildPlainText(resources: ReadyBoardTransferResource[]): string {
  return resources.map((resource) => (
    resource.kind === 'file' ? resource.path : resource.text
  )).join('\n')
}

function buildHtml(resources: ReadyBoardTransferResource[]): string {
  return resources.map((resource) => {
    if (resource.kind === 'file') {
      const label = escapeHtml(resource.title || resource.name)
      const href = escapeHtml(fileUrl(resource.path))
      if (resource.nodeType === 'image') return `<p><img src="${href}" alt="${label}"></p>`
      return `<p><a href="${href}">${label}</a></p>`
    }
    return `<p>${escapeHtml(resource.text).replace(/\n/g, '<br>')}</p>`
  }).join('')
}

export function buildReadyBoardSelectionTransfer({
  boardPath,
  boardTitle,
  nodes,
  selectedIds,
}: BuildReadyBoardSelectionTransferInput): ReadyBoardResourceDragPayload | null {
  const selected = new Set(selectedIds)
  if (selected.size === 0) return null
  const resources = nodes
    .filter((node) => selected.has(node.id))
    .map((node) => fileResourceForNode(boardPath, node) ?? textResourceForNode(node))
    .filter((resource): resource is ReadyBoardTransferResource => Boolean(resource))
  if (resources.length === 0) return null
  const paths = resources
    .filter((resource): resource is ReadyBoardTransferFileResource => resource.kind === 'file')
    .map((resource) => resource.path)
  return {
    type: 'ready-board-selection',
    source: 'readyboard',
    boardPath: boardPath || null,
    boardTitle,
    resources,
    paths,
    plainText: buildPlainText(resources),
    markdown: buildMarkdown(resources),
    html: buildHtml(resources),
    createdAt: Date.now(),
  }
}

export function buildReadyBoardWorkspaceDragPayload(
  payload: ReadyBoardResourceDragPayload,
): ReadyBoardWorkspaceDragPayload | null {
  const items = payload.resources
    .filter((resource): resource is ReadyBoardTransferFileResource => resource.kind === 'file')
    .map((resource) => ({
      type: 'file' as const,
      path: resource.path,
      name: resource.name,
      ext: resource.ext,
      size: resource.size,
      isDirectory: false as const,
      movable: false as const,
      source: 'readyboard' as const,
    }))
  if (items.length === 0) return null
  if (items.length === 1) return items[0]
  return {
    type: 'batch',
    items,
    source: 'readyboard',
    movable: false,
  }
}

export function parseReadyBoardResourceDragPayload(raw: string | null | undefined): ReadyBoardResourceDragPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ReadyBoardResourceDragPayload>
    if (parsed.type !== 'ready-board-selection' || parsed.source !== 'readyboard') return null
    if (!Array.isArray(parsed.resources)) return null
    const resources = parsed.resources.filter((resource): resource is ReadyBoardTransferResource => {
      if (!resource || typeof resource !== 'object') return false
      if (resource.kind === 'file') return typeof resource.path === 'string' && typeof resource.name === 'string'
      if (resource.kind === 'text') return typeof resource.text === 'string'
      return false
    })
    if (resources.length === 0) return null
    const paths = resources
      .filter((resource): resource is ReadyBoardTransferFileResource => resource.kind === 'file')
      .map((resource) => resource.path)
    return {
      type: 'ready-board-selection',
      source: 'readyboard',
      boardPath: typeof parsed.boardPath === 'string' ? parsed.boardPath : null,
      boardTitle: typeof parsed.boardTitle === 'string' ? parsed.boardTitle : 'Readyboard',
      resources,
      paths,
      plainText: typeof parsed.plainText === 'string' ? parsed.plainText : buildPlainText(resources),
      markdown: typeof parsed.markdown === 'string' ? parsed.markdown : buildMarkdown(resources),
      html: typeof parsed.html === 'string' ? parsed.html : buildHtml(resources),
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function writeReadyBoardTransferToDataTransfer(
  dataTransfer: DataTransfer,
  payload: ReadyBoardResourceDragPayload,
): void {
  const serialized = JSON.stringify(payload)
  dataTransfer.setData(READY_BOARD_RESOURCE_MIME, serialized)
  dataTransfer.setData('text/plain', payload.plainText)
  dataTransfer.setData('text/html', payload.html)
  if (payload.paths.length > 0) {
    dataTransfer.setData('text/uri-list', payload.paths.map(fileUrl).join('\n'))
  }
  const readyDrag = buildReadyBoardWorkspaceDragPayload(payload)
  if (readyDrag) {
    const readySerialized = JSON.stringify(readyDrag)
    dataTransfer.setData('application/x-ready-drag', readySerialized)
    dataTransfer.setData('application/x-ready-file', readySerialized)
  }
  dataTransfer.effectAllowed = 'copy'
}
