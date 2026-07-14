export interface GraphViewport {
  x: number
  y: number
  zoom: number
}

export interface GraphWheelGesture {
  deltaX: number
  deltaY: number
  ctrlKey: boolean
  pointerX: number
  pointerY: number
}

export interface GraphDocumentPreview {
  title: string
  body: string
}

export const GRAPH_MIN_ZOOM = 0.08
export const GRAPH_MAX_ZOOM = 4

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function applyGraphWheelGesture(
  viewport: GraphViewport,
  gesture: GraphWheelGesture,
): GraphViewport {
  if (!gesture.ctrlKey) {
    return {
      x: viewport.x - gesture.deltaX,
      y: viewport.y - gesture.deltaY,
      zoom: viewport.zoom,
    }
  }

  const nextZoom = clamp(
    viewport.zoom * Math.exp(-gesture.deltaY * 0.01),
    GRAPH_MIN_ZOOM,
    GRAPH_MAX_ZOOM,
  )
  if (nextZoom === viewport.zoom) return viewport

  const scale = nextZoom / viewport.zoom
  return {
    x: gesture.pointerX - (gesture.pointerX - viewport.x) * scale,
    y: gesture.pointerY - (gesture.pointerY - viewport.y) * scale,
    zoom: nextZoom,
  }
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias || target)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildGraphDocumentPreview(
  content: string,
  fallbackTitle: string,
  maxBodyLength = 280,
): GraphDocumentPreview {
  let source = content
    .replace(/^\uFEFF/, '')
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')

  const heading = source.match(/(?:^|\n)\s{0,3}#{1,6}\s+([^\n]+)(?:\n|$)/)
  const title = cleanInlineMarkdown(heading?.[1] || fallbackTitle)
  if (heading?.index !== undefined) {
    source = `${source.slice(0, heading.index)}\n${source.slice(heading.index + heading[0].length)}`
  }

  const body = cleanInlineMarkdown(
    source
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s{0,3}(?:>|[-+*]|\d+[.)])\s+/gm, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, ''),
  )
  const clippedBody = body.length > maxBodyLength
    ? `${body.slice(0, maxBodyLength).trimEnd()}…`
    : body

  return {
    title: title || fallbackTitle,
    body: clippedBody || '文档暂无可预览的正文。',
  }
}
