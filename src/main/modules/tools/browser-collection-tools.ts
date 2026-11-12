/** Browser research, collection, download and background-result operations. */
import type { BrowserController } from '../browser-engine/ipc-handler'
import type {
  BrowserCapabilityTaskHandle,
  BrowserStructuredFieldMapping,
} from '../browser-engine/capability-types'
import type { BrowserMutationBoundary } from './browser-action-executor'
import { inspectBrowserResources, type BrowserResourceKind } from '../browser-engine/resource-sniffer'
import { resolveFastCardVideo } from '../browser-engine/fastcard-video-resolver'
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import {
  createBrowserStructuredJsonText as browserStructuredJsonText,
  createBrowserStructuredOutput as browserStructuredOutput,
  stringifyBrowserJsonOrFailure,
} from './browser-failure-output'
import {
  downloadUrlsToDirectory,
  expandHomePath,
  normalizeResourceKinds,
  resolveAuthorizedBrowserDownloadDirectory,
  safeHostname,
  sanitizeFilename,
} from './browser-media-download'
import {
  activePageLikelyMatchesTarget,
  truncate,
} from './browser-tool-shared'
import { parseBrowserResearchPublicRequest } from './browser-action-contracts'
import {
  assertTrustedPointerDelivery,
  bindTrustedPointerExpected,
  TrustedPointerBlockedError,
  trustedInputPageDenied,
} from './browser-input-actions'

function collectionTrustedPointerExpected(
  ctx: BrowserCollectionToolContext,
  tabId: string | null,
): { physicalTargetToken: string; mainFrameDocumentToken: string } | null {
  const ref = ctx.taskExecutionContext?.trustedPageRef
  if (!ref || (tabId && ref.tabId !== tabId)) return null
  return {
    physicalTargetToken: ref.physicalTargetToken,
    mainFrameDocumentToken: ref.mainFrameDocumentToken,
  }
}

async function assertCollectScrollAdmission(
  controller: BrowserController,
  tabId: string | null,
  mutationBoundary: BrowserMutationBoundary,
  expected?: { physicalTargetToken: string; mainFrameDocumentToken: string } | null,
): Promise<void> {
  await assertTrustedPointerDelivery(controller, tabId)
  const stale = await trustedInputPageDenied(controller, tabId, expected)
  if (stale) throw new TrustedPointerBlockedError(stale)
  mutationBoundary.invokeTransport(() => undefined)
}

function collectScrollAdmissionFailure(error: unknown): ToolExecutionOutput | null {
  const dispatchedScrolls = Number((error as { dispatchedScrolls?: unknown })?.dispatchedScrolls || 0)
  const partial = Number.isFinite(dispatchedScrolls) && dispatchedScrolls > 0
  const partialFacts = {
    mayHaveCommitted: partial,
    needsObservation: partial,
    dispatchedScrolls: Math.max(0, Math.floor(Number.isFinite(dispatchedScrolls) ? dispatchedScrolls : 0)),
    dispatch: partial ? 'accepted' : 'rejected',
    delivery: partial ? 'unknown' : 'not_delivered',
    effect: partial ? 'unknown' : 'not_applicable',
  } as const
  if (error instanceof TrustedPointerBlockedError) {
    const data = error.output.data && typeof error.output.data === 'object'
      ? error.output.data as Record<string, unknown>
      : {}
    return browserStructuredOutput({
      ...data,
      ok: false,
      errorKind: String(data.errorKind || 'browser_surface_required'),
      ...partialFacts,
    })
  }
  if (error instanceof Error && error.name === 'BrowserMutationFenceError') {
    return browserStructuredOutput({
      ok: false,
      errorKind: 'browser_workflow_write_fenced',
      ...partialFacts,
    })
  }
  return null
}

interface BrowserTaskFailedItem {
  url: string
  reason: string
  attempts: number
  retryable: boolean
}

function normalizeBrowserTaskFailedItems(value: unknown): BrowserTaskFailedItem[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const attempts = Number(record.attempts)
    return {
      url: String(record.url || record.canonicalUrl || record.openUrl || record.sourceUrl || '').trim(),
      reason: String(record.reason || record.error || record.message || 'unknown').trim() || 'unknown',
      attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1,
      retryable: record.retryable === true,
    }
  })
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

function browserTaskAuthorizationFailure(
  payload: Record<string, unknown> | null,
  sessionId: string | undefined,
  taskExecutionContext: BrowserCollectionToolContext['taskExecutionContext'],
): Record<string, unknown> | null {
  if (!payload) return null
  const storedScopeId = stringField(payload.scopeId)
  if (storedScopeId && sessionId && storedScopeId !== sessionId) {
    return { ok: false, errorKind: 'authorization_denied', message: 'browser task belongs to a different conversation scope' }
  }
  const storedOwnerAgentId = stringField(payload.ownerAgentId)
  const currentOwnerAgentId = stringField(taskExecutionContext?.ownerAgentId)
  if (storedOwnerAgentId && storedOwnerAgentId !== currentOwnerAgentId) {
    return { ok: false, errorKind: 'authorization_denied', message: 'browser task belongs to a different agent owner' }
  }
  // A follow-up message creates a new user-visible parent task. The explicit
  // browser task id is the continuation identity; scope + agent ownership are
  // the access boundary, while parentTaskId is audit/handoff metadata that is
  // atomically rebound by resume. Rejecting a read here makes every legitimate
  // status follow-up look like a missing tool.
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

export interface BrowserCollectionToolContext {
  controller: BrowserController
  abortSignal?: AbortSignal
  sessionId?: string
  mutationBoundary: BrowserMutationBoundary
  taskExecutionContext?: {
    ownerAgentId?: string | null
    ownerRunId?: string | null
    browserTaskId?: string | null
    parentTaskId?: string | null
    executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
    workspaceRoots?: string[]
    registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
    trustedPageRef?: {
      tabId: string
      physicalTargetToken: string
      mainFrameDocumentToken: string
    } | null
  }
}

export async function executeBrowserCollectionTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserCollectionToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, mutationBoundary, taskExecutionContext } = ctx
  switch (toolName) {
      case 'research_start':
      case 'research_evidence':
      case 'research_complete': {
        const action = toolName === 'research_start'
          ? 'start'
          : toolName === 'research_evidence'
            ? 'evidence'
            : 'complete'
        const parsed = parseBrowserResearchPublicRequest({ ...args, action })
        if (!parsed.ok) return `Error: ${parsed.message}`
        const request = parsed.value
        const ownerRunId = String(taskExecutionContext?.ownerRunId || '').trim()
        const taskId = String(taskExecutionContext?.browserTaskId || '').trim()
        if (!ownerRunId || !taskId) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_workflow_route_required',
            operationId: toolName,
          })
        }
        if (request.action === 'complete') {
          const assessment = controller.assessBrowserResearch(taskId)
          return browserStructuredOutput({
            ok: assessment.satisfied,
            operationId: 'research_complete',
            taskId,
            satisfied: assessment.satisfied,
            missingWorkItemIds: assessment.missingWorkItemIds,
            workItems: assessment.workItems,
            evidenceRefs: assessment.evidenceRefs,
          })
        }
        const assessment = request.action === 'evidence'
          ? controller.bindBrowserResearchEvidence(taskId, ownerRunId, request.evidenceBindings)
          : controller.upsertBrowserResearchWorkItems(taskId, ownerRunId, request.workItems)
        return browserStructuredOutput({
          ok: true,
          operationId: request.action === 'evidence' ? 'research_evidence' : 'research_start',
          taskId,
          satisfied: assessment.satisfied,
          missingWorkItemIds: assessment.missingWorkItemIds,
          workItems: assessment.workItems,
          evidenceRefs: assessment.evidenceRefs,
        })
      }
      case 'collect_images': {
        const tabId = (args.tab_id as string) || null
        const keyword = String(args.keyword || '').trim().toLowerCase()
        const limit = Math.max(1, Math.min(60, Number(args.limit || 20)))
        const minWidth = Math.max(1, Math.min(4_000, Number(args.min_width || 120)))
        const includeHidden = args.include_hidden === true
        const rows = await controller.executeJS(
          tabId,
          `
            (() => {
              const keyword = ${JSON.stringify(keyword)}
              const maxCount = ${JSON.stringify(limit)}
              const minWidth = ${JSON.stringify(minWidth)}
              const includeHidden = ${JSON.stringify(includeHidden)}
              const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
              const visible = (element, rect) => {
                if (includeHidden) return true
                if (!rect || rect.width < minWidth || rect.height < 40) return false
                const style = getComputedStyle(element)
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
                const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2))
                const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2))
                const top = document.elementFromPoint(x, y)
                return Boolean(top && (top === element || element.contains(top) || top.contains(element)))
              }
              const absoluteHttpUrl = (raw) => {
                const value = normalize(raw)
                if (!value) return ''
                try {
                  const resolved = new URL(value, location.href)
                  return /^https?:$/.test(resolved.protocol) ? resolved.href : ''
                } catch {
                  return ''
                }
              }
              const srcsetUrls = (value) => normalize(value)
                .split(',')
                .map((entry) => entry.trim().split(/\\s+/)[0])
                .filter(Boolean)
              const images = []
              const imageSeen = new Set()
              const addImage = (rawUrl, alt, width, height) => {
                if (images.length >= maxCount) return
                const url = absoluteHttpUrl(rawUrl)
                if (!url || imageSeen.has(url)) return
                const normalizedAlt = normalize(alt)
                const w = Math.round(Number(width || 0))
                const h = Math.round(Number(height || 0))
                if ((w > 0 && w < minWidth) || (h > 0 && h < 40)) return
                if (keyword && !(url + ' ' + normalizedAlt).toLowerCase().includes(keyword)) return
                imageSeen.add(url)
                images.push({ url, alt: normalizedAlt, width: w, height: h })
              }
              for (const image of Array.from(document.images)) {
                const rect = image.getBoundingClientRect()
                if (!visible(image, rect)) continue
                const candidates = [
                  image.currentSrc,
                  image.src,
                  image.getAttribute('data-src'),
                  image.getAttribute('data-original'),
                  image.getAttribute('data-lazy-src'),
                  ...srcsetUrls(image.srcset || image.getAttribute('data-srcset') || ''),
                ]
                for (const candidate of candidates) {
                  addImage(
                    candidate,
                    image.alt || image.getAttribute('title') || '',
                    image.naturalWidth || image.width || rect.width,
                    image.naturalHeight || image.height || rect.height,
                  )
                }
                if (images.length >= maxCount) break
              }
              if (includeHidden && images.length < maxCount) {
                for (const node of Array.from(document.querySelectorAll(
                  'meta[property="og:image"],meta[name="twitter:image"],link[rel="image_src"],source[srcset]',
                ))) {
                  const values = node.matches('source')
                    ? srcsetUrls(node.getAttribute('srcset') || '')
                    : [node.getAttribute('content') || node.getAttribute('href') || '']
                  for (const value of values) addImage(value, node.getAttribute('property') || node.getAttribute('name') || '', 0, 0)
                  if (images.length >= maxCount) break
                }
              }
              const videos = []
              const videoSeen = new Set()
              const addVideo = (rawUrl, rawPoster, width, height) => {
                if (videos.length >= maxCount) return
                const url = absoluteHttpUrl(rawUrl)
                const posterUrl = absoluteHttpUrl(rawPoster)
                if (!url && !posterUrl) return
                const key = url || ('poster:' + posterUrl)
                if (videoSeen.has(key)) return
                videoSeen.add(key)
                videos.push({
                  url,
                  posterUrl,
                  width: Math.round(Number(width || 0)),
                  height: Math.round(Number(height || 0)),
                })
              }
              for (const video of Array.from(document.querySelectorAll('video'))) {
                const rect = video.getBoundingClientRect()
                if (!visible(video, rect)) continue
                const candidates = [
                  video.currentSrc,
                  video.src,
                  video.getAttribute('src'),
                  ...Array.from(video.querySelectorAll('source')).map((source) => source.src || source.getAttribute('src') || ''),
                ]
                addVideo(
                  candidates.find(Boolean) || '',
                  video.poster || video.getAttribute('poster') || '',
                  video.videoWidth || rect.width,
                  video.videoHeight || rect.height,
                )
              }
              return { images, videos }
            })()
          `,
        ) as {
          images?: Array<{ url?: string; alt?: string; width?: number; height?: number }>
          videos?: Array<{ url?: string; posterUrl?: string; width?: number; height?: number }>
        } | null
        const images = Array.isArray(rows?.images)
          ? rows.images.map((item) => ({
              url: String(item.url || ''),
              alt: String(item.alt || ''),
              width: Number(item.width || 0),
              height: Number(item.height || 0),
            })).filter((item) => item.url.length > 0)
          : []
        const videos = Array.isArray(rows?.videos)
          ? rows.videos.map((item) => ({
              url: String(item.url || ''),
              posterUrl: String(item.posterUrl || ''),
              width: Number(item.width || 0),
              height: Number(item.height || 0),
            })).filter((item) => item.url.length > 0 || item.posterUrl.length > 0)
          : []
        return JSON.stringify({ ok: true, observationFresh: true, count: images.length, images, videoCount: videos.length, videos }, null, 2)
      }
      case 'resources': {
        const tabId = (args.tab_id as string) || null
        const result = await inspectBrowserResources(controller, {
          tabId,
          kinds: normalizeResourceKinds(args.kinds),
          waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : undefined,
          maxCandidates: typeof args.max_candidates === 'number' ? args.max_candidates : undefined,
          signal: abortSignal,
        })
        return stringifyBrowserJsonOrFailure({ ...result, observationFresh: true })
      }

      case 'download_resolve': {
        let tabId = (args.tab_id as string) || null
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
        const resolvedDirectory = resolveAuthorizedBrowserDownloadDirectory(args.directory, {
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
          filenamePrefix: String(args.filename_prefix || ''),
          overwrite: args.overwrite === true,
          tabId: (args.tab_id as string) || null,
          maxTotalBytes: typeof args.max_total_bytes === 'number' ? args.max_total_bytes : undefined,
          abortSignal,
          mutationBoundary,
        })
      }

      case 'collect_structured': {
        const template = String(args.template || 'article_list') as never
        const tabId = (args.tab_id as string) || null
        const fields = Array.isArray(args.fields)
          ? (args.fields
              .filter((item) => item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string')
              .map((item) => item as BrowserStructuredFieldMapping))
          : undefined
        const options = {
          template,
          itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
          fields,
          limit: Number(args.limit || 0) || undefined,
          minWidth: Number(args.min_width || 0) || undefined,
        }
        const result = await controller.extractStructured(tabId, options)
        return JSON.stringify({ ok: true, observationFresh: true, result }, null, 2)
      }

      case 'collect_scroll': {
        const template = String(args.template || 'card_list') as never
        const tabId = (args.tab_id as string) || null
        const expected = collectionTrustedPointerExpected(ctx, tabId)
        const releaseExpected = bindTrustedPointerExpected(expected)
        try {
          const result = await controller.scrollCollect(tabId, {
            template,
            itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
            limit: Number(args.limit || 0) || undefined,
            maxScrolls: Number(args.max_scrolls || 0) || undefined,
            scrollDelayMs: Number(args.scroll_delay_ms || 0) || undefined,
            beforeScroll: () => assertCollectScrollAdmission(controller, tabId, mutationBoundary, expected),
          }, abortSignal)
          return JSON.stringify({ ok: true, observationFresh: true, result }, null, 2)
        } catch (error) {
          const blocked = collectScrollAdmissionFailure(error)
          if (blocked) return blocked
          throw error
        } finally {
          releaseExpected()
        }
      }

      case 'task_get': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        const result = await controller.getTask(taskId)
        if (!result && isLikelyReadyNonBrowserTaskId(taskId)) {
          return browserStructuredOutput(wrongBrowserTaskIdPayload('browser_task(action=get)', taskId))
        }
        const authorizationFailure = result
          ? browserTaskAuthorizationFailure(controller.getTaskPayload?.(taskId) || null, sessionId, taskExecutionContext)
          : null
        if (authorizationFailure) return browserStructuredOutput(authorizationFailure)
        const payload = result ? enrichBrowserTaskPayload(result) : { taskId, status: 'missing' }
        return JSON.stringify({ ok: Boolean(result), observationFresh: true, ...payload }, null, 2)
      }

      case 'task_result': {
        const taskId = String(args.task_id || '').trim()
        if (!taskId) return 'Error: task_id is required'
        const task = await controller.getTask(taskId)
        if (!task && isLikelyReadyNonBrowserTaskId(taskId)) {
          return browserStructuredOutput(wrongBrowserTaskIdPayload('browser_task(action=result)', taskId))
        }
        const authorizationFailure = task
          ? browserTaskAuthorizationFailure(controller.getTaskPayload?.(taskId) || null, sessionId, taskExecutionContext)
          : null
        if (authorizationFailure) return browserStructuredOutput(authorizationFailure)
        const payload = task ? enrichBrowserTaskPayload(task) : { taskId, status: 'missing' }
        return JSON.stringify({ ok: Boolean(task), observationFresh: true, ...payload }, null, 2)
      }

      case 'collect_visible': {
        const tabId = (args.tab_id as string) || null
        const expected = collectionTrustedPointerExpected(ctx, tabId)
        const releaseExpected = bindTrustedPointerExpected(expected)
        try {
          const result = await controller.scrollCollect(tabId, {
            template: String(args.template || 'card_list') as never,
            itemSelector: typeof args.item_selector === 'string' ? args.item_selector : undefined,
            limit: Number(args.limit || args.max_items || 0) || undefined,
            maxScrolls: Number(args.max_scrolls || args.max_rounds || 0) || undefined,
            scrollDelayMs: Number(args.scroll_delay_ms || 0) || undefined,
            beforeScroll: () => assertCollectScrollAdmission(controller, tabId, mutationBoundary, expected),
          }, abortSignal)
          return JSON.stringify({ ok: true, observationFresh: true, result }, null, 2)
        } catch (error) {
          const blocked = collectScrollAdmissionFailure(error)
          if (blocked) return blocked
          throw error
        } finally {
          releaseExpected()
        }
      }

      default:
        return `Unknown browser tool: ${toolName}`
  }
}
