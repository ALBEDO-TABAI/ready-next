/**
 * P3 Phase B5（2026-07-05，纯移动拆分）— browser-tools 采集/内容任务组。
 *
 * 从 browser-tools.ts 逐字搬出十九个 case 的实现体（browser_collect /
 * browser_resources / browser_download(mode=resolve) / browser_download /
 * browser_download / browser_collect /
 * browser_collect / browser_collect(mode=start) / browser_task(action=get) /
 * browser_task(action=resume) / browser_task(action=cancel) / browser_task(action=result) /
 * browser_download(mode=gallery) / browser_collect(mode=research) / internal_browser_workflow /
 * internal_site_strategy_stage / browser_collect / browser_collect /
 * browser_collection_ui_confirmation，经 executeBrowserCollectionTool 统一入口
 * 分发）与本组独占 helper（采集共识 store/投影、来源校验、任务接力判定、
 * 图库/媒体接力下载组装等）。runWorkflowStep（与 browser_search /
 * browser_click 等留守 case 深度共享的守卫执行层）留在 browser-tools，
 * 经 BrowserCollectionToolContext 注入回接；resolveHighControlAgentTab /
 * activePageLikelyMatchesTarget 因留守 case 同时使用而移入
 * browser-tool-shared.ts。本模块零反向 import。行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import { broadcastDirectoryChanged } from '../document-engine/ipc/directory-change-broadcast'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createRotatingLogger } from '../../utils/rotating-logger'
import type {
  BrowserCapabilityTaskHandle,
  BrowserStructuredFieldMapping,
} from '../browser-engine/capability-types'
import { normalizeBrowserTaskFailedItems } from '../browser-engine/content-task-runner'
import type { BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import { normalizeCollectionTargets, targetsFromTask, type BrowserCollectionTarget } from '../browser-engine/collection-targets'
import { buildCollectionPlanNotes } from '../browser-engine/collection-handoff'
import { inspectBrowserResources, type BrowserResourceKind } from '../browser-engine/resource-sniffer'
import {
  BrowserCollectionConsentStore,
  type PendingBrowserCollectionConsentRequest,
} from '../browser-engine/browser-collection-consent'
import { resolveFastCardVideo } from '../browser-engine/fastcard-video-resolver'
import type { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import type { ScopeRunSkillProgress } from '../agent-control/contracts/types'
import type { TaskProjectionRecord } from '../agent-control/contracts/run-contracts'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import {
  createBrowserStructuredJsonText as browserStructuredJsonText,
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import {
  downloadUrlsToDirectory,
  expandHomePath,
  imageBoardHarvestUrlCount,
  normalizeDownloadTargets,
  normalizeResourceKinds,
  resolveAuthorizedBrowserDownloadDirectory,
  safeHostname,
  sanitizeFilename,
} from './browser-media-download'
import {
  activePageLikelyMatchesTarget,
  resolveHighControlAgentTab,
  truncate,
} from './browser-tool-shared'

const logger = createRotatingLogger('ready-tools.log')
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

export const __breaksInvariants = [
  'test-only browser collection consent singleton reset mutates shared browser tool state',
]

let collectionConsentStore = new BrowserCollectionConsentStore()

export function __setBrowserCollectionConsentStoreForTests(store: BrowserCollectionConsentStore | null): void {
  collectionConsentStore = store || new BrowserCollectionConsentStore()
}

const RECENT_COLLECTION_HANDOFF_WINDOW_MS = 30 * 60 * 1000

function collectionConsentMessage(request: PendingBrowserCollectionConsentRequest): string {
  return '发现清单尚未证明是完整全量，需要用户明确确认后，才允许只采集当前冻结的部分内容。'
}

async function upsertCollectionConsentProjection(
  runtime: AgentControlRuntime | null | undefined,
  request: PendingBrowserCollectionConsentRequest | undefined,
  summary?: string,
): Promise<void> {
  if (!runtime || !request?.scopeId || !request.sourceTaskId) return
  const store = runtime.getTaskProjectionStore()
  const existing = await store.get(request.sourceTaskId)
  const now = new Date().toISOString()
  const message = summary || collectionConsentMessage(request)
  const progress: ScopeRunSkillProgress = {
    stage: 'pending_consent',
    completed: existing?.progress?.completed ?? null,
    total: existing?.progress?.total ?? null,
    coverage: existing?.progress?.coverage ?? null,
    overallCoverage: existing?.progress?.overallCoverage ?? null,
    fingerprint: request.requestId,
    updatedAt: now,
    lastError: null,
    detail: message,
    activityUpdatedAt: now,
    browserCollectionConsent: {
      requestId: request.requestId,
      consentKind: request.consentKind,
      sourceTaskId: request.sourceTaskId,
      targetHost: request.targetHost || null,
      warningText: request.warningText || null,
      message,
      createdAt: request.createdAt || now,
    },
  }
  const record: TaskProjectionRecord = {
    taskId: request.sourceTaskId,
    taskOrigin: existing?.taskOrigin ?? 'system_background',
    scopeId: request.scopeId,
    runId: request.requestId,
    taskType: existing?.taskType || 'multi_step_task',
    module: 'browser',
    taskTitle: existing?.taskTitle || '浏览器采集确认',
    taskSummary: message,
    status: 'blocked',
    interactionState: 'awaiting_confirmation',
    waitingFor: 'confirmation',
    steps: existing?.steps || [],
    currentStepId: existing?.currentStepId || null,
    budget: existing?.budget || null,
    budgetUsagePercent: existing?.budgetUsagePercent ?? null,
    budgetWarningLevel: existing?.budgetWarningLevel ?? null,
    recoveryHistory: existing?.recoveryHistory || [],
    degradationReason: existing?.degradationReason ?? null,
    blockedReason: message,
    resumableActions: existing?.resumableActions || [],
    continuationRef: existing?.continuationRef || null,
    progress,
    recentArtifacts: existing?.recentArtifacts || [],
    canResume: existing?.canResume ?? false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  if (existing) await store.update(request.sourceTaskId, record)
  else await store.create(record)
}

function normalizeUrlForProvenance(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
    return url.toString()
  } catch {
    // silent-catch: non-URL provenance values fall back to raw text matching.
    return String(value || '').trim()
  }
}

function userTextContainsUrl(userText: string, value: string): boolean {
  const haystack = String(userText || '')
  if (!haystack || !value) return false
  if (haystack.includes(value)) return true
  const normalized = normalizeUrlForProvenance(value)
  if (normalized && haystack.includes(normalized)) return true
  try {
    const url = new URL(value)
    const withoutTrailingSlash = url.toString().replace(/\/+$/g, '')
    if (withoutTrailingSlash && haystack.includes(withoutTrailingSlash)) return true
    const decoded = decodeURIComponent(url.toString())
    if (decoded && haystack.includes(decoded)) return true
  } catch {
    // silent-catch: non-URL provenance values are checked as raw strings only.
  }
  return false
}

function missingUserProvidedUrls(notes: BrowserCollectionTarget[], currentUserText: string): string[] {
  return notes
    .map((note) => note.openUrl || note.canonicalUrl || note.url)
    .filter((url) => !userTextContainsUrl(currentUserText, url))
}

function originOfUrl(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    // silent-catch: invalid URL has no origin for same-origin comparison.
    return null
  }
}

function browserTaskTimestampMs(task: BrowserCapabilityTaskHandle): number {
  const raw = task.updatedAt || task.createdAt || ''
  const parsed = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function resultObject(task: BrowserCapabilityTaskHandle | null): Record<string, unknown> | null {
  return task?.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
}

function sourceTaskDiscoveryStatus(task: BrowserCapabilityTaskHandle | null): 'complete' | 'partial' | 'paused' | 'unknown' {
  const result = resultObject(task)
  const explicit = String(result?.discoveryStatus || '').trim()
  if (explicit === 'complete' || explicit === 'partial' || explicit === 'paused') return explicit
  const stopReason = String(result?.stopReason || '').trim()
  if (stopReason === 'no_new_content') return 'complete'
  if (stopReason === 'cancelled' || stopReason === 'lease_lost') return 'paused'
  if (stopReason) return 'partial'
  return 'unknown'
}

function isCompleteSourceTask(task: BrowserCapabilityTaskHandle | null): boolean {
  return Boolean(task && task.kind === 'visible_collect' && task.status === 'completed' && sourceTaskDiscoveryStatus(task) === 'complete')
}

function mediaUrlsFromVisibleCollectTask(task: BrowserCapabilityTaskHandle | null): string[] {
  const result = resultObject(task)
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: unknown): void => {
    const url = String(value || '').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    out.push(url)
  }
  if (Array.isArray(result?.mediaCandidates)) {
    for (const value of result.mediaCandidates) push(value)
  }
  if (out.length > 0) return out
  const items = Array.isArray(result?.items) ? result.items : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (Array.isArray(record.media)) {
      for (const value of record.media) push(value)
    }
    push(record.link)
    push(record.image)
    const rawFields = record.rawFields && typeof record.rawFields === 'object'
      ? record.rawFields as Record<string, unknown>
      : null
    push(rawFields?.link)
    push(rawFields?.image)
    if (Array.isArray(rawFields?.media)) {
      for (const value of rawFields.media) push(value)
    }
  }
  return out
}

/** EP2 dogfood gap 1 — when this scope already ran an image-gallery
 *  discovery, raw URL downloads break the collection chain (card never
 *  learns about the files). Find the newest gallery source task for the
 *  scope so the dispatch can redirect, including paused partial sources. */
async function findScopeImageGallerySourceTask(
  controller: BrowserController,
  scopeId: string | null | undefined,
): Promise<BrowserCapabilityTaskHandle | null> {
  if (!scopeId) return null
  const list = (controller as { listTasksByKind?: (kind: string) => Promise<BrowserCapabilityTaskHandle[]> }).listTasksByKind
  if (typeof list !== 'function') return null
  try {
    const tasks = await list.call(controller, 'visible_collect')
    const getPayload = (controller as { getTaskPayload?: (taskId: string) => Record<string, unknown> | null }).getTaskPayload
    const candidates = tasks.filter((task) => {
      if (task.status === 'failed' || task.status === 'cancelled') return false
      const payload = typeof getPayload === 'function' ? (getPayload.call(controller, task.taskId) || null) : null
      if (stringField(payload?.scopeId) !== scopeId) return false
      return isImageGallerySourceTask(task, payload) && mediaUrlsFromVisibleCollectTask(task).length > 0
    })
    return candidates.sort((a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null
  } catch {
    return null
  }
}

function isImageGallerySourceTask(
  task: BrowserCapabilityTaskHandle | null,
  payload: Record<string, unknown> | null,
): boolean {
  if (!task || task.kind !== 'visible_collect') return false
  const result = resultObject(task)
  return String(result?.template || payload?.template || '').trim() === 'image_gallery'
}

/** P0.1 — the failed counterpart of findScopeImageGallerySourceTask: a recent
 *  FAILED image-gallery collection for this scope. After it, the model must
 *  NOT silently fall back to manual `browser_download`; it should retry /
 *  resume the structured collection so the card, evidence and learning stay on
 *  the collection chain. Bounded to the handoff window so a stale failure from
 *  hours ago no longer blocks an unrelated raw download. */
async function findScopeRecentFailedImageGalleryTask(
  controller: BrowserController,
  scopeId: string | null | undefined,
): Promise<BrowserCapabilityTaskHandle | null> {
  if (!scopeId) return null
  const list = (controller as { listTasksByKind?: (kind: string) => Promise<BrowserCapabilityTaskHandle[]> }).listTasksByKind
  if (typeof list !== 'function') return null
  try {
    const tasks = await list.call(controller, 'visible_collect')
    const getPayload = (controller as { getTaskPayload?: (taskId: string) => Record<string, unknown> | null }).getTaskPayload
    const now = Date.now()
    const candidates = tasks.filter((task) => {
      if (task.status !== 'failed') return false
      // A failed task we cannot date must NOT block downloads indefinitely —
      // treat an unparseable/missing timestamp as "not recent" (fail-open).
      const timestamp = browserTaskTimestampMs(task)
      if (timestamp <= 0 || now - timestamp > RECENT_COLLECTION_HANDOFF_WINDOW_MS) return false
      const payload = typeof getPayload === 'function' ? (getPayload.call(controller, task.taskId) || null) : null
      if (stringField(payload?.scopeId) !== scopeId) return false
      return isImageGallerySourceTask(task, payload)
    })
    return candidates.sort((a, b) =>
      String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null
  } catch {
    return null
  }
}

function hasSharedOrigin(
  left: Array<{ url: string }>,
  right: Array<{ url: string }>,
): boolean {
  const origins = new Set(left.map((item) => originOfUrl(item.url)).filter(Boolean))
  if (origins.size === 0) return false
  return right.some((item) => {
    const origin = originOfUrl(item.url)
    return Boolean(origin && origins.has(origin))
  })
}

async function findLargerRecentFrozenCollection(
  controller: BrowserController,
  notes: Array<{ url: string }>,
): Promise<{ taskId: string; count: number } | null> {
  const listTasks = (controller as { listAgentCollectionTasks?: () => Promise<BrowserCapabilityTaskHandle[]> }).listAgentCollectionTasks
  if (typeof listTasks !== 'function' || notes.length === 0) return null

  const now = Date.now()
  const tasks = await listTasks.call(controller)
  for (const task of tasks) {
    if (task.kind !== 'visible_collect') continue
    const timestamp = browserTaskTimestampMs(task)
    if (timestamp > 0 && now - timestamp > RECENT_COLLECTION_HANDOFF_WINDOW_MS) continue
    const frozen = targetsFromTask(task)
    if (frozen.length <= notes.length) continue
    if (!hasSharedOrigin(frozen, notes)) continue
    return { taskId: task.taskId, count: frozen.length }
  }
  return null
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function enrichBrowserTaskPayload(task: BrowserCapabilityTaskHandle): BrowserCapabilityTaskHandle & {
  failedItems: ReturnType<typeof normalizeBrowserTaskFailedItems>
  suggestedNextAction: string
} {
  const result = task.result && typeof task.result === 'object' ? task.result as Record<string, unknown> : null
  const failedItems = normalizeBrowserTaskFailedItems(result?.failed)
  return {
    ...task,
    failedItems,
    suggestedNextAction: failedItems.length === 0
      ? 'done'
      : failedItems.some((item) => item.retryable)
        ? 'retry_failed'
        : 'review_manually',
  }
}

const COLLECTION_TASK_RESULT_SUMMARY_KEYS = [
  'status',
  'verdict',
  'labelKey',
  'discoveryStatus',
  'frozenCount',
  'expectedCount',
  'remaining',
  'rounds',
  'stopReason',
  'sourceTaskId',
  'targetUrl',
  'outputRootDir',
  'reportPath',
  'manifestPath',
  'hasMoreLikely',
  'userExpectedTotal',
  'autoContinue',
  'resumeFromCursor',
  'summary',
  'suggestedNextTool',
  'suggestedContinueTool',
] as const

function compactCollectionTaskPayload(
  task: BrowserCapabilityTaskHandle,
  linkedExecution?: BrowserCapabilityTaskHandle | null,
): Record<string, unknown> {
  const result = task.result && typeof task.result === 'object' && !Array.isArray(task.result)
    ? task.result as Record<string, unknown>
    : null
  const resultSummary: Record<string, unknown> = {}
  for (const key of COLLECTION_TASK_RESULT_SUMMARY_KEYS) {
    if (result?.[key] !== undefined) resultSummary[key] = result[key]
  }
  const collectedCount = Array.isArray(result?.collected)
    ? result.collected.length
    : Array.isArray(result?.notes)
      ? result.notes.length
      : undefined
  const normalizedFailedItems = normalizeBrowserTaskFailedItems(result?.failed)
  const failedItems = normalizedFailedItems.slice(0, 20)
  const compact = {
    taskId: task.taskId,
    kind: task.kind,
    status: task.status,
    progress: task.progress,
    checkpoint: task.checkpoint
      ? {
          taskId: task.checkpoint.taskId,
          stage: task.checkpoint.stage,
          cursor: task.checkpoint.cursor ?? null,
        }
      : null,
    result: {
      ...resultSummary,
      ...(collectedCount !== undefined ? { collectedCount } : {}),
      failedCount: normalizedFailedItems.length,
    },
    failedItems,
    suggestedNextAction: failedItems.length === 0
      ? 'done'
      : failedItems.some((item) => item.retryable)
        ? 'retry_failed'
        : 'review_manually',
    error: task.error ?? null,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    updatedAt: task.updatedAt,
  }
  return linkedExecution
    ? { ...compact, activeExecution: compactCollectionTaskPayload(linkedExecution) }
    : compact
}

function browserTaskToolPayload(
  task: BrowserCapabilityTaskHandle,
  linkedExecution?: BrowserCapabilityTaskHandle | null,
): Record<string, unknown> | BrowserCapabilityTaskHandle {
  return task.kind === 'visible_collect' || task.kind === 'note_collect' || task.kind === 'card_loop'
    ? compactCollectionTaskPayload(task, linkedExecution)
    : enrichBrowserTaskPayload(task)
}

function normalizedPathField(value: unknown): string {
  const raw = stringField(value)
  return raw ? expandHomePath(raw) : ''
}

function sourceTaskHandoffMismatch(
  sourceTaskId: string,
  sourcePayload: Record<string, unknown> | null,
  sourceResult: Record<string, unknown> | null,
  sessionId: string | undefined,
  requestedOutputRootDir: string,
): { errorCode: string; message: string } | null {
  const sourceScopeId = stringField(sourcePayload?.scopeId)
  if (sessionId && sourceScopeId && sourceScopeId !== sessionId) {
    return {
      errorCode: 'stale_source_task_scope',
      message: `source_task_id ${sourceTaskId} 属于另一个会话，不能接力到当前采集。请使用本轮 browser_collect 返回的 source_task_id。`,
    }
  }
  const sourceOutputRootDir = normalizedPathField(sourceResult?.outputRootDir) || normalizedPathField(sourcePayload?.outputRootDir)
  if (requestedOutputRootDir && sourceOutputRootDir && sourceOutputRootDir !== requestedOutputRootDir) {
    return {
      errorCode: 'stale_source_task_output',
      message: `source_task_id ${sourceTaskId} 的保存目录与当前请求不一致，不能用旧发现清单接力。请使用本轮 browser_collect 返回的 source_task_id。`,
    }
  }
  return null
}

function isLikelyReadyNonBrowserTaskId(taskId: string): boolean {
  if (taskId.startsWith('skill-child:') || taskId.startsWith('skill:')) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return true
  if (/^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return true
  if (/^task-(?!\d+$).+/.test(taskId)) return true
  return false
}

function wrongBrowserTaskIdPayload(toolName: string, taskId: string): Record<string, unknown> {
  return {
    ok: false,
    errorCode: 'wrong_browser_task_id_type',
    taskId,
    status: 'wrong_id_type',
    message: `${toolName} 只能处理浏览器后台任务 id。这个 id 更像 Ready 聊天任务或技能子任务，请改用对应任务卡/技能续跑入口。`,
  }
}

/**
 * B5 注入面：runWorkflowStep 的实现体留在 browser-tools.ts（与 browser_search /
 * browser_click 等留守 case 深度共享），以函数引用注入；
 * candidateTargetUrls / leaseGate / runtime 是 executeBrowserTool 预备段的
 * 每次调用态，随调用传入。本模块不反向 import browser-tools，防循环依赖。
 */
export interface BrowserCollectionToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  currentUserText?: string
  leaseGate?: BrowserLeaseGate
  runtime?: AgentControlRuntime | null
  candidateTargetUrls: string[]
  taskExecutionContext?: {
    ownerAgentId?: string | null
    ownerRunId?: string | null
    parentTaskId?: string | null
    executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
    workspaceRoots?: string[]
  }
  runWorkflowStep: (
    controller: BrowserController,
    step: Record<string, unknown>,
    fallbackTabId: string | null,
    signal?: AbortSignal,
  ) => Promise<string>
}

export async function executeBrowserCollectionTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserCollectionToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, currentUserText, leaseGate, runtime, candidateTargetUrls, runWorkflowStep, taskExecutionContext } = ctx
  const collectionOwnership = {
    ...(taskExecutionContext?.ownerAgentId ? { ownerAgentId: taskExecutionContext.ownerAgentId } : {}),
    ...(taskExecutionContext?.ownerRunId ? { ownerRunId: taskExecutionContext.ownerRunId } : {}),
    ...(taskExecutionContext?.parentTaskId ? { parentTaskId: taskExecutionContext.parentTaskId } : {}),
    ...(taskExecutionContext?.executionBinding ? { executionBinding: taskExecutionContext.executionBinding } : {}),
  }
  switch (toolName) {
      case 'collect_images': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const keyword = String(args.keyword || '').trim().toLowerCase()
        const limit = Math.max(1, Math.min(60, Number(args.limit || 20)))
        const minWidth = Math.max(1, Math.min(4000, Number(args.min_width || 120)))
        const includeHidden = args.include_hidden === true
        const rows = await controller.executeJS(
          tabId,
          `
            (() => {
              const keyword = ${JSON.stringify(keyword)}
              const maxCount = ${JSON.stringify(limit)}
              const minWidth = ${JSON.stringify(minWidth)}
              const includeHidden = ${JSON.stringify(includeHidden)}
	              const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
	              const urlsFromSrcset = (srcset) => normalize(srcset).split(',').map((part) => normalize(part).split(/\\s+/)[0]).filter(Boolean)
	              const isXiaohongshu = /(^|\\.)xiaohongshu\\.com$/i.test(location.hostname)
	              const possibleXhsDetailRoot = isXiaohongshu ? document.querySelector('.note-container') : null
	              const xhsDetailRoot = possibleXhsDetailRoot && (
	                /\\/explore\\//i.test(location.pathname)
	                || possibleXhsDetailRoot.querySelector('.media-container img, .media-container video, .swiper img, .swiper video')
	              ) ? possibleXhsDetailRoot : null
	              const xhsMediaRoots = xhsDetailRoot
	                ? Array.from(xhsDetailRoot.querySelectorAll('.media-container, .note-slider, .swiper, .swiper-wrapper'))
	                  .filter((el) => el.querySelector('img,video'))
	                : []
              const xhsScopedMedia = Boolean(xhsDetailRoot && xhsMediaRoots.length > 0)
	              const roots = xhsDetailRoot ? (xhsMediaRoots.length > 0 ? xhsMediaRoots : [xhsDetailRoot]) : [document]
	              const queryAll = (selector) => roots.flatMap((root) => Array.from(root.querySelectorAll(selector)))
	              const isVisible = (el) => {
                if (!(el instanceof Element)) return false
                const rect = el.getBoundingClientRect()
                if (!rect || rect.width < minWidth || rect.height < 40) return false
                const style = getComputedStyle(el)
                if (!style) return false
                return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
              }
              const isTopHit = (el, rect) => {
                if (includeHidden) return true
                const points = [
                  [rect.left + rect.width / 2, rect.top + rect.height / 2],
                  [rect.left + rect.width / 2, rect.top + Math.min(rect.height - 1, Math.max(1, rect.height * 0.25))],
                  [rect.left + rect.width / 2, rect.top + Math.min(rect.height - 1, Math.max(1, rect.height * 0.75))],
                ]
                for (const [x, y] of points) {
                  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue
                  const top = document.elementFromPoint(x, y)
                  if (!top) continue
                  if (top === el || el.contains(top) || top.contains(el)) return true
                }
                return false
              }
              const items = []
              const seen = new Set()
              const push = (rawUrl, alt, width, height) => {
                const src = normalize(rawUrl)
                if (!src || !/^https?:\\/\\//i.test(src)) return
                if (seen.has(src)) return
                const w = Math.round(Number(width || 0))
                const h = Math.round(Number(height || 0))
                if ((w > 0 && w < minWidth) || (h > 0 && h < 40)) return
                const scoreText = (src + ' ' + normalize(alt)).toLowerCase()
                if (keyword && !scoreText.includes(keyword)) return
                seen.add(src)
                items.push({ url: src, alt: normalize(alt), width: w, height: h })
              }
              const videos = []
              const videoSeen = new Set()
              const cleanMediaUrl = (rawUrl) => {
                let value = normalize(rawUrl)
                for (let i = 0; i < 2; i += 1) {
                  value = value
                    .replaceAll('\\\\u002F', '/')
                    .replaceAll('\\\\u002f', '/')
                    .replaceAll('\\\\/', '/')
                }
                try { value = decodeURIComponent(value) } catch {}
                value = value.replace(/&amp;/g, '&')
                while (/[)\\],.;]$/.test(value)) value = value.slice(0, -1)
                return value
              }
              const isDirectVideoUrl = (rawUrl) => {
                const src = cleanMediaUrl(rawUrl)
                if (!/^https?:\\/\\//i.test(src)) return false
                const lower = src.toLowerCase()
                if (/\\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(lower)) return false
                return /(?:^|[.-])sns-video[.-]/i.test(lower)
                  || /\\.(?:mp4|m4v|mov|webm|m3u8)(?:[?#]|$)/i.test(lower)
              }
              const pushVideo = (rawUrl, rawPoster, width, height) => {
                if (videos.length >= maxCount) return
                const src = cleanMediaUrl(rawUrl)
                const poster = cleanMediaUrl(rawPoster)
                if (src && !isDirectVideoUrl(src)) return
                if (!src && !poster) return
                const key = src || \`poster:\${poster}\`
                if (videoSeen.has(key)) return
                videoSeen.add(key)
                videos.push({
                  url: src,
                  posterUrl: poster,
                  width: Math.round(Number(width || 0)),
                  height: Math.round(Number(height || 0)),
                })
              }
              const urlsFromText = (text) => {
                const normalizedText = cleanMediaUrl(text)
                const urls = []
                const pattern = /https?:\\/\\/[^"'\\\\<>\\s]+/gi
                let match = null
                while ((match = pattern.exec(normalizedText)) && urls.length < maxCount) {
                  urls.push(match[0])
                }
                return urls
              }
              const carouselExpectedCount = (() => {
                if (!xhsDetailRoot) return 0
                const totals = []
                const pushTotal = (value) => {
                  const n = Number(value)
                  if (Number.isFinite(n) && n > 1 && n <= maxCount) totals.push(n)
                }
                const textSources = [
                  xhsDetailRoot.textContent || '',
                  ...Array.from(xhsDetailRoot.querySelectorAll('[aria-label], [title], [data-count], [data-total], [class*="pagination" i], [class*="indicator" i]'))
                    .map((node) => [
                      node.textContent || '',
                      node.getAttribute('aria-label') || '',
                      node.getAttribute('title') || '',
                      node.getAttribute('data-count') || '',
                      node.getAttribute('data-total') || '',
                    ].join(' ')),
                ].map(normalize)
                for (const text of textSources) {
                  let match = null
                  const slashPattern = /(?:^|[^0-9])(\\d{1,2})\\s*\\/\\s*(\\d{1,2})(?:[^0-9]|$)/g
                  while ((match = slashPattern.exec(text))) pushTotal(match[2])
                  const totalPatterns = [
                    /共\\s*(\\d{1,2})\\s*(?:张|圖|图|pics?|images?)/gi,
                    /(\\d{1,2})\\s*(?:张|圖|图)\\s*(?:图片|照片|图集)/g,
                  ]
                  for (const pattern of totalPatterns) {
                    while ((match = pattern.exec(text))) pushTotal(match[1])
                  }
                }
                const bulletCount = Array.from(xhsDetailRoot.querySelectorAll('[class*="bullet" i], [class*="dot" i], [class*="indicator" i]'))
                  .filter((node) => {
                    if (!(node instanceof Element)) return false
                    const rect = node.getBoundingClientRect()
                    const style = getComputedStyle(node)
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
                  }).length
                if (bulletCount > 1 && bulletCount <= maxCount) totals.push(bulletCount)
                return totals.length > 0 ? Math.max(...totals) : 0
              })()
              const hasCarouselSignal = Boolean(xhsDetailRoot && (
                carouselExpectedCount > 1
                || xhsDetailRoot.querySelectorAll('.swiper-slide, [class*="slide" i], [class*="swiper" i] img, [class*="carousel" i] img').length > 1
                || xhsDetailRoot.querySelector('[class*="next" i], [aria-label*="下一" i], [aria-label*="next" i], [class*="pagination" i], [class*="indicator" i]')
              ))
	              const imgs = queryAll('img')
              for (const img of imgs) {
                if (!(img instanceof HTMLImageElement)) continue
                const alt = normalize(img.alt || img.getAttribute('title') || '')
                const rect = img.getBoundingClientRect()
                const visible = isVisible(img)
                if (!xhsScopedMedia) {
                  if (!visible && !includeHidden) continue
                  if (visible && !isTopHit(img, rect)) continue
                }
                const width = img.naturalWidth || img.width || rect.width || 0
                const height = img.naturalHeight || img.height || rect.height || 0
                const candidates = [
                  img.currentSrc,
                  img.src,
                  img.getAttribute('data-src'),
                  img.getAttribute('data-original'),
                  img.getAttribute('data-lazy-src'),
                  ...urlsFromSrcset(img.srcset || img.getAttribute('data-srcset') || ''),
                ]
                for (const candidate of candidates) push(candidate, alt, width, height)
                if (items.length >= maxCount) break
              }
	              if (includeHidden && items.length < maxCount) {
	                for (const source of queryAll('source[srcset]')) {
                  for (const candidate of urlsFromSrcset(source.getAttribute('srcset') || '')) {
                    push(candidate, source.getAttribute('type') || '', 0, 0)
                    if (items.length >= maxCount) break
                  }
                  if (items.length >= maxCount) break
                }
              }
	              if (!xhsDetailRoot && includeHidden && items.length < maxCount) {
	                for (const meta of Array.from(document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], link[rel="image_src"]'))) {
                  push(meta.getAttribute('content') || meta.getAttribute('href') || '', meta.getAttribute('property') || meta.getAttribute('name') || '', 0, 0)
                  if (items.length >= maxCount) break
	                }
              }
              for (const video of queryAll('video')) {
                  if (!(video instanceof HTMLVideoElement)) continue
                  const rect = video.getBoundingClientRect()
                  const visible = isVisible(video)
                  if (!xhsScopedMedia) {
                    if (!visible && !includeHidden) continue
                    if (visible && !isTopHit(video, rect)) continue
                  }
                  const sourceUrls = Array.from(video.querySelectorAll('source'))
                    .map((source) => source instanceof HTMLSourceElement ? source.src || source.getAttribute('src') || '' : '')
                  const candidates = [
                    video.currentSrc,
                    video.src,
                    video.getAttribute('src'),
                    ...sourceUrls,
                  ].filter(Boolean)
                  const direct = candidates.find((candidate) => isDirectVideoUrl(candidate)) || candidates[0] || ''
                  pushVideo(
                    direct,
                    video.poster || video.getAttribute('poster') || '',
                    video.videoWidth || rect.width || 0,
                    video.videoHeight || rect.height || 0,
                  )
                }
              if ((isXiaohongshu || includeHidden) && videos.length < maxCount) {
                for (const node of Array.from(document.querySelectorAll('[src], [data-src], [href]'))) {
                  if (!(node instanceof Element)) continue
                  for (const attr of ['src', 'data-src', 'href']) {
                    const candidate = node.getAttribute(attr) || ''
                    if (isDirectVideoUrl(candidate)) pushVideo(candidate, '', 0, 0)
                    if (videos.length >= maxCount) break
                  }
                  if (videos.length >= maxCount) break
                }
              }
              if ((isXiaohongshu || includeHidden) && videos.length < maxCount) {
                for (const script of Array.from(document.querySelectorAll('script'))) {
                  for (const candidate of urlsFromText(script.textContent || '')) {
                    if (isDirectVideoUrl(candidate)) pushVideo(candidate, '', 0, 0)
                    if (videos.length >= maxCount) break
                  }
                  if (videos.length >= maxCount) break
                }
              }
              if (videos.length < maxCount) {
                try {
                  const entries = performance && typeof performance.getEntriesByType === 'function'
                    ? performance.getEntriesByType('resource')
                    : []
                  for (const entry of entries) {
                    const candidate = entry && typeof entry.name === 'string' ? entry.name : ''
                    if (isDirectVideoUrl(candidate)) pushVideo(candidate, '', 0, 0)
                    if (videos.length >= maxCount) break
                  }
                } catch {}
              }
              if (xhsDetailRoot && videos.length === 0 && items.length === 0) {
                const videoMarker = queryAll('[poster], source, canvas, [class*="video" i], [class*="player" i], [class*="play" i], [class*="poster" i]')
                  .find((node) => {
                    if (!(node instanceof Element)) return false
                    const meta = normalize([
                      node.getAttribute('class'),
                      node.getAttribute('aria-label'),
                      node.getAttribute('title'),
                      node.getAttribute('poster'),
                      node.getAttribute('src'),
                    ].filter(Boolean).join(' ')).toLowerCase()
                    return /video|player|play|poster|xgplayer/.test(meta)
                  })
                if (videoMarker) {
                  const rect = videoMarker instanceof HTMLElement ? videoMarker.getBoundingClientRect() : null
                  pushVideo(
                    videoMarker.getAttribute('src') || '',
                    videoMarker.getAttribute('poster') || '',
                    rect?.width || 0,
                    rect?.height || 0,
                  )
                }
              }
              return { images: items, videos, scope: xhsDetailRoot ? 'xiaohongshu-detail' : 'document', expectedImageCount: carouselExpectedCount || undefined, hasCarouselSignal }
            })()
          `,
        ) as { images?: Array<{ url?: string; alt?: string; width?: number; height?: number }>; videos?: Array<{ url?: string; posterUrl?: string; width?: number; height?: number }>; scope?: string; expectedImageCount?: number; hasCarouselSignal?: boolean } | Array<{ url?: string; alt?: string; width?: number; height?: number }> | null

        const structuredRows = !Array.isArray(rows) && rows ? rows : null
        const rawImages = Array.isArray(rows) ? rows : Array.isArray(structuredRows?.images) ? structuredRows.images : []
        const videos = Array.isArray(structuredRows?.videos)
          ? structuredRows.videos
            .map((item) => ({
              url: String(item.url || ''),
              posterUrl: String(item.posterUrl || ''),
              width: Number(item.width || 0),
              height: Number(item.height || 0),
            }))
          : []
        const images = rawImages
          .map((item) => ({
            url: String(item.url || ''),
            alt: String(item.alt || ''),
            width: Number(item.width || 0),
            height: Number(item.height || 0),
          }))
          .filter((item) => item.url.length > 0)
        const expectedImageCount = Number(structuredRows?.expectedImageCount)

        return JSON.stringify({
          count: images.length,
          images,
          videoCount: videos.length,
          videos,
          ...(typeof structuredRows?.scope === 'string' ? { scope: structuredRows.scope } : {}),
          ...(Number.isFinite(expectedImageCount) && expectedImageCount > 0
            ? { expectedImageCount }
            : {}),
          ...(structuredRows?.hasCarouselSignal === true ? { hasCarouselSignal: true } : {}),
        }, null, 2)
      }

      case 'resources': {
        const url = String(args.url || '').trim()
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, {
          navigateToTarget: false,
          signal: abortSignal,
        })).tabId
        const result = await inspectBrowserResources(controller, {
          tabId,
          url: url || null,
          kinds: normalizeResourceKinds(args.kinds),
          waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          signal: abortSignal,
        })
        return stringifyBrowserJsonOrFailure({ ...result })
      }

      case 'download_resolve': {
        let tabId = (args.tab_id as string) || null
        tabId = (await resolveHighControlAgentTab(controller, args, { signal: abortSignal })).tabId
        const tabs = controller.getTabList()
        const tab = (tabId ? tabs.find((item) => item.id === tabId) : null)
          || tabs.find((item) => item.active)
          || tabs[0]
          || null
        const effectiveTabId = tabId || tab?.id || null
        const pageUrl = String(args.page_url || args.url || tab?.url || '').trim()
        const videoUrl = String(args.video_url || '').trim()
        const posterUrl = String(args.poster_url || '').trim()
        const title = String(args.title || tab?.title || '').trim()
        const sources = Array.isArray(args.sources)
          ? args.sources.map((item) => String(item || '').trim()).filter(Boolean)
          : []

        if (!pageUrl && !videoUrl && sources.length === 0) {
          return 'Error: page_url, video_url or sources is required'
        }

        if (!videoUrl && sources.length === 0 && effectiveTabId) {
          const activeUrl = tab?.url || ''
          const canInspectCurrentTab = !pageUrl || activePageLikelyMatchesTarget(activeUrl, pageUrl)
          if (canInspectCurrentTab) {
            const inspected = await inspectBrowserResources(controller, {
              tabId: effectiveTabId,
              kinds: ['video', 'stream'],
              waitMs: 300,
              maxCandidates: 5,
              signal: abortSignal,
            }).catch(() => null)
            const candidate = inspected?.candidates.find((item) => item.kind === 'video' || item.kind === 'stream')
            if (candidate) {
              const video = {
                originalUrl: pageUrl || candidate.sourcePageUrl || candidate.url,
                pageUrl: pageUrl || candidate.sourcePageUrl,
                playableUrl: candidate.url,
                downloadUrl: candidate.url,
                title: title || tab?.title || undefined,
                platform: safeHostname(pageUrl || candidate.sourcePageUrl || candidate.url),
                parseStatus: 'resolved' as const,
              }
              return stringifyBrowserJsonOrFailure({
                ok: true,
                candidateId: candidate.id,
                source: candidate.source,
                evidence: candidate.evidence,
                video,
              })
            }
          }
        }

        const video = (await resolveFastCardVideo({
          target: {
            kind: 'video',
            pageUrl,
            pageTitle: tab?.title || title || undefined,
            domain: pageUrl ? safeHostname(pageUrl) : undefined,
            tabId: effectiveTabId,
            capturedAt: Date.now(),
            ...(videoUrl ? { videoUrl } : {}),
            ...(posterUrl ? { posterUrl } : {}),
            ...(title ? { title } : {}),
            ...(sources.length > 0 ? { sources } : {}),
          },
        })).video

        const payload = {
          ok: video.parseStatus !== 'failed',
          ...(video.parseStatus === 'failed' ? { errorCode: 'video_parse_failed' } : {}),
          video,
        }
        return stringifyBrowserJsonOrFailure(payload)
      }

      case 'download_urls': {
        const rawUrls = Array.isArray(args.urls) ? args.urls : []
        // EP2 dogfood gap 1 — keep downloads ON the collection chain: if this
        // scope already discovered an image gallery, raw URL downloads orphan
        // the files from the collection card. Redirect to the chained tool;
        // an explicitly unrelated download passes with the declaration flag.
        if (args.unrelated_to_collection !== true) {
          // A USABLE (completed/paused-with-media) gallery source wins first:
          // the user should download what was collected, even if an earlier
          // attempt in the same scope failed.
          const chained = await findScopeImageGallerySourceTask(controller, sessionId)
          if (chained) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'use_collected_media_download',
              message: `本会话已有图片采集任务 ${chained.taskId}（已发现 ${mediaUrlsFromVisibleCollectTask(chained).length} 张）。保存这些图片必须用 browser_download(source_task_id) 让下载结果回到采集卡；只有与该采集无关的下载才可以传 unrelated_to_collection: true 继续使用本工具。`,
              sourceTaskId: chained.taskId,
              suggestedNextTool: 'browser_download',
            })
          }
          // P0.1 — otherwise, if the most recent gallery attempt FAILED and there
          // is no usable source to download, do NOT salvage it by switching to
          // manual URL download (that orphans the card, drops the verdict/
          // checkpoint, and downloads thumbnails). Steer back to the structured
          // collection so card, evidence and failure-learning stay on the chain.
          const failedGallery = await findScopeRecentFailedImageGalleryTask(controller, sessionId)
          if (failedGallery) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'image_gallery_collection_failed_retry_required',
              message: `本会话最近的图片采集任务 ${failedGallery.taskId} 失败了（${stringField((failedGallery.result as Record<string, unknown> | null)?.stopReason) || failedGallery.status}）。不要改用 browser_download 手工下载——请用 browser_collect(mode=start) / browser_collect(image_gallery) 重试或 browser_task(action=resume) 续跑，让采集卡、证据和失败学习都留在采集链路上。只有与该采集无关的下载才可以传 unrelated_to_collection: true。`,
              failedTaskId: failedGallery.taskId,
              suggestedNextTool: 'browser_collect',
            })
          }
          // P0.1 — close the original bypass: even with NO prior collection task,
          // a batch dominated by image-board CDN URLs (pinimg) is a board/gallery
          // harvest. Route it through the structured image_gallery chain instead
          // of the ad-hoc collect_images→download_urls path (which loses
          // completeness/verdict/learning and mixes in thumbnails).
          const harvestCount = imageBoardHarvestUrlCount(rawUrls.map((item) => String(item || '')))
          if (harvestCount >= 3) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'use_structured_image_gallery_collection',
              message: `检测到 ${harvestCount} 张图床(pinimg)图片的批量下载，这属于画板/图库采集。请用 browser_collect(image_gallery) 走结构化采集（自动滚动穷尽、按原图去重、产出采集卡与证据），再用 browser_download 保存；不要用 browser_collect + browser_download 手工批量下载。确实是与采集无关的零散下载才传 unrelated_to_collection: true。`,
              suggestedNextTool: 'browser_collect',
            })
          }
        }
        const resolvedDirectory = resolveAuthorizedBrowserDownloadDirectory(args.directory, {
          currentUserText,
          trustedRoots: taskExecutionContext?.workspaceRoots,
        })
        if (!resolvedDirectory.ok) {
          return browserStructuredOutput({
            ok: false,
            errorCode: resolvedDirectory.errorCode,
            message: '目标文件夹没有绑定到当前任务、当前工作区或用户指令。省略目录可使用 Ready 默认下载文件夹。',
            requested: resolvedDirectory.requested,
          })
        }
        return await downloadUrlsToDirectory(controller, {
          urls: rawUrls.map((item) => String(item || '')),
          directory: resolvedDirectory.directory,
          filenamePrefix: String(args.filename_prefix || 'download'),
          overwrite: args.overwrite === true,
          tabId: (args.tab_id as string) || null,
          maxTotalBytes: typeof args.max_total_bytes === 'number' ? args.max_total_bytes : undefined,
          abortSignal,
        })
      }

      case 'download_collected': {
        const sourceTaskId = String(args.source_task_id || '').trim()
        if (!sourceTaskId) return 'Error: source_task_id is required'
        const sourceTask = await controller.getTask(sourceTaskId)
        const sourcePayload = typeof (controller as { getTaskPayload?: (taskId: string) => Record<string, unknown> | null }).getTaskPayload === 'function'
          ? ((controller as { getTaskPayload: (taskId: string) => Record<string, unknown> | null }).getTaskPayload(sourceTaskId) || null)
          : null
        if (!sourceTask) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'source_task_missing',
            message: `source_task_id ${sourceTaskId} 不存在，无法下载已发现图片。`,
            sourceTaskId,
          })
        }
        const sourceOutputRoot = stringField(sourcePayload?.outputRootDir)
          || stringField((sourcePayload?.plan as Record<string, unknown> | undefined)?.outputRootDir)
        const resolvedDirectory = resolveAuthorizedBrowserDownloadDirectory(args.directory, {
          currentUserText,
          trustedRoots: [sourceOutputRoot, ...(taskExecutionContext?.workspaceRoots || [])].filter(Boolean) as string[],
        })
        if (!resolvedDirectory.ok) {
          return browserStructuredOutput({
            ok: false,
            errorCode: resolvedDirectory.errorCode,
            message: '下载目录没有绑定到来源任务、当前工作区或用户指令。',
            requested: resolvedDirectory.requested,
          })
        }
        const directory = resolvedDirectory.directory
        const sourceScopeId = stringField(sourcePayload?.scopeId)
        if (sessionId && sourceScopeId && sourceScopeId !== sessionId) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'stale_source_task_scope',
            message: `source_task_id ${sourceTaskId} 属于另一个会话，不能接力下载。请使用本轮 browser_collect 返回的 source_task_id。`,
            sourceTaskId,
          })
        }
        if (!isImageGallerySourceTask(sourceTask, sourcePayload)) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'source_task_not_image_gallery',
            message: `source_task_id ${sourceTaskId} 不是 browser_collect(image_gallery) 任务，不能用图片下载接力。`,
            sourceTaskId,
            kind: sourceTask.kind,
          })
        }
        if (!isCompleteSourceTask(sourceTask)) {
          const result = resultObject(sourceTask)
          const status = sourceTaskDiscoveryStatus(sourceTask)
          const stopReason = String(result?.stopReason || sourceTask.status || 'unknown')
          const frozenCount = mediaUrlsFromVisibleCollectTask(sourceTask).length
          const hasPartialConsent = collectionConsentStore.hasConsent('partial_collection', sessionId || '', sourceTaskId)
          if (!hasPartialConsent) {
            const pendingConsentRequest = collectionConsentStore.createPendingRequest({
              scopeId: sessionId || '',
              sourceTaskId,
              consentKind: 'partial_collection',
            })
            const message = `source_task_id ${sourceTaskId} 的图片发现还未证明是完整全量（discoveryStatus=${status}, stopReason=${stopReason}, 已发现 ${frozenCount} 张）。请先用 browser_task(action=resume) 继续发现；如果用户明确只下载当前已发现图片，需要先完成部分采集确认。`
            await upsertCollectionConsentProjection(runtime, pendingConsentRequest, message)
            return browserStructuredOutput({
              ok: false,
              errorCode: 'partial_collection_consent_required',
              message,
              sourceTaskId,
              discoveryStatus: status,
              continueTaskId: typeof result?.continueTaskId === 'string' ? result.continueTaskId : sourceTaskId,
              frozenCount,
              allowPartialIgnored: args.allow_partial === true,
              pendingConsentRequest,
            })
          }
        }
        const urls = mediaUrlsFromVisibleCollectTask(sourceTask)
        if (urls.length === 0) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'source_task_has_no_media',
            message: `source_task_id ${sourceTaskId} 没有可下载的图片 URL。`,
            sourceTaskId,
          })
        }
        const result = resultObject(sourceTask)
        const referer = stringField(result?.targetUrl) || stringField(sourcePayload?.url)
        const output = await downloadUrlsToDirectory(controller, {
          urls,
          directory,
          filenamePrefix: String(args.filename_prefix || 'image'),
          overwrite: args.overwrite === true,
          referer,
          tabId: (args.tab_id as string) || null,
          maxTotalBytes: typeof args.max_total_bytes === 'number' ? args.max_total_bytes : undefined,
          abortSignal,
        })
        const outputText = typeof output === 'string' ? output : output.text
        if (outputText.startsWith('Error:')) {
          return browserStructuredJsonText(outputText)
        }
        const parsed = JSON.parse(outputText) as Record<string, unknown>
        // EP2 dogfood gap 2 — completion must reconcile discovered/saved/
        // failed/remaining. A page-claimed total (expected_total) that
        // exceeds the discovered set means undiscovered images remain: this
        // is PARTIAL, never "完成".
        const saved = Number(parsed.success || 0)
        const failed = Number(parsed.failed || 0)
        // discovered must count DISTINCT pins (same dedupe/originals collapse the
        // download applies), else a deduped save reads as a false "partial".
        const discovered = normalizeDownloadTargets(urls).length
        // page-claimed total: explicit arg first, then the source task's own
        // recorded claim (user_expected_total survives in result/payload) —
        // a model that forgets to pass 72 can no longer silence the gap.
        const claimedFromSource = Number(result?.userExpectedTotal ?? sourcePayload?.userExpectedTotal ?? sourcePayload?.user_expected_total ?? 0) || 0
        const expectedTotal = Number.isFinite(Number(args.expected_total)) && Number(args.expected_total) > 0
          ? Number(args.expected_total)
          : (claimedFromSource > 0 ? claimedFromSource : null)
        const undiscovered = expectedTotal !== null ? Math.max(0, expectedTotal - discovered) : 0
        const remaining = undiscovered + Math.max(0, discovered - saved - failed)
        const completion = remaining > 0 || failed > 0 ? 'partial' : 'complete'
        const ok = saved > 0 && completion === 'complete'
        // EP2 dogfood gap 3 — downloads flow BACK to the source task so the
        // collection card's numbers move (saved/failed/remaining visible).
        try {
          await (controller as unknown as {
            recordCollectedMediaDownload?: (taskId: string, summary: Record<string, unknown>) => Promise<unknown>
          }).recordCollectedMediaDownload?.(sourceTaskId, {
            discovered, saved, failed, remaining,
            directory: String(parsed.directory || directory),
            expectedTotal,
          })
        } catch {
          // silent-catch: 进度写回失败不影响下载结果。
        }
        const collectedPayload = {
          ok,
          ...(!ok ? { errorCode: completion === 'partial' ? 'collected_media_download_partial' : 'collected_media_download_failed' } : {}),
          completion,
          sourceTaskId,
          mediaCandidateCount: discovered,
          discovered,
          saved,
          failedCount: failed,
          remaining,
          expectedTotal,
          guidance: completion === 'partial'
            ? `已保存已发现的 ${saved} 张${failed > 0 ? `（${failed} 张失败）` : ''}${undiscovered > 0 ? `，页面声称共 ${expectedTotal} 张，仍有 ${undiscovered} 张未发现/未加载——请继续发现后再下载，不要宣告完成` : ''}。`
            : `已保存全部已发现的 ${saved} 张。`,
          ...parsed,
        }
        const collectedText = JSON.stringify(collectedPayload, null, 2)
        if (typeof output === 'string') {
          return ok ? collectedText : browserStructuredOutput(collectedPayload)
        }
        if (!ok) {
          return browserStructuredOutput(collectedPayload, {
            projectionPatch: output.projectionPatch,
            contextModifier: output.contextModifier,
          })
        }
        return createToolExecutionOutput(collectedText, {
          shape: 'json',
          data: collectedPayload,
          projectionPatch: output.projectionPatch,
          contextModifier: output.contextModifier,
        })
      }

      case 'collect_structured': {
        const template = String(args.template || 'article_list') as never
        const url = String(args.url || '').trim()
        let tabId = (args.tab_id as string) || null
        const scoped = await resolveHighControlAgentTab(controller, args, { signal: abortSignal })
        tabId = scoped.tabId
        const fields = Array.isArray(args.fields)
          ? (args.fields
              .filter((item) => item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string')
              .map((item) => item as BrowserStructuredFieldMapping))
          : undefined
        const customScript = typeof args.custom_script === 'string' ? args.custom_script : undefined
        const options = {
          template,
          itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
          fields,
          limit: Number(args.limit || 0) || undefined,
          minWidth: Number(args.min_width || 0) || undefined,
          customScript,
        }
        const result = url && !scoped.redirected
          ? await controller.extractStructuredFromUrl(url, options)
          : await controller.extractStructured(tabId, options)
        return JSON.stringify(result, null, 2)
      }

      case 'collect_scroll': {
        const template = String(args.template || 'card_list') as never
        const url = String(args.url || '').trim()
        let tabId = (args.tab_id as string) || null
        if (url) {
          const opened = await controller.openForCaptureTarget(url)
          if (!opened.success || !opened.tabId) {
            return `Error: ${opened.error || 'failed to open target'}`
          }
          tabId = opened.tabId
        }
        const customScript = typeof args.custom_script === 'string' ? args.custom_script : undefined
        const result = await controller.scrollCollect(tabId, {
          template,
          itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
          limit: Number(args.limit || 0) || undefined,
          maxScrolls: Number(args.max_scrolls || 0) || undefined,
          scrollDelayMs: Number(args.scroll_delay_ms || 0) || undefined,
          customScript,
        })
        return JSON.stringify(result, null, 2)
      }

      case 'collect_start': {
        const kind = String(args.kind || '').trim()
        if (!kind) return 'Error: kind is required'
        const payload = args.payload && typeof args.payload === 'object' ? args.payload as Record<string, unknown> : {}
        // P0.1 — normalize the payload for this raw entry so a background
        // collection started here behaves like the dedicated tools:
        //   • map the external snake_case `tab_id` to the internal `tabId` the
        //     runner reads — otherwise it ignores the target tab, scrapes the
        //     active page and may learn the failure against the wrong site;
        //   • stamp the current scope so scope-bound collection guards
        //     (findScope…ImageGallery…) can see a failure started here.
        // Neither overrides a value the caller already set in the internal shape.
        const scopedPayload: Record<string, unknown> = { ...payload, ...collectionOwnership }
        if (typeof scopedPayload.tabId !== 'string' && typeof scopedPayload.tab_id === 'string') {
          scopedPayload.tabId = scopedPayload.tab_id
        }
        if (sessionId && typeof scopedPayload.scopeId !== 'string') {
          scopedPayload.scopeId = sessionId
        }
        // P0.4 — a visible_collect started via this raw entry must resolve its
        // page URL the SAME way the dedicated browser_collect entry does
        // (controller.startVisibleCollection reads the target tab's URL from the
        // tab registry). Otherwise a tab_id-only collection has no page URL, and
        // a later failure can't be learned against a domain. Fall back to raw
        // startTask only for non-collection kinds or hosts without the method.
        const startVisibleCollection = (controller as { startVisibleCollection?: (payload: Record<string, unknown>, scopeId?: string) => Promise<BrowserCapabilityTaskHandle> }).startVisibleCollection
        const result = kind === 'visible_collect' && typeof startVisibleCollection === 'function'
          ? await startVisibleCollection.call(controller, scopedPayload, sessionId)
          : await controller.startTask({ kind: kind as never, payload: scopedPayload })
        return JSON.stringify(result, null, 2)
      }

      case 'task_get': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        const result = await controller.getTask(taskId)
        if (!result && isLikelyReadyNonBrowserTaskId(taskId)) {
          return browserStructuredOutput(wrongBrowserTaskIdPayload('browser_task(action=get)', taskId))
        }
        const linkedExecution = result?.kind === 'visible_collect'
          ? await (controller as {
              findCollectionTaskBySourceTaskId?: (sourceTaskId: string) => Promise<BrowserCapabilityTaskHandle | null>
            }).findCollectionTaskBySourceTaskId?.(result.taskId) || null
          : null
        return JSON.stringify(result ? browserTaskToolPayload(result, linkedExecution) : { taskId, status: 'missing' }, null, 2)
      }

      case 'task_resume': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        let current: BrowserCapabilityTaskHandle | null = null
        try {
          current = await controller.getTask(taskId)
        } catch (error) {
          log(`browser_task(action=resume) getTask failed taskId=${taskId}: ${error instanceof Error ? error.message : String(error)}`)
          current = null
        }
        if (!current && isLikelyReadyNonBrowserTaskId(taskId)) {
          return browserStructuredOutput(wrongBrowserTaskIdPayload('browser_task(action=resume)', taskId))
        }
        const result = await controller.resumeTask(taskId)
        return JSON.stringify(result ? browserTaskToolPayload(result) : { taskId, status: 'missing' }, null, 2)
      }

      case 'task_cancel': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        const result = await controller.cancelTask(taskId)
        if (!result && isLikelyReadyNonBrowserTaskId(taskId)) {
          return browserStructuredOutput(wrongBrowserTaskIdPayload('browser_task(action=cancel)', taskId))
        }
        return JSON.stringify(result ? browserTaskToolPayload(result) : { taskId, status: 'missing' }, null, 2)
      }

      case 'task_result': {
        const items = Array.isArray(args.items) ? args.items as Array<Record<string, unknown>> : []
        const result = controller.aggregateResults(items as never, {
          mergeStrategy: typeof args.merge_strategy === 'string' ? args.merge_strategy as 'concat' | 'dedupe' : undefined,
          sortBy: typeof args.sort_by === 'string' ? args.sort_by as 'title' | 'link' | 'source' : undefined,
        })
        return JSON.stringify(result, null, 2)
      }

      case 'download_gallery': {
        const url = String(args.url || '').trim()
        if (!url) return 'Error: url is required'
        const result = await controller.startTask({
          kind: 'scroll_collect',
          payload: {
            url,
            template: 'image_gallery',
            download: true,
            directory: typeof args.directory === 'string' ? args.directory : undefined,
            limit: Number(args.limit || 0) || undefined,
            maxScrolls: Number(args.max_scrolls || 0) || undefined,
            retryFailed: args.retry_failed === true,
          },
        })
        return JSON.stringify(result, null, 2)
      }

      case 'collect_research': {
        const query = String(args.query || '').trim()
        if (!query) return 'Error: query is required'
        const result = await controller.startTask({
          kind: 'research',
          payload: {
            query,
            urls: Array.isArray(args.urls) ? args.urls : undefined,
            maxPages: Number(args.max_pages || 0) || undefined,
            limitPerPage: Number(args.limit_per_page || 0) || undefined,
            template: typeof args.template === 'string' ? args.template : undefined,
          },
        })
        return JSON.stringify(result, null, 2)
      }

      case 'workflow_internal': {
        const stepsRaw = args.steps
        if (!Array.isArray(stepsRaw)) return 'Error: steps must be an array'
        const tabId = (args.tab_id as string) || null
        const continueOnError = args.continue_on_error === true
        const lines: string[] = []
        for (let index = 0; index < stepsRaw.length; index += 1) {
          const step = stepsRaw[index]
          if (!step || typeof step !== 'object') {
            lines.push(`Step ${index + 1}: Error: invalid step`)
            if (!continueOnError) break
            continue
          }
          const result = await runWorkflowStep(controller, step as Record<string, unknown>, tabId, abortSignal)
          lines.push(`Step ${index + 1}: ${result}`)
          if (!continueOnError && result.startsWith('Error:')) {
            break
          }
        }
        return truncate(lines.join('\n'))
      }

      case 'strategy_stage': {
        const domain = String(args.domain || '').trim().toLowerCase()
        const taskKind = String(args.task_kind || '').trim()
        const summary = String(args.summary || '').trim()
        if (!domain || !taskKind || !summary) return 'Error: domain, task_kind and summary are required'
        const dir = join(homedir(), 'Documents', 'Ready站点策略草稿')
        await mkdir(dir, { recursive: true })
        const filePath = join(dir, `${sanitizeFilename(domain)}-${sanitizeFilename(taskKind)}-${Date.now()}.json`)
        const payload = {
          ok: true,
          staged: true,
          domain,
          taskKind,
          summary,
          evidence: Array.isArray(args.evidence) ? args.evidence.map((item) => String(item || '')).filter(Boolean) : [],
          strategy: args.strategy && typeof args.strategy === 'object' ? args.strategy : {},
          createdAt: new Date().toISOString(),
          note: 'staged only; not active until user confirms in site knowledge settings',
        }
        await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
        try { broadcastDirectoryChanged([dir]) } catch { /* silent-catch: never break staged strategy output */ }
        return JSON.stringify({ ...payload, path: filePath }, null, 2)
      }

      case 'collect_visible': {
        // Reuse the same full target-URL set as the script guard (active tab,
        // tab_id, url) so high-control rate limits can't be bypassed via tab_id.
        const highControl = candidateTargetUrls.some((u) => isHighControlPlatformText(u))
        const payload = {
          url: typeof args.url === 'string' ? args.url : undefined,
          tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
          template: typeof args.template === 'string' ? args.template : undefined,
          itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
          maxItems: Number(args.max_items || 0) || undefined,
          maxRounds: Number(args.max_rounds || 0) || undefined,
          maxDurationMs: Number(args.max_duration_ms || 0) || undefined,
          userExpectedTotal: Number(args.user_expected_total || 0) || undefined,
          outputRootDir: typeof args.output_root_dir === 'string' && args.output_root_dir.trim()
            ? args.output_root_dir.trim()
            : undefined,
          // High-control platforms get conservative default rate/volume limits
          // (plan §4.4) applied in the runner.
          highControl,
          // Fallback for non-controller tests/hosts. Production controllers use
          // startVisibleCollection, which rewrites these to agent-view.
          surface: leaseGate?.surface,
          leaseId: leaseGate?.leaseId ?? undefined,
          ...collectionOwnership,
        }
        const startVisibleCollection = (controller as { startVisibleCollection?: (payload: Record<string, unknown>, scopeId?: string) => Promise<unknown> }).startVisibleCollection
        const result = startVisibleCollection
          ? await startVisibleCollection.call(controller, payload, sessionId)
          : await controller.startTask({ kind: 'visible_collect', payload })
        if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
          return browserStructuredOutput(result as Record<string, unknown>)
        }
        return JSON.stringify(result, null, 2)
      }

      case 'collect_notes': {
        // Dispatch a background note-collection sub-agent (plan §3.3). The main
        // agent either supplies a frozen source_task_id from browser_collect
        // or a direct planned list; source_task_id is the stronger contract so
        // the model cannot accidentally drop targets while restating the list.
        const sourceTaskId = String(args.source_task_id || '').trim()
        const expectedCount = Math.max(0, Number(args.expected_count || 0) || 0)
        const requestedStrategy = String(args.strategy || '').trim()
        const requestedOutputRootDir = normalizedPathField(args.output_root_dir)
        const rawNotes = Array.isArray(args.notes) ? args.notes as Array<Record<string, unknown>> : []
        const allowPartial = args.allow_partial === true
        const partialConsent = sourceTaskId
          ? collectionConsentStore.hasConsent('partial_collection', sessionId || '', sourceTaskId)
          : false
        let notes = normalizeCollectionTargets(rawNotes)
        let sourceTask: BrowserCapabilityTaskHandle | null = null
        let effectiveSourceTaskId = sourceTaskId
        if (sourceTaskId) {
          sourceTask = await controller.getTask(sourceTaskId)
          const frozenNotes = targetsFromTask(sourceTask)
          if (!sourceTask) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'source_task_missing',
              message: `source_task_id ${sourceTaskId} 不存在，无法接力采集。`,
              sourceTaskId,
            })
          }
          const sourcePayload = typeof (controller as { getTaskPayload?: (taskId: string) => Record<string, unknown> | null }).getTaskPayload === 'function'
            ? ((controller as { getTaskPayload: (taskId: string) => Record<string, unknown> | null }).getTaskPayload(sourceTaskId) || null)
            : null
          const mismatch = sourceTaskHandoffMismatch(sourceTaskId, sourcePayload, resultObject(sourceTask), sessionId, requestedOutputRootDir)
          if (mismatch) {
            log(`browser_collect refusal ${mismatch.errorCode} sourceTaskId=${sourceTaskId}`)
            return browserStructuredOutput({
              ok: false,
              ...mismatch,
              sourceTaskId,
            })
          }
          if (frozenNotes.length === 0) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'source_task_has_no_targets',
              message: `source_task_id ${sourceTaskId} 没有可接力的冻结目标清单。`,
              sourceTaskId,
            })
          }
          if (!isCompleteSourceTask(sourceTask) && !partialConsent) {
            const status = sourceTaskDiscoveryStatus(sourceTask)
            const result = resultObject(sourceTask)
            const stopReason = String(result?.stopReason || sourceTask.status || 'unknown')
            const continueTaskId = typeof result?.continueTaskId === 'string' ? result.continueTaskId : sourceTaskId
            const pendingConsentRequest = collectionConsentStore.createPendingRequest({
              scopeId: sessionId || '',
              sourceTaskId,
              consentKind: 'partial_collection',
            })
            const message = `source_task_id ${sourceTaskId} 的发现清单不是完整全量（discoveryStatus=${status}, stopReason=${stopReason}, 已冻结 ${frozenNotes.length} 条）。请先用 browser_task(action=resume) 继续发现：${continueTaskId}；如果用户明确只采当前这部分，需要先完成部分采集确认。`
            await upsertCollectionConsentProjection(runtime, pendingConsentRequest, message)
            log(`browser_collect refusal partial_collection sourceTaskId=${sourceTaskId}`)
            return browserStructuredOutput({
              ok: false,
              errorCode: 'partial_collection_consent_required',
              message,
              sourceTaskId,
              continueTaskId,
              frozenCount: frozenNotes.length,
              allowPartialIgnored: allowPartial,
              pendingConsentRequest,
            })
          }
          if (notes.length > 0 && notes.length !== frozenNotes.length) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'source_task_note_count_mismatch',
              message: `browser_collect 数量不一致：source_task_id ${sourceTaskId} 有 ${frozenNotes.length} 条，传入 notes 有 ${notes.length} 条。请直接使用 source_task_id 接力。`,
              sourceTaskId,
              frozenCount: frozenNotes.length,
              requestedCount: notes.length,
            })
          }
          notes = frozenNotes
        }
        if (notes.length === 0) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'collection_targets_required',
            message: 'browser_collect 需要 source_task_id，或至少一条带 http(s) URL 的 notes。',
          })
        }
        if (!sourceTaskId) {
          const largerFrozen = await findLargerRecentFrozenCollection(controller, notes)
          if (largerFrozen && !collectionConsentStore.hasConsent('partial_collection', sessionId || '', largerFrozen.taskId)) {
            const pendingConsentRequest = collectionConsentStore.createPendingRequest({
              scopeId: sessionId || '',
              sourceTaskId: largerFrozen.taskId,
              consentKind: 'partial_collection',
            })
            const message = `browser_collect 检测到最近的 browser_collect (${largerFrozen.taskId}) 已冻结 ${largerFrozen.count} 条目标，但当前只传入 ${notes.length} 条。请改用 source_task_id 接力；若用户明确只要部分采集，需要先完成部分采集确认。`
            await upsertCollectionConsentProjection(runtime, pendingConsentRequest, message)
            log(`browser_collect refusal partial_collection recentFrozen=${largerFrozen.taskId}`)
            return browserStructuredOutput({
              ok: false,
              errorCode: 'partial_collection_consent_required',
              message,
              sourceTaskId: largerFrozen.taskId,
              frozenCount: largerFrozen.count,
              requestedCount: notes.length,
              allowPartialIgnored: allowPartial,
              pendingConsentRequest,
            })
          }
          const missingUrls = missingUserProvidedUrls(notes, currentUserText || '')
          if (missingUrls.length > 0) {
            log(`browser_collect refusal url_provenance_required missing=${missingUrls.length}`)
            return browserStructuredOutput({
              ok: false,
              errorCode: 'url_provenance_required',
              message: 'browser_collect 直接接收 URL 列表时，必须确认这些 URL 来自当前用户消息原文或用户显式选择的会话资源；当前缺少可证明来源的 URL。',
              missingUrls,
            })
          }
        }
        if (expectedCount > 0 && notes.length !== expectedCount) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'collection_expected_count_mismatch',
            message: `browser_collect 数量不一致：预期 ${expectedCount} 条，实际冻结清单 ${notes.length} 条。`,
            expectedCount,
            actualCount: notes.length,
          })
        }
        const requestedMaxNotes = Math.max(0, Number(args.max_notes || 0) || 0)
        if (requestedMaxNotes > 0 && requestedMaxNotes < notes.length) {
          notes = notes.slice(0, requestedMaxNotes)
        }
        const stopConditions: Record<string, number> = {}
        if (requestedMaxNotes > 0) stopConditions.maxNotes = requestedMaxNotes
        if (Number(args.max_duration_ms || 0) > 0) stopConditions.maxDurationMs = Number(args.max_duration_ms)
        if (Number(args.max_consecutive_failures || 0) > 0) stopConditions.maxConsecutiveFailures = Number(args.max_consecutive_failures)
        const profileUrl = String(args.target_profile_url || '').trim()
          || (typeof resultObject(sourceTask)?.targetUrl === 'string' ? String(resultObject(sourceTask)?.targetUrl) : '')
        let profileSlug = 'profile'
        try {
          profileSlug = new URL(profileUrl).pathname.split('/').filter(Boolean).pop() || 'profile'
        } catch {
          // silent-catch: non-URL profile strings use the default output slug.
        }
        const outputRootDir = typeof args.output_root_dir === 'string' && args.output_root_dir.trim()
          ? expandHomePath(args.output_root_dir.trim())
          : join(homedir(), 'Documents', 'Ready采集', sanitizeFilename(profileSlug, 'profile'))
        if (!effectiveSourceTaskId) {
          const createSyntheticVisibleCollection = (controller as {
            createSyntheticVisibleCollection?: (payload: {
              targets: BrowserCollectionTarget[]
              targetUrl?: string
              outputRootDir?: string
              sourceMessageIds?: string[]
              ownerAgentId?: string
              ownerRunId?: string
              parentTaskId?: string
              executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding
            }, scopeId?: string) => BrowserCapabilityTaskHandle | Promise<BrowserCapabilityTaskHandle>
          }).createSyntheticVisibleCollection
          if (typeof createSyntheticVisibleCollection !== 'function') {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'synthetic_source_not_ready',
              message: 'browser_collect 直接 URL 列表已通过来源校验，但当前浏览器控制器未注册 synthetic source task 入口，不能启动无 source_task_id 的采集。',
            })
          }
          sourceTask = await createSyntheticVisibleCollection.call(controller, {
            targets: notes,
            targetUrl: profileUrl,
            outputRootDir,
            sourceMessageIds: ['current-turn'],
            ...collectionOwnership,
          }, sessionId)
          effectiveSourceTaskId = sourceTask.taskId
        }
        const highControlCollection = isHighControlPlatformText(profileUrl) || notes.some((note) => isHighControlPlatformText(note.url))
        const strategy = requestedStrategy === 'card_loop'
          ? 'card_loop'
          : requestedStrategy === 'url_batch'
            ? 'url_batch'
            : highControlCollection ? 'card_loop' : 'url_batch'
        const plan = {
          targetProfileUrl: profileUrl,
          strategy,
          notes: buildCollectionPlanNotes(notes),
          ...(expectedCount > 0 ? { expectedCount } : {}),
          ...(effectiveSourceTaskId ? { sourceTaskId: effectiveSourceTaskId } : {}),
          outputRootDir,
          ...(Object.keys(stopConditions).length > 0 ? { stopConditions } : {}),
          ...collectionOwnership,
        }
        // Pass the agent's session/scope so the background task projects into
        // THIS conversation's chat (plan §3.2). sessionId ≈ scopeId.
        const startCardLoopCollection = (controller as { startCardLoopCollection?: (plan: Record<string, unknown>, scopeId?: string) => Promise<unknown> }).startCardLoopCollection
        const result = strategy === 'card_loop'
          ? startCardLoopCollection
            ? await startCardLoopCollection.call(controller, plan, sessionId)
            : {
                ok: false,
                errorCode: 'card_loop_not_ready',
                message: 'card_loop runner 未注册；不能把高风控采集静默降级为 url_batch。',
                strategy,
              }
          : await controller.startNoteCollection(plan, sessionId)
        if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
          return browserStructuredOutput(result as Record<string, unknown>)
        }
        return JSON.stringify(result, null, 2)
      }

      default:
        return `Unknown browser tool: ${toolName}`
  }
}
