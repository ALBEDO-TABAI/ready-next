import type { BrowserStructuredItem } from './capability-types'

export type SiteResearchQueryStatus = 'completed' | 'empty' | 'waiting_human' | 'rate_limited' | 'failed'

export interface SiteResearchInterruption {
  classification: 'verification' | 'rate_limit' | 'network' | 'invalid_input' | 'unsupported_site' | 'unavailable' | 'cancelled' | 'unknown'
  retryable: boolean
}

export interface SiteResearchCandidate {
  rank: number
  queryRanks: Record<string, number>
  canonicalUrl: string
  retrievalUrl?: string
  title: string
  author: string | null
  engagement: number | null
  publishedAt: string | null
  body: string | null
  bodyUnavailableReason: string | null
  capturedAt: string
  matchedQueries: string[]
}

export interface SiteResearchQueryResult {
  query: string
  status: SiteResearchQueryStatus
  candidates: SiteResearchCandidate[]
  error: string | null
}

export interface SiteResearchEvaluationReceipt {
  targetUrl: string
  state: 'content_evidence' | 'account_read' | 'verified_empty'
  capturedAt: string
  title: string | null
  summary: string | null
  visibleItemCount: number
}

export interface SiteResearchCheckpoint {
  queryIndex: number
  detailIndex: number
  queryResults: SiteResearchQueryResult[]
  phase: 'query_search' | 'read_details' | 'aggregate' | 'completed' | 'waiting_human' | 'rate_limited' | 'failed'
  lastSuccessfulUrl: string | null
  pauseReason: string | null
  interruption?: SiteResearchInterruption | null
  sourceSiteTabId?: string | null
  siteOrigin?: string | null
  researchTabId?: string | null
  evaluationTargetUrl?: string | null
  evaluationCompleted?: boolean
  evaluationEvidence?: SiteResearchCandidate[]
  evaluationReceipt?: SiteResearchEvaluationReceipt | null
}

export interface SiteResearchRunInput {
  scope: 'current_site' | 'url_set'
  siteUrl: string | null
  queries: string[]
  urls: string[]
  perQueryLimit: number
  detailLimitPerQuery: number
  evaluationRequired?: boolean
  evaluationTargetUrl?: string | null
  checkpoint?: SiteResearchCheckpoint | null
}

export interface SiteResearchRunnerPort {
  extract(url: string, options: { template: 'card_list' | 'article_list'; limit: number }): Promise<BrowserStructuredItem[]>
  onCheckpoint(checkpoint: SiteResearchCheckpoint): void
  shouldStop(): boolean
  now(): string
}

export function assessSiteResearchEssentialOutput(input: {
  phase: SiteResearchCheckpoint['phase']
  completedQueries: number
  expectedQueries: number
  candidateCount: number
  detailCount: number
  engagementCount: number
  fields: string[]
  queryResults?: SiteResearchQueryResult[]
  evaluationRequired?: boolean
  evaluationReceipt?: SiteResearchEvaluationReceipt | null
}): { satisfied: boolean; missing: string[] } {
  const missing: string[] = []
  if (input.phase !== 'completed' || input.completedQueries !== input.expectedQueries) missing.push('query_coverage')
  if (input.candidateCount === 0) missing.push('candidates')
  const nonEmptyQueries = (input.queryResults || []).filter((result) => result.candidates.length > 0)
  const missingEngagement = nonEmptyQueries.length > 0
    ? nonEmptyQueries.some((result) => result.candidates.every((candidate) => candidate.engagement === null))
    : input.engagementCount === 0
  const missingBody = nonEmptyQueries.length > 0
    ? nonEmptyQueries.some((result) => result.candidates.every((candidate) => !candidate.body))
    : input.detailCount === 0
  if (input.fields.includes('engagement') && missingEngagement) missing.push('engagement')
  if (input.fields.includes('body') && missingBody) missing.push('body')
  if (input.evaluationRequired && (!input.evaluationReceipt?.targetUrl || !input.evaluationReceipt.capturedAt)) {
    missing.push('account_evidence')
  }
  return { satisfied: missing.length === 0, missing }
}

function isXiaohongshuUrl(value: string): boolean {
  try { return /(^|\.)xiaohongshu\.com$/i.test(new URL(value).hostname) } catch { return false }
}

function isXiaohongshuDirectArticleUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (!/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) return false
    const segments = url.pathname.split('/').filter(Boolean)
    return ((segments[0] === 'search_result' || segments[0] === 'explore') && segments.length >= 2)
      || (segments[0] === 'user' && segments[1] === 'profile' && segments.length >= 4)
  } catch {
    return false
  }
}

function researchPageState(items: BrowserStructuredItem[]): string | null {
  for (const item of items) {
    const state = item.rawFields?.researchState
    if (typeof state === 'string' && state.trim()) return state.trim()
  }
  return null
}

function assertResearchPageReadable(url: string, items: BrowserStructuredItem[], candidateCount: number): string | null {
  const state = researchPageState(items)
  if (state === 'waiting_human') throw new Error('security verification or login is required')
  if (state === 'rate_limited') throw new Error('site research rate limit is active')
  if (state === 'structure_unavailable') throw new Error('research page structure is unavailable')
  if (isXiaohongshuUrl(url) && candidateCount === 0 && state !== 'verified_empty' && state !== 'account_read') {
    throw new Error('research page returned no verifiable result state')
  }
  return state
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:xsec_|utm_|source|share_)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return value.trim()
  }
}

function currentSiteSearchUrl(siteUrl: string, query: string): string {
  const url = new URL(siteUrl)
  if (/(^|\.)xiaohongshu\.com$/i.test(url.hostname)) {
    return `${url.origin}/search_result?keyword=${encodeURIComponent(query)}`
  }
  throw new Error(`current-site research is not supported for ${url.hostname}`)
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value || '').trim().toLowerCase().replace(/,/g, '')
  const match = /([0-9]+(?:\.[0-9]+)?)\s*([万千wk]?)/i.exec(text)
  if (!match) return null
  const unit = match[2]
  const multiplier = unit === '万' || unit.toLowerCase() === 'w' ? 10_000 : unit === '千' || unit.toLowerCase() === 'k' ? 1_000 : 1
  return Math.round(Number(match[1]) * multiplier)
}

function candidateFromItem(item: BrowserStructuredItem, query: string, rank: number, capturedAt: string): SiteResearchCandidate | null {
  if (typeof item.rawFields?.researchState === 'string') return null
  const url = String(item.link || item.sourceUrl || '').trim()
  const title = String(item.title || '').trim()
  if (!url || !title) return null
  const structure = item.rawFields?.structure as Record<string, unknown> | undefined
  if (structure?.inNavigationRegion === true || structure?.inSidebarRegion === true) return null
  try {
    const parsed = new URL(url, item.sourceUrl)
    if (/(^|\.)xiaohongshu\.com$/i.test(parsed.hostname)) {
      const segments = parsed.pathname.split('/').filter(Boolean)
      const isNote = (segments[0] === 'search_result' || segments[0] === 'explore') && Boolean(segments[1])
        || segments[0] === 'user' && segments[1] === 'profile' && segments.length >= 4
      if (!isNote) return null
    }
  } catch {
    return null
  }
  const engagement = numberFromUnknown(
    item.rawFields?.engagement
      ?? item.rawFields?.likes
      ?? item.rawFields?.likeCount
      ?? item.rawFields?.interaction,
  )
  return {
    rank,
    queryRanks: { [query]: rank },
    canonicalUrl: canonicalUrl(url),
    retrievalUrl: url,
    title,
    author: typeof item.rawFields?.author === 'string' ? item.rawFields.author.trim() || null : null,
    engagement,
    publishedAt: typeof item.rawFields?.publishedAt === 'string' ? item.rawFields.publishedAt : null,
    body: null,
    bodyUnavailableReason: null,
    capturedAt,
    matchedQueries: [query],
  }
}

function candidateFromDirectPage(
  url: string,
  query: string,
  items: BrowserStructuredItem[],
  capturedAt: string,
): SiteResearchCandidate | null {
  const item = items.find((candidate) => typeof candidate.rawFields?.researchState !== 'string' && Boolean(
    String(candidate.title || '').trim()
    || String(candidate.summary || '').trim()
    || String(candidate.rawFields?.body || candidate.rawFields?.content || '').trim(),
  ))
  const body = detailBody(items)
  if (!item && !body) return null
  let fallbackTitle = url
  try {
    fallbackTitle = new URL(url).pathname.split('/').filter(Boolean).pop() || new URL(url).hostname
  } catch {
    // Keep the supplied URL as the visible fallback title.
  }
  return {
    rank: 1,
    queryRanks: { [query]: 1 },
    canonicalUrl: canonicalUrl(url),
    retrievalUrl: url,
    title: String(item?.title || '').trim() || fallbackTitle,
    author: typeof item?.rawFields?.author === 'string' ? item.rawFields.author.trim() || null : null,
    engagement: numberFromUnknown(
      item?.rawFields?.engagement
        ?? item?.rawFields?.likes
        ?? item?.rawFields?.likeCount
        ?? item?.rawFields?.interaction,
    ),
    publishedAt: typeof item?.rawFields?.publishedAt === 'string' ? item.rawFields.publishedAt : null,
    body,
    bodyUnavailableReason: body ? null : 'body_not_visible',
    capturedAt,
    matchedQueries: [query],
  }
}

function detailBody(items: BrowserStructuredItem[]): string | null {
  const parts = items.flatMap((item) => [item.summary, item.rawFields?.body, item.rawFields?.content])
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
  return parts.length > 0 ? [...new Set(parts)].join('\n') : null
}

function classifyResearchInterruption(error: unknown): {
  phase: Extract<SiteResearchCheckpoint['phase'], 'waiting_human' | 'rate_limited' | 'failed'>
  queryStatus: Extract<SiteResearchQueryStatus, 'waiting_human' | 'rate_limited' | 'failed'>
  interruption: SiteResearchInterruption
} {
  const message = error instanceof Error ? error.message : String(error)
  if (/429|rate.?limit|retry-after|访问频繁|请求频繁|操作频繁|限流/i.test(message)) {
    return {
      phase: 'rate_limited',
      queryStatus: 'rate_limited',
      interruption: { classification: 'rate_limit', retryable: true },
    }
  }
  if (/captcha|challenge|verification|验证码|安全验证|登录墙|扫码|(?:login|log\s+in|sign\s+in)\s+(?:is\s+)?required|sign\s+in\s+to\s+view|log\s+in\s+to\s+continue|please\s+(?:sign|log)\s+in|请先登录|登录后查看/i.test(message)) {
    return {
      phase: 'waiting_human',
      queryStatus: 'waiting_human',
      interruption: { classification: 'verification', retryable: true },
    }
  }
  if (/current account evaluation requires|profile page/i.test(message)) {
    return {
      phase: 'failed',
      queryStatus: 'failed',
      interruption: { classification: 'invalid_input', retryable: false },
    }
  }
  if (/current-site research is not supported/i.test(message)) {
    return {
      phase: 'failed',
      queryStatus: 'failed',
      interruption: { classification: 'unsupported_site', retryable: false },
    }
  }
  if (/structure is unavailable|no verifiable result state/i.test(message)) {
    return {
      phase: 'failed',
      queryStatus: 'failed',
      interruption: { classification: 'unavailable', retryable: false },
    }
  }
  if (/cancelled/i.test(message)) {
    return {
      phase: 'failed',
      queryStatus: 'failed',
      interruption: { classification: 'cancelled', retryable: true },
    }
  }
  if (/timeout|timed out|network|econn|enotfound|socket|temporar/i.test(message)) {
    return {
      phase: 'failed',
      queryStatus: 'failed',
      interruption: { classification: 'network', retryable: true },
    }
  }
  return {
    phase: 'failed',
    queryStatus: 'failed',
    interruption: { classification: 'unknown', retryable: false },
  }
}

export async function runSiteResearch(input: SiteResearchRunInput, port: SiteResearchRunnerPort): Promise<SiteResearchCheckpoint> {
  const checkpoint: SiteResearchCheckpoint = input.checkpoint
    ? structuredClone(input.checkpoint)
    : {
        queryIndex: 0,
        detailIndex: 0,
        queryResults: [],
        phase: 'query_search',
        lastSuccessfulUrl: null,
        pauseReason: null,
        interruption: null,
      }
  const detailCache = new Map<string, { body: string | null; reason: string | null }>()
  for (const result of checkpoint.queryResults) {
    for (const candidate of result?.candidates || []) {
      if (candidate.body) {
        detailCache.set(candidate.canonicalUrl, { body: candidate.body, reason: candidate.bodyUnavailableReason })
      }
    }
  }

  const stopAsCancelled = (queryIndex = checkpoint.queryIndex): SiteResearchCheckpoint => {
    checkpoint.queryIndex = queryIndex
    checkpoint.phase = 'failed'
    checkpoint.pauseReason = 'cancelled'
    checkpoint.interruption = { classification: 'cancelled', retryable: true }
    port.onCheckpoint(checkpoint)
    return checkpoint
  }

  const applyInterruption = (error: unknown): ReturnType<typeof classifyResearchInterruption> => {
    const classified = classifyResearchInterruption(error)
    checkpoint.phase = classified.phase
    checkpoint.pauseReason = error instanceof Error ? error.message : String(error)
    checkpoint.interruption = classified.interruption
    return classified
  }

  if (input.evaluationRequired && !checkpoint.evaluationReceipt) {
    const evaluationTargetUrl = String(input.evaluationTargetUrl || '').trim()
    checkpoint.evaluationTargetUrl = evaluationTargetUrl || null
    if (!evaluationTargetUrl || !isXiaohongshuUrl(evaluationTargetUrl) || !/\/user\/profile\//i.test(new URL(evaluationTargetUrl).pathname)) {
      applyInterruption(new Error('current account evaluation requires a bound account profile page'))
      port.onCheckpoint(checkpoint)
      return checkpoint
    }
    try {
      if (port.shouldStop()) return stopAsCancelled()
      const items = await port.extract(evaluationTargetUrl, { template: 'card_list', limit: input.perQueryLimit })
      const capturedAt = port.now()
      const evidence = items
        .map((item, index) => candidateFromItem(item, '__current_account__', index + 1, capturedAt))
        .filter((item): item is SiteResearchCandidate => item !== null)
      const state = assertResearchPageReadable(evaluationTargetUrl, items, evidence.length)
      const stateItem = items.find((item) => typeof item.rawFields?.researchState === 'string')
      const receiptState = evidence.length > 0 ? 'content_evidence' : state === 'verified_empty' ? 'verified_empty' : 'account_read'
      checkpoint.evaluationReceipt = {
        targetUrl: evaluationTargetUrl,
        state: receiptState,
        capturedAt,
        title: typeof stateItem?.rawFields?.accountTitle === 'string' ? stateItem.rawFields.accountTitle.slice(0, 300) : null,
        summary: typeof stateItem?.rawFields?.accountSummary === 'string' ? stateItem.rawFields.accountSummary.slice(0, 2_000) : null,
        visibleItemCount: evidence.length,
      }
      checkpoint.evaluationEvidence = evidence
      checkpoint.evaluationCompleted = true
      checkpoint.phase = 'query_search'
      checkpoint.pauseReason = null
      checkpoint.interruption = null
      port.onCheckpoint(checkpoint)
    } catch (error) {
      applyInterruption(error)
      port.onCheckpoint(checkpoint)
      return checkpoint
    }
  }

  let work: Array<{ query: string; url: string }>
  try {
    work = input.scope === 'current_site'
      ? input.queries.map((query) => ({ query, url: currentSiteSearchUrl(String(input.siteUrl || ''), query) }))
      : input.urls.map((url, index) => ({ query: input.queries[index] || url, url }))
  } catch (error) {
    applyInterruption(error)
    port.onCheckpoint(checkpoint)
    return checkpoint
  }

  const readFrozenDetails = async (
    queryIndex: number,
    candidates: SiteResearchCandidate[],
    startDetailIndex: number,
  ): Promise<boolean> => {
    const detailCandidates = [...candidates]
      .sort((a, b) => Number(b.engagement ?? -1) - Number(a.engagement ?? -1))
      .slice(0, input.detailLimitPerQuery)
    const selectedUrls = new Set(detailCandidates.map((candidate) => candidate.canonicalUrl))
    for (const candidate of candidates) {
      if (!selectedUrls.has(candidate.canonicalUrl) && !candidate.body && !candidate.bodyUnavailableReason) {
        candidate.bodyUnavailableReason = 'detail_not_selected'
      }
    }

    checkpoint.phase = 'read_details'
    checkpoint.queryIndex = queryIndex
    checkpoint.interruption = null
    port.onCheckpoint(checkpoint)
    for (let detailIndex = startDetailIndex; detailIndex < detailCandidates.length; detailIndex += 1) {
      if (port.shouldStop()) {
        stopAsCancelled(queryIndex)
        return false
      }
      const candidate = detailCandidates[detailIndex]
      checkpoint.detailIndex = detailIndex
      port.onCheckpoint(checkpoint)
      const cached = detailCache.get(candidate.canonicalUrl)
      if (cached) {
        candidate.body = cached.body
        candidate.bodyUnavailableReason = cached.reason
        continue
      }
      try {
        const details = await port.extract(candidate.retrievalUrl || candidate.canonicalUrl, {
          template: 'article_list',
          limit: 4,
        })
        const detailState = researchPageState(details)
        if (detailState === 'waiting_human' || detailState === 'rate_limited') {
          assertResearchPageReadable(candidate.retrievalUrl || candidate.canonicalUrl, details, 0)
        }
        candidate.body = detailBody(details)
        candidate.bodyUnavailableReason = candidate.body ? null : 'body_not_visible'
        detailCache.set(candidate.canonicalUrl, {
          body: candidate.body,
          reason: candidate.bodyUnavailableReason,
        })
      } catch (error) {
        const classified = classifyResearchInterruption(error)
        if (classified.phase === 'waiting_human' || classified.phase === 'rate_limited') {
          applyInterruption(error)
          port.onCheckpoint(checkpoint)
          return false
        }
        candidate.bodyUnavailableReason = error instanceof Error ? error.message : String(error)
        detailCache.set(candidate.canonicalUrl, {
          body: null,
          reason: candidate.bodyUnavailableReason,
        })
      }
    }
    checkpoint.detailIndex = 0
    return true
  }

  if (input.checkpoint?.phase === 'completed') {
    for (let queryIndex = 0; queryIndex < checkpoint.queryResults.length; queryIndex += 1) {
      const result = checkpoint.queryResults[queryIndex]
      if (!result || (result.status !== 'completed' && result.status !== 'empty')) continue
      if (!await readFrozenDetails(queryIndex, result.candidates, 0)) return checkpoint
    }
    checkpoint.queryIndex = work.length
  } else {
    const resumePhase = input.checkpoint?.phase
    const resumeQueryIndex = checkpoint.queryIndex
    for (let queryIndex = checkpoint.queryIndex; queryIndex < work.length; queryIndex += 1) {
      if (port.shouldStop()) return stopAsCancelled(queryIndex)
      const current = work[queryIndex]
      const frozenResult = queryIndex === resumeQueryIndex
        ? checkpoint.queryResults[queryIndex]
        : null
      const canResumeFrozenDetails = Boolean(
        frozenResult
        && (frozenResult.status === 'completed' || frozenResult.status === 'empty')
        && (
          resumePhase === 'read_details'
          || resumePhase === 'waiting_human'
          || resumePhase === 'rate_limited'
          || (resumePhase === 'failed' && checkpoint.interruption?.retryable === true)
        ),
      )
      if (canResumeFrozenDetails && frozenResult) {
        if (!await readFrozenDetails(queryIndex, frozenResult.candidates, checkpoint.detailIndex)) return checkpoint
        checkpoint.queryIndex = queryIndex + 1
        port.onCheckpoint(checkpoint)
        continue
      }

      checkpoint.phase = 'query_search'
      checkpoint.queryIndex = queryIndex
      checkpoint.detailIndex = 0
      checkpoint.pauseReason = null
      checkpoint.interruption = null
      port.onCheckpoint(checkpoint)
      try {
        const directArticle = input.scope === 'url_set' && isXiaohongshuDirectArticleUrl(current.url)
        const items = await port.extract(current.url, {
          template: directArticle ? 'article_list' : 'card_list',
          limit: directArticle ? 4 : input.perQueryLimit,
        })
        const capturedAt = port.now()
        let candidates = directArticle
          ? [candidateFromDirectPage(current.url, current.query, items, capturedAt)]
            .filter((item): item is SiteResearchCandidate => item !== null)
          : items
            .map((item, index) => candidateFromItem(item, current.query, index + 1, capturedAt))
            .filter((item): item is SiteResearchCandidate => item !== null)
            .slice(0, input.perQueryLimit)
        let readabilityItems = items
        const listState = researchPageState(items)
        if (listState === 'waiting_human' || listState === 'rate_limited') {
          assertResearchPageReadable(current.url, items, candidates.length)
        }
        if (directArticle && candidates.length > 0) {
          const directCandidate = candidates[0]
          detailCache.set(directCandidate.canonicalUrl, {
            body: directCandidate.body,
            reason: directCandidate.bodyUnavailableReason,
          })
        }
        if (input.scope === 'url_set' && !directArticle && candidates.length === 0) {
          const directItems = await port.extract(current.url, { template: 'article_list', limit: 4 })
          readabilityItems = directItems
          const directState = researchPageState(directItems)
          if (directState === 'waiting_human' || directState === 'rate_limited') {
            assertResearchPageReadable(current.url, directItems, 0)
          }
          const directCandidate = candidateFromDirectPage(current.url, current.query, directItems, capturedAt)
          if (directCandidate) {
            candidates = [directCandidate]
            detailCache.set(directCandidate.canonicalUrl, {
              body: directCandidate.body,
              reason: directCandidate.bodyUnavailableReason,
            })
          }
        }
        if (candidates.length === 0) assertResearchPageReadable(current.url, readabilityItems, 0)
        for (const candidate of candidates) {
          const cached = detailCache.get(candidate.canonicalUrl)
          if (cached) {
            candidate.body = cached.body
            candidate.bodyUnavailableReason = cached.reason
          }
        }
        const queryResult: SiteResearchQueryResult = {
          query: current.query,
          status: candidates.length > 0 ? 'completed' : 'empty',
          candidates,
          error: null,
        }
        checkpoint.queryResults[queryIndex] = queryResult
        checkpoint.lastSuccessfulUrl = current.url
        if (!await readFrozenDetails(queryIndex, candidates, 0)) return checkpoint
        checkpoint.queryIndex = queryIndex + 1
        port.onCheckpoint(checkpoint)
      } catch (error) {
        const classified = applyInterruption(error)
        checkpoint.queryResults[queryIndex] = {
          query: current.query,
          status: classified.queryStatus,
          candidates: [],
          error: checkpoint.pauseReason,
        }
        port.onCheckpoint(checkpoint)
        return checkpoint
      }
    }
  }

  checkpoint.phase = 'aggregate'
  const byUrl = new Map<string, SiteResearchCandidate>()
  for (const result of checkpoint.queryResults) {
    for (const candidate of result?.candidates || []) {
      const existing = byUrl.get(candidate.canonicalUrl)
      if (!existing) byUrl.set(candidate.canonicalUrl, structuredClone(candidate))
      else {
        existing.matchedQueries = [...new Set([...existing.matchedQueries, ...candidate.matchedQueries])]
        existing.queryRanks = { ...existing.queryRanks, ...candidate.queryRanks }
        if (!existing.body && candidate.body) {
          existing.body = candidate.body
          existing.bodyUnavailableReason = null
        }
        if (!existing.body && !existing.bodyUnavailableReason && candidate.bodyUnavailableReason) {
          existing.bodyUnavailableReason = candidate.bodyUnavailableReason
        }
      }
    }
  }
  for (const result of checkpoint.queryResults) {
    result.candidates = result.candidates.map((candidate) => {
      const aggregate = byUrl.get(candidate.canonicalUrl)
      return aggregate
        ? {
            ...aggregate,
            rank: candidate.rank,
            engagement: candidate.engagement,
            queryRanks: { ...aggregate.queryRanks, ...candidate.queryRanks },
          }
        : candidate
    })
  }
  checkpoint.phase = 'completed'
  checkpoint.pauseReason = null
  checkpoint.interruption = null
  port.onCheckpoint(checkpoint)
  return checkpoint
}
