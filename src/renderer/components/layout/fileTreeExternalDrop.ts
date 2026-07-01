import type React from 'react'
import {
  parseReadyBoardResourceDragPayload,
  READY_BOARD_RESOURCE_MIME,
  type ReadyBoardResourceDragPayload,
} from '../../utils/boardTransfer'
import { canAttemptVisualAnalysis } from '../../../shared/browser-tab-resource-classifier'
import type { WorkspaceDragPayload } from './fileTreeDragPayload'

export interface BrowserTabDragPayload {
  type: 'browser-tab'
  tabId: string
  title: string
  name: string
  url: string
}

export interface RSSItemDragPayload {
  type: 'rss-item'
  id: string
  name: string
  title?: string
  link: string
  summary?: string
  source?: string
  publishedAt?: string
}

export interface WebDownloadDragPayload {
  type: 'web-download-url'
  url: string
  name: string
  title?: string
  sourcePageUrl?: string
  suggestedName?: string
  unsupportedReason?: string
}

export type FileTreeExternalDropPayload =
  | BrowserTabDragPayload
  | RSSItemDragPayload
  | WebDownloadDragPayload
  | ReadyBoardResourceDragPayload

export type FileTreeDropTarget =
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

interface ResolveFileTreeDropTargetInput {
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

interface ShouldKeepFileTreeDropHintOnLeaveInput {
  clientX: number
  clientY: number
  rectLeft: number
  rectTop: number
  rectWidth: number
  rectHeight: number
  relatedTargetInside: boolean
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

export function buildBrowserTabAnalysisItemId(url: string): string {
  let hash = 2166136261
  const input = url.trim()
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-btab`
}

export function parseRssItemDragPayload(raw: string | null | undefined): RSSItemDragPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RSSItemDragPayload>
    if (parsed.type !== 'rss-item') return null
    if (!parsed.id || !parsed.name || !parsed.link) return null
    return {
      type: 'rss-item',
      id: parsed.id,
      name: parsed.name,
      title: parsed.title,
      link: parsed.link,
      summary: parsed.summary,
      source: parsed.source,
      publishedAt: parsed.publishedAt,
    }
  } catch {
    return null
  }
}

const WEB_DOWNLOAD_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tiff', '.svg', '.avif',
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v',
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.opus',
  '.pdf', '.zip',
])

function firstUriListUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#')) ?? null
}

function decodeHtmlEntity(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function extractAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = tag.match(pattern)
  return decodeHtmlEntity(match?.[2] || match?.[3] || match?.[4] || '').trim() || null
}

function urlPathExt(url: string): string {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    const dotIndex = pathname.lastIndexOf('.')
    if (dotIndex < 0) return ''
    return pathname.slice(dotIndex)
  } catch {
    // silent-catch: URL parse fallback for file-extension hint; degrades to substring scan. No user-facing impact.
    const lower = url.toLowerCase().split(/[?#]/)[0]
    const dotIndex = lower.lastIndexOf('.')
    return dotIndex >= 0 ? lower.slice(dotIndex) : ''
  }
}

function suggestedFilenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || undefined
  } catch {
    // silent-catch: URL parse fallback for suggested filename; returning undefined lets downstream synthesize one. No user-facing impact.
    return undefined
  }
}

function buildWebDownloadPayload(
  url: string | null | undefined,
  source: 'media-html' | 'download-link' | 'url-list',
  suggestedName?: string | null,
): WebDownloadDragPayload | null {
  const trimmed = (url || '').trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') {
    return {
      type: 'web-download-url',
      url: trimmed,
      name: suggestedName || suggestedFilenameFromUrl(trimmed) || '网页资源',
      suggestedName: suggestedName || suggestedFilenameFromUrl(trimmed),
      unsupportedReason: '暂不支持临时网页资源',
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const ext = urlPathExt(trimmed)
  const isMediaHtml = source === 'media-html'
  const isDownloadableLink = source === 'download-link' || WEB_DOWNLOAD_EXTS.has(ext)
  if (!isMediaHtml && !isDownloadableLink) return null
  const name = suggestedName || suggestedFilenameFromUrl(trimmed) || parsed.hostname || '网页资源'
  return {
    type: 'web-download-url',
    url: trimmed,
    name,
    title: name,
    suggestedName: suggestedName || suggestedFilenameFromUrl(trimmed),
  }
}

function parseHtmlWebDownloadPayload(rawHtml: string | null | undefined): WebDownloadDragPayload | null {
  if (!rawHtml) return null
  const html = rawHtml.trim()
  if (!html) return null
  const mediaTagPattern = /<(img|video|source)\b[^>]*>/gi
  let mediaMatch: RegExpExecArray | null
  while ((mediaMatch = mediaTagPattern.exec(html))) {
    const payload = buildWebDownloadPayload(extractAttribute(mediaMatch[0], 'src'), 'media-html')
    if (payload) return payload
  }
  const linkTagPattern = /<a\b[^>]*>/gi
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = linkTagPattern.exec(html))) {
    const tag = linkMatch[0]
    const href = extractAttribute(tag, 'href')
    const downloadName = extractAttribute(tag, 'download')
    const payload = buildWebDownloadPayload(href, downloadName ? 'download-link' : 'url-list', downloadName)
    if (payload) return payload
  }
  return null
}

export function parseWebDownloadDragPayload(dataTransfer: Pick<DataTransfer, 'getData'>): WebDownloadDragPayload | null {
  const htmlPayload = parseHtmlWebDownloadPayload(dataTransfer.getData('text/html'))
  if (htmlPayload) return htmlPayload
  const uriListPayload = buildWebDownloadPayload(firstUriListUrl(dataTransfer.getData('text/uri-list')), 'url-list')
  if (uriListPayload) return uriListPayload
  return buildWebDownloadPayload(dataTransfer.getData('text/plain'), 'url-list')
}

export function parseReadyBoardFileTreeDropPayload(dataTransfer: Pick<DataTransfer, 'getData'>): ReadyBoardResourceDragPayload | null {
  const payload = parseReadyBoardResourceDragPayload(dataTransfer.getData(READY_BOARD_RESOURCE_MIME))
  if (!payload || payload.paths.length === 0) return null
  return payload
}

interface SetRssItemDragInput {
  id: string
  title: string
  link: string
  summary?: string
  source?: string
  publishedAt?: string
}

/**
 * Defensive TTL for the RSS drag session global. RSSFeed's `onDragEnd`
 * handler clears the state on a normal drag end, but the handler does not
 * fire if the source element unmounts mid-drag (route change, list refresh,
 * filter re-render). Without a TTL the leaked payload would surface on
 * subsequent unrelated drags (e.g. desktop file drop) via the fallback in
 * `getExternalDropPayload`, incorrectly opening the RSS/web-clip menu.
 * 60 seconds is well beyond any realistic drag duration.
 */
const RSS_DRAG_TTL_MS = 60_000

interface ActiveRssDragRecord {
  payload: RSSItemDragPayload
  createdAt: number
}

let activeRssItemDragRecord: ActiveRssDragRecord | null = null

export function beginRssItemDragSession(payload: RSSItemDragPayload): void {
  activeRssItemDragRecord = { payload: { ...payload }, createdAt: Date.now() }
}

export function getActiveRssItemDragPayload(): RSSItemDragPayload | null {
  if (!activeRssItemDragRecord) return null
  if (Date.now() - activeRssItemDragRecord.createdAt > RSS_DRAG_TTL_MS) {
    activeRssItemDragRecord = null
    return null
  }
  return { ...activeRssItemDragRecord.payload }
}

export function endRssItemDragSession(): void {
  activeRssItemDragRecord = null
}

/** Test-only: probe whether the TTL has cleared the session. */
export function __rssDragSessionAgeMs(): number | null {
  return activeRssItemDragRecord ? Date.now() - activeRssItemDragRecord.createdAt : null
}

export function setRssItemDragPayload(event: React.DragEvent, item: SetRssItemDragInput): void {
  const payload: RSSItemDragPayload = {
    type: 'rss-item',
    id: item.id,
    name: item.title,
    title: item.title,
    link: item.link,
    summary: item.summary,
    source: item.source,
    publishedAt: item.publishedAt,
  }
  beginRssItemDragSession(payload)
  const json = JSON.stringify(payload)
  event.dataTransfer.setData('application/x-ready-drag', json)
  event.dataTransfer.setData('application/x-ready-rss-item', json)
  event.dataTransfer.setData('text/plain', `${item.title}\n${item.link}`)
  event.dataTransfer.setData('text/uri-list', item.link)
  event.dataTransfer.effectAllowed = 'copy'
}

export function resolveFileTreeDropTarget({
  itemPath,
  isDirectory,
  containerPath,
  pointerY,
  rectTop,
  rectHeight,
}: ResolveFileTreeDropTargetInput): FileTreeDropTarget {
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

export function getTargetDirFromDropTarget(target: FileTreeDropTarget): string {
  return target.kind === 'inside-directory' ? target.dirPath : target.containerPath
}

export function canMoveToDirectory(source: WorkspaceDragPayload, targetDir: string): boolean {
  if (!targetDir || !source.path) return false
  if (source.movable === false) return false
  if (source.path === targetDir) return false
  const currentParent = source.path.replace(/[\\/][^\\/]+$/, '') || '/'
  if (currentParent === targetDir) return false
  if (source.isDirectory) {
    if (targetDir.startsWith(`${source.path}/`) || targetDir.startsWith(`${source.path}\\`)) {
      return false
    }
  }
  return true
}

export function canMoveAllToDirectory(sources: readonly WorkspaceDragPayload[], targetDir: string): boolean {
  return sources.length > 0 && sources.every((source) => canMoveToDirectory(source, targetDir))
}

/**
 * Resolve where an *internal* file-tree drag would land for a given hovered row and
 * pointer position, mirroring the external-drop indicator: pointer near a row edge lands
 * in that row's containing folder, pointer over a directory body lands inside it. Returns
 * the destination directory when the move is valid, or null when the row is not a legal
 * target (e.g. the item's current folder, or a folder into itself) so callers can skip it.
 */
export function resolveInternalMoveDir(
  sources: readonly WorkspaceDragPayload[],
  input: ResolveFileTreeDropTargetInput,
): string | null {
  if (sources.length === 0) return null
  const destDir = getTargetDirFromDropTarget(resolveFileTreeDropTarget(input))
  return canMoveAllToDirectory(sources, destDir) ? destDir : null
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

export function shouldKeepFileTreeDropHintOnLeave({
  clientX,
  clientY,
  rectLeft,
  rectTop,
  rectWidth,
  rectHeight,
  relatedTargetInside,
}: ShouldKeepFileTreeDropHintOnLeaveInput): boolean {
  if (relatedTargetInside) return true
  if (rectWidth <= 0 || rectHeight <= 0) return false

  const rectRight = rectLeft + rectWidth
  const rectBottom = rectTop + rectHeight
  return clientX >= rectLeft && clientX <= rectRight && clientY >= rectTop && clientY <= rectBottom
}

export type FileTreeExternalDropAction =
  | 'web-clip'
  | 'content-study'
  | 'copy-analysis'
  | 'visual-analysis'

export function isLikelyVideoDropPayload(payload: FileTreeExternalDropPayload): boolean {
  const url =
    payload.type === 'ready-board-selection'
      ? ''
      : payload.type === 'browser-tab'
      ? payload.url
      : payload.type === 'rss-item'
        ? payload.link
        : payload.url
  return canAttemptVisualAnalysis(url)
}

export interface FileTreeExternalDropPlaceholder {
  taskId: string
  targetDir: string
  urlHost: string
  title: string
  status: 'running'
  createdAt: number
}

export interface FileTreeExternalDropPlaceholderPatch {
  status?: 'running' | 'completed' | 'failed'
  copiedPath?: string
  errorMessage?: string
  message?: string | null
}

export type FileTreeAnalysisPlaceholderStatus =
  | 'queued'
  | 'paused'
  | 'running_script'
  | 'running_subagent'
  | 'success'
  | 'failed'
  | 'skipped'

export interface FileTreeAnalysisPlaceholder {
  taskId: string
  itemId: string
  action: 'copy' | 'visual'
  targetDir: string
  urlHost: string
  title: string
  status: FileTreeAnalysisPlaceholderStatus
  progress: number
  message?: string | null
  jobId?: string
  outputDir?: string
  reportPath?: string | null
  copiedPath?: string
  errorMessage?: string
  createdAt: number
}

export interface FileTreeAnalysisPlaceholderPatch {
  status?: FileTreeAnalysisPlaceholderStatus
  progress?: number
  message?: string | null
  jobId?: string
  outputDir?: string
  reportPath?: string | null
  copiedPath?: string
  errorMessage?: string
}

export type FileTreeStudyPlaceholderStatus =
  | 'waiting_for_clip'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface FileTreeStudyPlaceholderPatch {
  status?: FileTreeStudyPlaceholderStatus
  copiedPath?: string
  errorMessage?: string
}

export interface DispatchFileTreeExternalDropArgs {
  payload: FileTreeExternalDropPayload
  action: FileTreeExternalDropAction
  target: FileTreeDropTarget
  onPlaceholderStart?: (placeholder: FileTreeExternalDropPlaceholder) => void
  onPlaceholderUpdate?: (taskId: string, patch: FileTreeExternalDropPlaceholderPatch) => void
  /** Optional separate callbacks for the study-side placeholder (used by
   * the 'content-study' action which produces two placeholders). */
  onStudyPlaceholderStart?: (placeholder: FileTreeExternalDropPlaceholder) => void
  onStudyPlaceholderUpdate?: (taskId: string, patch: FileTreeStudyPlaceholderPatch) => void
  onAnalysisPlaceholderStart?: (placeholder: FileTreeAnalysisPlaceholder) => void
  onAnalysisPlaceholderUpdate?: (taskId: string, patch: FileTreeAnalysisPlaceholderPatch) => void
}

export async function dispatchFileTreeExternalDropAction({
  payload,
  action,
  target,
  onPlaceholderStart,
  onPlaceholderUpdate,
  onStudyPlaceholderStart,
  onStudyPlaceholderUpdate,
  onAnalysisPlaceholderStart,
  onAnalysisPlaceholderUpdate,
}: DispatchFileTreeExternalDropArgs): Promise<void> {
  if (payload.type === 'web-download-url' || payload.type === 'ready-board-selection') return

  const targetDir =
    target.kind === 'inside-directory' ? target.dirPath : target.containerPath
  const targetHint =
    target.kind === 'inside-directory' ? target.itemPath : target.anchorPath

  if (action === 'content-study') {
    const url = payload.type === 'browser-tab' ? payload.url : payload.link
    const titleRaw =
      payload.type === 'browser-tab'
        ? payload.title
        : payload.title || payload.name
    const rng = Math.random().toString(16).slice(2, 8)
    const now = Date.now()
    const clipTaskId = `client-${now}-${rng}-clip`
    const studyTaskId = `client-${now}-${rng}-study`
    let urlHost = ''
    try {
      urlHost = new URL(url).host || url
    } catch {
      urlHost = url
    }
    onPlaceholderStart?.({
      taskId: clipTaskId,
      targetDir,
      urlHost,
      title: titleRaw || urlHost,
      status: 'running',
      createdAt: now,
    })
    onStudyPlaceholderStart?.({
      taskId: studyTaskId,
      targetDir,
      urlHost,
      title: titleRaw || urlHost,
      status: 'running',
      createdAt: now,
    })
    try {
      const ack = await window.electronAPI?.browser?.contentStudyDraggedTab?.({
        url,
        title: titleRaw,
        target_hint: targetHint,
        target_dir: targetDir,
        client_task_id_clip: clipTaskId,
        client_task_id_study: studyTaskId,
      })
      if (!ack?.ok) {
        const msg = ack?.errorDetail?.message ?? '内容学习启动失败'
        onPlaceholderUpdate?.(clipTaskId, { status: 'failed', errorMessage: msg })
        onStudyPlaceholderUpdate?.(studyTaskId, { status: 'failed', errorMessage: msg })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onPlaceholderUpdate?.(clipTaskId, { status: 'failed', errorMessage: msg })
      onStudyPlaceholderUpdate?.(studyTaskId, { status: 'failed', errorMessage: msg })
    }
    return
  }

  if (action === 'web-clip') {
    const url = payload.type === 'browser-tab' ? payload.url : payload.link
    const titleRaw =
      payload.type === 'browser-tab'
        ? payload.title
        : payload.title || payload.name
    const clientTaskId = `client-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    let urlHost = ''
    try {
      urlHost = new URL(url).host || url
    } catch {
      urlHost = url
    }
    onPlaceholderStart?.({
      taskId: clientTaskId,
      targetDir,
      urlHost,
      title: titleRaw || urlHost,
      status: 'running',
      createdAt: Date.now(),
    })
    try {
      if (payload.type === 'browser-tab' && window.electronAPI?.browser?.clipCurrentTab) {
        const result = await window.electronAPI.browser.clipCurrentTab({
          tab_id: payload.tabId,
          target_hint: targetHint,
          target_dir: targetDir,
        })
        if (!result?.ok) {
          onPlaceholderUpdate?.(clientTaskId, {
            status: 'failed',
            errorMessage: typeof result?.errorDetail?.message === 'string'
              ? result.errorDetail.message
              : result?.errorKind ?? '剪藏失败',
          })
          return
        }
        if (result.copyError) {
          onPlaceholderUpdate?.(clientTaskId, {
            status: 'failed',
            copiedPath: result.savedPath,
            errorMessage: `剪藏未能写入目标目录：${result.copyError.message}`,
          })
          return
        }
        onPlaceholderUpdate?.(clientTaskId, {
          status: 'completed',
          copiedPath: result.copiedPath || result.savedPath,
          message: result.imageDownloadFailures && result.imageDownloadFailures > 0
            ? `图片未全部保存：${result.imageDownloadFailures} 张仍为远程链接`
            : null,
        })
        return
      }

      const ack = await window.electronAPI?.browser?.clipDraggedTab?.({
        url,
        title: titleRaw,
        target_hint: targetHint,
        target_dir: targetDir,
        client_task_id: clientTaskId,
      })
      if (!ack?.ok) {
        onPlaceholderUpdate?.(clientTaskId, {
          status: 'failed',
          errorMessage: ack?.errorDetail?.message ?? '剪藏启动失败',
        })
      }
    } catch (err) {
      onPlaceholderUpdate?.(clientTaskId, {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  const mappedAction = action === 'copy-analysis' ? 'copy' : 'visual'
  const baseParams =
    payload.type === 'rss-item'
      ? {
          itemId: payload.id,
          link: payload.link,
          title: payload.title || payload.name,
          source: payload.source,
          summary: payload.summary,
          publishedAt: payload.publishedAt,
        }
      : {
          itemId: buildBrowserTabAnalysisItemId(payload.url),
          link: payload.url,
          title: payload.title,
          source: 'browser-tab',
          summary: undefined as string | undefined,
          publishedAt: undefined as string | undefined,
        }

  const now = Date.now()
  const clientTaskId = `client-${now}-${Math.random().toString(16).slice(2, 8)}-${mappedAction}-analysis`
  let urlHost = ''
  try {
    urlHost = new URL(baseParams.link).host || baseParams.link
  } catch {
    // silent-catch: URL parse fallback for analysis placeholder host display; raw link is shown if parse fails. No user-facing impact.
    urlHost = baseParams.link
  }
  onAnalysisPlaceholderStart?.({
    taskId: clientTaskId,
    itemId: baseParams.itemId,
    action: mappedAction,
    targetDir,
    urlHost,
    title: baseParams.title || urlHost,
    status: 'queued',
    progress: 3,
    message: '正在提交后台任务',
    createdAt: now,
  })

  try {
    const result = await window.electronAPI?.rss?.startItemAnalysis?.({
      ...baseParams,
      action: mappedAction,
      targetDir,
    })
    if (!result) {
      onAnalysisPlaceholderUpdate?.(clientTaskId, {
        status: 'failed',
        progress: 0,
        errorMessage: '当前环境暂不支持后台分析',
      })
      return
    }
    if (!result.success) {
      onAnalysisPlaceholderUpdate?.(clientTaskId, {
        status: 'failed',
        progress: 0,
        errorMessage: result.error || '分析启动失败',
      })
      return
    }
    if (result.data) {
      onAnalysisPlaceholderUpdate?.(clientTaskId, {
        jobId: result.data.id,
        status: result.data.status,
        progress: result.data.progress,
        message: result.data.message,
        outputDir: result.data.outputDir,
        reportPath: result.data.reportPath,
        copiedPath: result.data.reportPath || result.data.outputDir,
        errorMessage: result.data.error || undefined,
      })
    }
  } catch (err) {
    // silent-catch: failure is surfaced to renderer via onAnalysisPlaceholderUpdate(status: 'failed') below — the placeholder UI shows the error message directly to the user.
    onAnalysisPlaceholderUpdate?.(clientTaskId, {
      status: 'failed',
      progress: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  }
}
