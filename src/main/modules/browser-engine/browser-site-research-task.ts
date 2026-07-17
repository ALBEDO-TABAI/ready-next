import type { BrowserCapabilityService } from './capability-service'
import type { BrowserCapabilityTaskStatus } from './capability-types'
import { isAgentBrowserError } from './agent-browser-errors'
import { BrowserSiteResearchTabSession } from './browser-site-research-tab-session'
import {
  assessSiteResearchEssentialOutput,
  runSiteResearch,
  type SiteResearchCheckpoint,
} from './browser-site-research-runner'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import type { BrowserTaskPersistenceService } from './task-persistence-service'

interface BrowserSiteResearchTaskDeps {
  taskId: string
  payload: Record<string, unknown>
  capabilityService: BrowserCapabilityService
  persistenceService: BrowserTaskPersistenceService
  leaseService: BrowserWriteLeaseService
  isCancelled(): boolean
  project(): void
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export async function runBrowserSiteResearchTask(deps: BrowserSiteResearchTaskDeps): Promise<void> {
  const { taskId, payload, persistenceService } = deps
  const queries = toStringArray(payload.queries)
  const urls = toStringArray(payload.urls)
  const expectedCount = payload.scope === 'url_set' ? urls.length : queries.length
  const existing = persistenceService.getTask(taskId)
  const storedCheckpoint = existing?.checkpoint?.stage === 'site_research'
    ? existing.checkpoint.partialResults as SiteResearchCheckpoint | undefined
    : undefined
  const researchTabId = typeof payload.agentTabId === 'string' && payload.agentTabId.trim()
    ? payload.agentTabId.trim()
    : storedCheckpoint?.researchTabId || null

  const pauseResearch = (pauseReason: string): void => {
    const checkpoint: SiteResearchCheckpoint = storedCheckpoint || {
      queryIndex: 0,
      detailIndex: 0,
      queryResults: [],
      phase: 'failed',
      lastSuccessfulUrl: null,
      pauseReason,
      sourceSiteTabId: typeof payload.siteTabId === 'string' ? payload.siteTabId : null,
      siteOrigin: typeof payload.siteUrl === 'string'
        ? (() => { try { return new URL(payload.siteUrl).origin } catch { return null } })()
        : null,
      researchTabId,
    }
    checkpoint.pauseReason = pauseReason
    persistenceService.updateProgress(taskId, {
      total: expectedCount,
      completed: checkpoint.queryResults.filter((item) => item && (item.status === 'completed' || item.status === 'empty')).length,
      failed: checkpoint.queryResults.filter((item) => item?.status === 'failed').length,
      currentLabel: null,
    }, {
      status: 'paused',
      checkpoint: { taskId, stage: 'site_research', cursor: String(checkpoint.queryIndex), partialResults: checkpoint },
      error: pauseReason,
      finishedAt: null,
    })
    deps.project()
  }

  if (!researchTabId) {
    pauseResearch('site_research is missing its background agent tab binding')
    return
  }
  const surface = 'agent-view' as const
  const acquired = deps.leaseService.acquire({ surface, taskId, runId: taskId, tabId: researchTabId })
  if (isAgentBrowserError(acquired)) {
    pauseResearch(`site_research could not acquire ${surface} lease: ${acquired.errorCode}`)
    return
  }
  const researchTab = new BrowserSiteResearchTabSession(
    deps.capabilityService,
    deps.leaseService,
    surface,
    acquired.leaseId,
    researchTabId,
  )

  try {
    const checkpoint = await runSiteResearch({
      scope: payload.scope === 'url_set' ? 'url_set' : 'current_site',
      siteUrl: typeof payload.siteUrl === 'string' ? payload.siteUrl : null,
      queries,
      urls,
      perQueryLimit: Math.max(1, Number(payload.perQueryLimit || 12) || 12),
      detailLimitPerQuery: Math.max(0, Number(payload.detailLimitPerQuery ?? 3) || 0),
      evaluationRequired: payload.evaluationRequired === true,
      evaluationTargetUrl: typeof payload.evaluationTargetUrl === 'string' ? payload.evaluationTargetUrl : null,
      checkpoint: storedCheckpoint || null,
    }, {
      extract: (url, options) => researchTab.extract(url, options),
      onCheckpoint: (next) => {
        next.sourceSiteTabId = typeof payload.siteTabId === 'string' ? payload.siteTabId : null
        next.siteOrigin = typeof payload.siteUrl === 'string'
          ? (() => { try { return new URL(payload.siteUrl).origin } catch { return null } })()
          : null
        next.researchTabId = researchTab.tabId
        const completedQueries = next.queryResults.filter((item) => item && (item.status === 'completed' || item.status === 'empty')).length
        const failedQueries = next.queryResults.filter((item) => item && item.status === 'failed').length
        persistenceService.updateProgress(taskId, {
          total: expectedCount,
          completed: completedQueries,
          failed: failedQueries,
          currentLabel: next.queryResults[next.queryIndex]?.query || queries[next.queryIndex] || urls[next.queryIndex] || null,
        }, {
          checkpoint: {
            taskId,
            stage: 'site_research',
            cursor: String(next.queryIndex),
            partialResults: next,
          },
        })
        deps.project()
      },
      shouldStop: deps.isCancelled,
      now: () => new Date().toISOString(),
    })
    if (deps.isCancelled()) return

    const candidates = checkpoint.queryResults.flatMap((item) => item?.candidates || [])
    const uniqueCandidates = new Map(candidates.map((candidate) => [candidate.canonicalUrl, candidate]))
    const completedQueries = checkpoint.queryResults.filter((item) => item && (item.status === 'completed' || item.status === 'empty')).length
    const detailCount = [...uniqueCandidates.values()].filter((candidate) => Boolean(candidate.body)).length
    const engagementCount = [...uniqueCandidates.values()].filter((candidate) => candidate.engagement !== null).length
    const essential = assessSiteResearchEssentialOutput({
      phase: checkpoint.phase,
      completedQueries,
      expectedQueries: expectedCount,
      candidateCount: uniqueCandidates.size,
      detailCount,
      engagementCount,
      fields: toStringArray(payload.fields),
      queryResults: checkpoint.queryResults,
      evaluationRequired: payload.evaluationRequired === true,
      evaluationReceipt: checkpoint.evaluationReceipt || null,
    })
    const status: BrowserCapabilityTaskStatus = checkpoint.phase === 'waiting_human'
      ? 'waiting_human'
      : checkpoint.phase === 'failed'
        ? 'paused'
        : essential.satisfied
          ? 'completed'
          : 'failed'
    const result = {
      kind: 'site_research',
      queryCount: expectedCount,
      completedQueries,
      candidateCount: uniqueCandidates.size,
      detailCount,
      engagementCount,
      evaluationRequired: payload.evaluationRequired === true,
      evaluationCompleted: checkpoint.evaluationCompleted === true,
      evaluationTargetUrl: checkpoint.evaluationTargetUrl || null,
      evaluationEvidenceCount: checkpoint.evaluationEvidence?.length || 0,
      evaluationReceipt: checkpoint.evaluationReceipt || null,
      evaluationEvidence: checkpoint.evaluationEvidence || [],
      essentialOutputSatisfied: essential.satisfied,
      missingEssentialOutputs: essential.missing,
      queryResults: checkpoint.queryResults,
      candidates: [...uniqueCandidates.values()],
      pauseReason: checkpoint.pauseReason,
      revision: Number(asRecord(existing?.result)?.revision || 0) + 1,
    }
    persistenceService.updateProgress(taskId, {
      total: expectedCount,
      completed: completedQueries,
      failed: checkpoint.queryResults.filter((item) => item?.status === 'failed').length,
      currentLabel: null,
    }, {
      status,
      result,
      checkpoint: {
        taskId,
        stage: 'site_research',
        cursor: String(checkpoint.queryIndex),
        partialResults: checkpoint,
      },
      error: status === 'failed' || status === 'paused'
        ? checkpoint.pauseReason || 'site research essential output floor was not satisfied'
        : null,
      finishedAt: status === 'waiting_human' || status === 'paused' ? null : new Date().toISOString(),
    })
    deps.project()
  } finally {
    deps.leaseService.release(acquired.leaseId)
  }
}
