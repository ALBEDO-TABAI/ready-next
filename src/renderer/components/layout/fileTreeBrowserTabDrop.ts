export interface BrowserTabDragPayload {
  type: 'browser-tab'
  tabId: string
  title: string
  name: string
  url: string
}

export type BrowserTabDropTarget =
  | {
      kind: 'inside-directory'
      dirPath: string
      itemPath: string
      containerPath: string
    }
  | {
      kind: 'insert-before' | 'insert-after'
      anchorPath: string
      containerPath: string
    }

interface ResolveBrowserTabDropTargetInput {
  itemPath: string
  isDirectory: boolean
  containerPath: string
  pointerY: number
  rectTop: number
  rectHeight: number
}

const EDGE_ZONE_PX = 9

interface ClampDropMenuPositionInput {
  x: number
  y: number
  menuWidth: number
  menuHeight: number
  boundaryLeft: number
  boundaryTop: number
  boundaryRight: number
  boundaryBottom: number
  viewportWidth: number
  viewportHeight: number
  padding?: number
}

export function parseBrowserTabDragPayload(raw: string | null | undefined): BrowserTabDragPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserTabDragPayload>
    if (parsed.type !== 'browser-tab') return null
    if (!parsed.tabId || !parsed.url || !parsed.title || !parsed.name) return null
    return {
      type: 'browser-tab',
      tabId: parsed.tabId,
      title: parsed.title,
      name: parsed.name,
      url: parsed.url,
    }
  } catch {
    return null
  }
}

export function resolveBrowserTabDropTarget({
  itemPath,
  isDirectory,
  containerPath,
  pointerY,
  rectTop,
  rectHeight,
}: ResolveBrowserTabDropTargetInput): BrowserTabDropTarget {
  const offsetY = Math.max(0, Math.min(rectHeight, pointerY - rectTop))
  const edgeZone = Math.min(EDGE_ZONE_PX, Math.max(6, rectHeight * 0.22))

  if (offsetY <= edgeZone) {
    return {
      kind: 'insert-before',
      anchorPath: itemPath,
      containerPath,
    }
  }

  if (offsetY >= rectHeight - edgeZone) {
    return {
      kind: 'insert-after',
      anchorPath: itemPath,
      containerPath,
    }
  }

  if (isDirectory) {
    return {
      kind: 'inside-directory',
      dirPath: itemPath,
      itemPath,
      containerPath,
    }
  }

  return {
    kind: 'insert-after',
    anchorPath: itemPath,
    containerPath,
  }
}

export function clampDropMenuPositionToBoundary({
  x,
  y,
  menuWidth,
  menuHeight,
  boundaryLeft,
  boundaryTop,
  boundaryRight,
  boundaryBottom,
  viewportWidth,
  viewportHeight,
  padding = 8,
}: ClampDropMenuPositionInput): { x: number; y: number } {
  const minX = Math.max(padding, boundaryLeft + padding)
  const maxX = Math.min(viewportWidth - menuWidth - padding, boundaryRight - menuWidth - padding)
  const minY = Math.max(padding, boundaryTop + padding)
  const maxY = Math.min(viewportHeight - menuHeight - padding, boundaryBottom - menuHeight - padding)

  return {
    x: Math.max(minX, Math.min(x, maxX)),
    y: Math.max(minY, Math.min(y, maxY)),
  }
}
