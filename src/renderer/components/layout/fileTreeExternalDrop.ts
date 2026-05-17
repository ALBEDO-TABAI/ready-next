import type React from 'react'

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

export type FileTreeExternalDropPayload = BrowserTabDragPayload | RSSItemDragPayload

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
          itemId: payload.tabId,
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
    onAnalysisPlaceholderUpdate?.(clientTaskId, {
      status: 'failed',
      progress: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  }
}
