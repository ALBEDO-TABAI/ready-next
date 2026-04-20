import { getWidgetIframeStyleBlock, resolveWidgetThemePayload } from './widget-css-bridge'
import { buildScopedWidgetInlineScript, collectInlineHandlerNames } from './widget-dom-script-runtime'
import { resolveWidgetExportSuggestedName } from './widget-export-snapshot'
import { applyWidgetPersistedState, type DocumentWidgetPersistedState } from './widget-state-runtime'
import { sanitizeWidgetHtml } from './widget-sanitizer'
import {
  buildDocumentWidgetFenceSource,
  parseShowWidgetFences,
  tryParseWidgetPayload,
} from './widget-fence-parser'
import type {
  DocumentWidgetComponentSpecSummary,
  DocumentWidgetSkeletonSpecSummary,
} from '../../../shared/document-widget-parse'

export function getWidgetPersistenceKey(title: string, widgetCode: string): string {
  return `${title.trim().toLowerCase()}::${widgetCode.trim().slice(0, 160)}`
}

export function buildWidgetFenceSource(
  title: string,
  widgetCode: string,
  options?: {
    id?: string | null
    componentSpec?: DocumentWidgetComponentSpecSummary | null
    skeletonSpec?: DocumentWidgetSkeletonSpecSummary | null
    widgetState?: DocumentWidgetPersistedState | null
  },
): string {
  return buildDocumentWidgetFenceSource(title, widgetCode, options)
}

export function getWidgetModeLabel(widgetCode: string): string {
  if (/<script\b/i.test(widgetCode)) return '脚本交互'
  if (/<svg\b/i.test(widgetCode)) return 'SVG widget'
  return 'HTML widget'
}

export function widgetNeedsManualPreview(widgetCode: string): boolean {
  const normalized = String(widgetCode || '')
  if (!normalized.trim()) return false
  if (normalized.length >= 5000) return true
  if (/@keyframes|animation\s*:|animation-name\s*:/i.test(normalized)) return true
  const emojiCount = normalized.match(/\p{Extended_Pictographic}/gu)?.length || 0
  if (emojiCount >= 4) return true
  return false
}

export function getDocumentWidgetRenderBudget(content: string): {
  widgetCount: number
  totalWidgetChars: number
  forceManualPreviewAll: boolean
} {
  const widgets = parseShowWidgetFences(content)
    .filter((segment) => segment.type === 'widget')
    .map((segment) => segment.data.widgetCode)

  const widgetCount = widgets.length
  const totalWidgetChars = widgets.reduce((sum, widgetCode) => sum + widgetCode.length, 0)

  return {
    widgetCount,
    totalWidgetChars,
    forceManualPreviewAll: widgetCount >= 4 || totalWidgetChars >= 12000,
  }
}

const DEFAULT_WIDGET_EXPORT_WIDTH = 1080
const WIDGET_EXPORT_SCALE = 2

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function waitForTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('blob read failed'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const [, base64 = ''] = result.split(',')
      resolve(base64)
    }
    reader.readAsDataURL(blob)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image load failed'))
    image.src = src
  })
}

function svgMarkupToDataUrl(svgMarkup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`
}

async function executeWidgetScripts(container: HTMLElement): Promise<void> {
  const scripts = Array.from(container.querySelectorAll('script'))
  const exportedHandlerNames = collectInlineHandlerNames(container)
  let chain = Promise.resolve()

  scripts.forEach((oldScript) => {
    chain = chain.then(() => new Promise<void>((resolve) => {
      const next = document.createElement('script')
      Array.from(oldScript.attributes).forEach((attr) => {
        next.setAttribute(attr.name, attr.value)
      })
      if (oldScript.src) {
        next.onload = () => resolve()
        next.onerror = () => resolve()
      } else {
        next.textContent = buildScopedWidgetInlineScript(oldScript.textContent || '', exportedHandlerNames)
      }
      oldScript.replaceWith(next)
      if (!oldScript.src) resolve()
    }))
  })

  return chain
}

function replaceCloneCanvasWithImages(cloneRoot: HTMLElement, sourceRoot: HTMLElement): void {
  const sourceCanvases = Array.from(sourceRoot.querySelectorAll('canvas'))
  const cloneCanvases = Array.from(cloneRoot.querySelectorAll('canvas'))

  cloneCanvases.forEach((cloneCanvas, index) => {
    const sourceCanvas = sourceCanvases[index]
    if (!(sourceCanvas instanceof HTMLCanvasElement)) return

    const replacement = document.createElement('img')
    replacement.src = sourceCanvas.toDataURL('image/png')
    replacement.width = sourceCanvas.width || Math.round(sourceCanvas.getBoundingClientRect().width)
    replacement.height = sourceCanvas.height || Math.round(sourceCanvas.getBoundingClientRect().height)
    replacement.style.width = cloneCanvas instanceof HTMLElement ? `${cloneCanvas.getBoundingClientRect().width || sourceCanvas.getBoundingClientRect().width}px` : `${sourceCanvas.getBoundingClientRect().width}px`
    replacement.style.height = cloneCanvas instanceof HTMLElement ? `${cloneCanvas.getBoundingClientRect().height || sourceCanvas.getBoundingClientRect().height}px` : `${sourceCanvas.getBoundingClientRect().height}px`
    replacement.style.display = 'block'
    cloneCanvas.replaceWith(replacement)
  })
}

function buildWidgetExportSvgMarkup(
  htmlMarkup: string,
  styleBlock: string,
  width: number,
  height: number,
): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<foreignObject width="100%" height="100%">',
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;background:transparent;">`,
    `<style>${styleBlock}</style>`,
    htmlMarkup,
    '</div>',
    '</foreignObject>',
    '</svg>',
  ].join('')
}

async function renderWidgetToPngBase64(
  widgetCode: string,
  widgetState?: DocumentWidgetPersistedState | null,
): Promise<string> {
  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-20000px'
  host.style.top = '0'
  host.style.width = `${DEFAULT_WIDGET_EXPORT_WIDTH}px`
  host.style.pointerEvents = 'none'
  host.style.opacity = '0'
  host.style.zIndex = '-1'

  const themePayload = resolveWidgetThemePayload()
  const exportStyleBlock = `${getWidgetIframeStyleBlock(themePayload.vars)}
.widget-root svg,
.widget-root img,
.widget-root video,
.widget-root canvas {
  display: block;
  max-width: 100%;
}
.widget-root svg {
  width: 100%;
  height: auto;
}
`

  const style = document.createElement('style')
  style.textContent = exportStyleBlock

  const root = document.createElement('div')
  root.className = 'widget-root'
  root.innerHTML = sanitizeWidgetHtml(widgetCode)

  host.append(style, root)
  document.body.append(host)

  try {
    await executeWidgetScripts(root)
    applyWidgetPersistedState(root, widgetState)
    if (root.querySelector('canvas')) {
      await waitForTimeout(1100)
    }
    await waitForAnimationFrame()
    await waitForAnimationFrame()

    // Prefer the widget's own declared root box over container scroll metrics.
    // When a widget declares explicit dimensions (e.g. 9:16 1080×1920), using
    // scrollWidth/scrollHeight can pick up overflow artifacts from mistakenly
    // added inner 16:9 blocks and produce an exported image with the wrong
    // aspect ratio. Measuring firstElementChild reflects the widget's own box.
    const widgetRootElement = (root.firstElementChild as HTMLElement | null) ?? root
    const widgetRect = widgetRootElement.getBoundingClientRect()
    const declaredWidth = Math.ceil(widgetRect.width || 0)
    const declaredHeight = Math.ceil(widgetRect.height || 0)
    const width = Math.max(
      120,
      declaredWidth || Math.ceil(root.scrollWidth || root.getBoundingClientRect().width) || DEFAULT_WIDGET_EXPORT_WIDTH,
    )
    const height = Math.max(
      120,
      declaredHeight || Math.ceil(root.scrollHeight || root.getBoundingClientRect().height),
    )
    const clone = root.cloneNode(true) as HTMLElement
    replaceCloneCanvasWithImages(clone, root)

    const svgMarkup = buildWidgetExportSvgMarkup(clone.outerHTML, exportStyleBlock, width, height)
    const image = await loadImage(svgMarkupToDataUrl(svgMarkup))
    const canvas = document.createElement('canvas')
    canvas.width = width * WIDGET_EXPORT_SCALE
    canvas.height = height * WIDGET_EXPORT_SCALE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas context unavailable')
    context.scale(WIDGET_EXPORT_SCALE, WIDGET_EXPORT_SCALE)
    context.drawImage(image, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('png export failed')
    return blobToBase64(blob)
  } finally {
    host.remove()
  }
}

export function renameWidgetFenceTitleInContent(
  content: string,
  currentTitle: string,
  widgetCode: string,
  nextTitle: string,
): string {
  const normalizedNextTitle = nextTitle.trim()
  if (!normalizedNextTitle) return content

  const normalizedSource = content.replace(/\r\n/g, '\n')
  const regex = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g

  for (const match of normalizedSource.matchAll(regex)) {
    const fullMatch = match[0]
    const body = match[1] || ''
    const parsed = tryParseWidgetPayload(body, fullMatch)
    if (!parsed) continue

    const parsedTitle = parsed.title?.trim() || ''
    if (parsedTitle !== currentTitle.trim()) continue
    if (parsed.widgetCode.trim() !== widgetCode.trim()) continue

    const start = match.index ?? 0
    const replacement = buildWidgetFenceSource(normalizedNextTitle, widgetCode, {
      id: parsed.id,
      componentSpec: parsed.componentSpec,
      skeletonSpec: parsed.skeletonSpec,
      widgetState: parsed.widgetState,
    })
    return `${normalizedSource.slice(0, start)}${replacement}${normalizedSource.slice(start + fullMatch.length)}`
  }

  return content
}

export function extractWidgetStateMapFromContent(content: string): Record<string, DocumentWidgetPersistedState> {
  const widgetStateMap: Record<string, DocumentWidgetPersistedState> = {}
  for (const segment of parseShowWidgetFences(content)) {
    if (segment.type !== 'widget' || !segment.data.widgetState) continue
    const key = getWidgetPersistenceKey(segment.data.title || 'widget', segment.data.widgetCode)
    widgetStateMap[key] = segment.data.widgetState
  }
  return widgetStateMap
}

export function mergeWidgetStateMapIntoContent(
  content: string,
  widgetStateMap: Record<string, DocumentWidgetPersistedState>,
): string {
  const normalizedSource = content.replace(/\r\n/g, '\n')
  const regex = /```show-widget\s*\n?([\s\S]*?)\n?\s*```/g

  return normalizedSource.replace(regex, (fullMatch, body: string) => {
    const parsed = tryParseWidgetPayload(body, fullMatch)
    if (!parsed) return fullMatch

    const key = getWidgetPersistenceKey(parsed.title || 'widget', parsed.widgetCode)
    const nextState = widgetStateMap[key] || parsed.widgetState || null
    return buildWidgetFenceSource(parsed.title || 'widget', parsed.widgetCode, {
      id: parsed.id,
      componentSpec: parsed.componentSpec,
      skeletonSpec: parsed.skeletonSpec,
      widgetState: nextState,
    })
  })
}

export async function exportWidgetCardSnapshot(
  widgetCode: string,
  titleHint?: string | null,
  widgetState?: DocumentWidgetPersistedState | null,
  defaultPath?: string | null,
): Promise<{ success?: boolean; canceled?: boolean; error?: string } | null> {
  if (!window.electronAPI?.document?.saveFileAs) return null
  const contentBase64 = await renderWidgetToPngBase64(widgetCode, widgetState)

  return window.electronAPI.document.saveFileAs({
    contentBase64,
    suggestedName: resolveWidgetExportSuggestedName(titleHint, '.png'),
    defaultPath: defaultPath || null,
  })
}
