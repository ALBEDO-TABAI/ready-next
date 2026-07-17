import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessSiteResearchEssentialOutput,
  runSiteResearch,
  type SiteResearchCheckpoint,
} from '../main/modules/browser-engine/browser-site-research-runner'
import type { BrowserStructuredItem } from '../main/modules/browser-engine/capability-types'
import { BrowserSiteResearchTabSession } from '../main/modules/browser-engine/browser-site-research-tab-session'
import {
  resolveSiteResearchTaskDisposition,
  runBrowserSiteResearchTask,
} from '../main/modules/browser-engine/browser-site-research-task'
import { BrowserContentTaskRunner } from '../main/modules/browser-engine/content-task-runner'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'

function card(query: string, index: number, shared = false): BrowserStructuredItem {
  return {
    sourceUrl: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`,
    title: shared ? 'shared note' : `${query} note ${index}`,
    link: shared ? 'https://www.xiaohongshu.com/explore/shared' : `https://www.xiaohongshu.com/explore/${encodeURIComponent(query)}-${index}`,
    rawFields: { author: 'author', engagement: index === 0 ? '2.9万' : '1200' },
  }
}

test('Xiaohongshu detail reads retain access parameters while canonical identity removes them', async () => {
  const detailUrls: string[] = []
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 2,
    detailLimitPerQuery: 1,
  }, {
    extract: async (url, options) => {
      if (options.template === 'card_list') {
        return [{
          sourceUrl: url,
          title: 'note',
          link: 'https://www.xiaohongshu.com/search_result/note-1?xsec_token=required&xsec_source=pc_search',
          rawFields: { structure: { inMainContentRegion: true }, engagement: '2.9万' },
        }]
      }
      detailUrls.push(url)
      return [{ sourceUrl: url, summary: 'detail body' }]
    },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })

  const candidate = result.queryResults[0].candidates[0]
  assert.equal(candidate.canonicalUrl, 'https://www.xiaohongshu.com/search_result/note-1')
  assert.equal(candidate.retrievalUrl, 'https://www.xiaohongshu.com/search_result/note-1?xsec_token=required&xsec_source=pc_search')
  assert.deepEqual(detailUrls, [candidate.retrievalUrl])
  assert.equal(candidate.engagement, 29_000)
  assert.equal(candidate.body, 'detail body')
})

test('Xiaohongshu navigation and account links are not research candidates', async () => {
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 6,
    detailLimitPerQuery: 0,
  }, {
    extract: async () => [
      { sourceUrl: 'https://www.xiaohongshu.com/search_result', title: '通知', link: 'https://www.xiaohongshu.com/notification' },
      { sourceUrl: 'https://www.xiaohongshu.com/search_result', title: '作者', link: 'https://www.xiaohongshu.com/user/profile/user-1' },
      { sourceUrl: 'https://www.xiaohongshu.com/search_result', title: 'note', link: 'https://www.xiaohongshu.com/search_result/note-1' },
    ],
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.deepEqual(result.queryResults[0].candidates.map((candidate) => candidate.title), ['note'])
})

test('site research covers 18 queries, preserves query membership, and deep-reads a duplicate once', async () => {
  const queries = Array.from({ length: 18 }, (_, index) => `query-${index + 1}`)
  const detailCalls = new Map<string, number>()
  let lastCheckpoint: SiteResearchCheckpoint | null = null
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/user/profile/target',
    queries,
    urls: [],
    perQueryLimit: 3,
    detailLimitPerQuery: 2,
  }, {
    extract: async (url, options) => {
      if (options.template === 'card_list') {
        const query = decodeURIComponent(new URL(url).searchParams.get('keyword') || '')
        return [card(query, 0, true), card(query, 1)]
      }
      detailCalls.set(url, (detailCalls.get(url) || 0) + 1)
      return [{ sourceUrl: url, summary: `body for ${url}` }]
    },
    onCheckpoint: (checkpoint) => { lastCheckpoint = structuredClone(checkpoint) },
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })

  assert.equal(result.phase, 'completed')
  assert.equal(result.queryResults.length, 18)
  assert.ok(result.queryResults.every((entry) => entry.status === 'completed'))
  assert.equal(detailCalls.get('https://www.xiaohongshu.com/explore/shared'), 1)
  const shared = result.queryResults[0].candidates.find((candidate) => candidate.title === 'shared note')
  assert.deepEqual(shared?.matchedQueries, queries)
  assert.equal(result.queryResults[0].candidates[0].rank, 1)
  assert.equal(result.queryResults[17].candidates[0].rank, 1)
  assert.equal(Object.keys(shared?.queryRanks || {}).length, 18)
  assert.equal(lastCheckpoint?.phase, 'completed')
})

test('default 12-card result marks every non-deep-read candidate explicitly', async () => {
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 12,
    detailLimitPerQuery: 3,
  }, {
    extract: async (_url, options) => options.template === 'card_list'
      ? Array.from({ length: 12 }, (_, index) => card('one', index))
      : [{ sourceUrl: 'https://www.xiaohongshu.com/explore/detail', summary: 'verified body' }],
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  const candidates = result.queryResults[0].candidates
  assert.equal(candidates.length, 12)
  assert.equal(candidates.filter((candidate) => Boolean(candidate.body)).length, 3)
  assert.equal(candidates.filter((candidate) => candidate.bodyUnavailableReason === 'detail_not_selected').length, 9)
  assert.ok(candidates.every((candidate) => Boolean(candidate.body) || Boolean(candidate.bodyUnavailableReason)))
})

test('a failed duplicate detail URL is attempted once per run and shares its explicit reason', async () => {
  let detailAttempts = 0
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one', 'two'],
    urls: [],
    perQueryLimit: 1,
    detailLimitPerQuery: 1,
  }, {
    extract: async (_url, options) => {
      if (options.template === 'card_list') return [card('shared', 0, true)]
      detailAttempts += 1
      throw new Error('permanent detail unavailable')
    },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(detailAttempts, 1)
  assert.ok(result.queryResults.every((entry) => entry.candidates[0].bodyUnavailableReason === 'permanent detail unavailable'))
})

test('URL-set research processes all supplied URLs and supports a direct article URL', async () => {
  const urls = Array.from({ length: 18 }, (_, index) => `https://example.com/list-${index}`)
  const listResult = await runSiteResearch({
    scope: 'url_set', siteUrl: null, queries: [], urls,
    perQueryLimit: 2, detailLimitPerQuery: 0,
  }, {
    extract: async (url) => [{ sourceUrl: url, title: `item ${url}`, link: `${url}/item` }],
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(listResult.phase, 'completed')
  assert.equal(listResult.queryResults.length, 18)
  assert.deepEqual(listResult.queryResults.map((entry) => entry.query), urls)

  const templates: string[] = []
  const directUrl = 'https://www.xiaohongshu.com/explore/direct-note?xsec_token=required'
  const directResult = await runSiteResearch({
    scope: 'url_set', siteUrl: null, queries: ['direct'], urls: [directUrl],
    perQueryLimit: 2, detailLimitPerQuery: 1,
  }, {
    extract: async (url, options) => {
      templates.push(options.template)
      return options.template === 'card_list'
        ? [{
            sourceUrl: url,
            title: '__READY_RESEARCH_STATE__',
            link: url,
            rawFields: { researchState: 'structure_unavailable' },
          }]
        : [{ sourceUrl: url, title: 'Direct article', summary: 'Direct article body' }]
    },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.deepEqual(templates, ['article_list'])
  const directCandidate = directResult.queryResults[0].candidates[0]
  assert.equal(directCandidate.canonicalUrl, 'https://www.xiaohongshu.com/explore/direct-note')
  assert.equal(directCandidate.retrievalUrl, directUrl)
  assert.equal(directCandidate.body, 'Direct article body')
  assert.equal(directCandidate.bodyUnavailableReason, null)
})

test('a later duplicate body clears an earlier not-selected reason', async () => {
  let queryIndex = 0
  const result = await runSiteResearch({
    scope: 'current_site', siteUrl: 'https://www.xiaohongshu.com/', queries: ['one', 'two'], urls: [],
    perQueryLimit: 2, detailLimitPerQuery: 1,
  }, {
    extract: async (url, options) => {
      if (options.template === 'article_list') return [{ sourceUrl: url, summary: 'shared body' }]
      queryIndex += 1
      return queryIndex === 1
        ? [
            { sourceUrl: url, title: 'first', link: 'https://www.xiaohongshu.com/explore/first', rawFields: { engagement: '100' } },
            { sourceUrl: url, title: 'shared', link: 'https://www.xiaohongshu.com/explore/shared-late', rawFields: { engagement: '1' } },
          ]
        : [{ sourceUrl: url, title: 'shared', link: 'https://www.xiaohongshu.com/explore/shared-late', rawFields: { engagement: '100' } }]
    },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  const shared = result.queryResults[0].candidates.find((candidate) => candidate.title === 'shared')
  assert.equal(shared?.body, 'shared body')
  assert.equal(shared?.bodyUnavailableReason, null)
})

test('numeric summary text is never treated as engagement evidence', async () => {
  const result = await runSiteResearch({
    scope: 'url_set',
    siteUrl: null,
    queries: ['one'],
    urls: ['https://example.com/list'],
    perQueryLimit: 3,
    detailLimitPerQuery: 0,
  }, {
    extract: async () => [{ sourceUrl: 'https://example.com/list', title: '2026 plan', link: 'https://example.com/item', summary: '2026' }],
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(result.queryResults[0].candidates[0].engagement, null)
})

test('challenge pauses with a durable checkpoint and does not claim completion', async () => {
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one', 'two'],
    urls: [],
    perQueryLimit: 3,
    detailLimitPerQuery: 1,
  }, {
    extract: async () => { throw new Error('captcha verification required') },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(result.phase, 'waiting_human')
  assert.equal(result.queryIndex, 0)
  assert.equal(result.queryResults[0].status, 'waiting_human')
  assert.deepEqual(resolveSiteResearchTaskDisposition(result, { satisfied: false, missing: ['query_coverage'] }), {
    status: 'waiting_human', canResume: true, waitingFor: 'verification',
  })
})

test('English login states pause for human verification', async () => {
  for (const message of [
    'Login required',
    'Sign in to view this content',
    'Log in to continue',
    'Please sign in',
  ]) {
    const result = await runSiteResearch({
      scope: 'current_site', siteUrl: 'https://www.xiaohongshu.com/', queries: ['one'], urls: [],
      perQueryLimit: 3, detailLimitPerQuery: 1,
    }, {
      extract: async () => { throw new Error(message) },
      onCheckpoint: () => undefined,
      shouldStop: () => false,
      now: () => '2026-07-18T00:00:00.000Z',
    })
    assert.equal(result.phase, 'waiting_human', message)
    assert.equal(result.interruption?.classification, 'verification', message)
  }
})

test('a structured login state during a detail read pauses instead of recording an empty body', async () => {
  const result = await runSiteResearch({
    scope: 'current_site', siteUrl: 'https://www.xiaohongshu.com/', queries: ['one'], urls: [],
    perQueryLimit: 1, detailLimitPerQuery: 1,
  }, {
    extract: async (url, options) => options.template === 'card_list'
      ? [card('one', 0)]
      : [{
          sourceUrl: url,
          title: '__READY_RESEARCH_STATE__',
          link: url,
          rawFields: { researchState: 'waiting_human' },
        }],
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(result.phase, 'waiting_human')
  assert.equal(result.queryResults[0].candidates[0].bodyUnavailableReason, null)
})

test('rate limiting is a recoverable rate-limited checkpoint, not a human verification request', async () => {
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one', 'two'],
    urls: [],
    perQueryLimit: 3,
    detailLimitPerQuery: 1,
  }, {
    extract: async () => { throw new Error('429 rate limit; retry-after=30') },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(result.phase, 'rate_limited')
  assert.equal(result.queryIndex, 0)
  assert.equal(result.queryResults[0].status, 'rate_limited')
  assert.deepEqual(resolveSiteResearchTaskDisposition(result, { satisfied: false, missing: ['query_coverage'] }), {
    status: 'paused', canResume: true, waitingFor: 'rate_limit',
  })
})

test('Xiaohongshu empty extraction is not accepted without an explicit empty-state receipt', async () => {
  const base = {
    scope: 'current_site' as const,
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 3,
    detailLimitPerQuery: 0,
  }
  const common = {
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  }
  const unknown = await runSiteResearch(base, { ...common, extract: async () => [] })
  assert.equal(unknown.phase, 'failed')
  assert.match(String(unknown.pauseReason), /no verifiable result state/)

  const verified = await runSiteResearch(base, {
    ...common,
    extract: async (url) => [{
      sourceUrl: url,
      title: '__READY_RESEARCH_STATE__',
      link: url,
      rawFields: { researchState: 'verified_empty' },
    }],
  })
  assert.equal(verified.phase, 'completed')
  assert.equal(verified.queryResults[0].status, 'empty')

  const challenge = await runSiteResearch(base, {
    ...common,
    extract: async (url) => [{
      sourceUrl: url,
      title: '__READY_RESEARCH_STATE__',
      link: url,
      rawFields: { researchState: 'waiting_human' },
    }],
  })
  assert.equal(challenge.phase, 'waiting_human')
})

test('cancellation stops before the next detail navigation', async () => {
  let detailCalls = 0
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 3,
    detailLimitPerQuery: 3,
  }, {
    extract: async (url, options) => {
      if (options.template === 'card_list') return [card('one', 0), card('one', 1), card('one', 2)]
      detailCalls += 1
      return [{ sourceUrl: url, summary: 'body' }]
    },
    onCheckpoint: () => undefined,
    shouldStop: () => detailCalls >= 1,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(detailCalls, 1)
  assert.equal(result.phase, 'failed')
  assert.equal(result.pauseReason, 'cancelled')
})

test('account-fit research requires a readable bound profile before query work', async () => {
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 2,
    detailLimitPerQuery: 0,
    evaluationRequired: true,
    evaluationTargetUrl: 'https://www.xiaohongshu.com/search_result?keyword=one',
  }, {
    extract: async () => { throw new Error('must not extract without a profile binding') },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(result.phase, 'failed')
  assert.match(String(result.pauseReason), /profile page/)
  assert.deepEqual(resolveSiteResearchTaskDisposition(result, { satisfied: false, missing: ['account_evidence'] }), {
    status: 'failed', canResume: false, waitingFor: null,
  })

  assert.deepEqual(assessSiteResearchEssentialOutput({
    phase: 'completed', completedQueries: 1, expectedQueries: 1, candidateCount: 1,
    detailCount: 0, engagementCount: 0, fields: ['title'],
    evaluationRequired: true, evaluationReceipt: null,
  }), { satisfied: false, missing: ['account_evidence'] })
})

test('account-fit research records profile evidence before completing query research', async () => {
  const visited: string[] = []
  const profileUrl = 'https://www.xiaohongshu.com/user/profile/account-1'
  const result = await runSiteResearch({
    scope: 'current_site',
    siteUrl: profileUrl,
    queries: ['one'],
    urls: [],
    perQueryLimit: 2,
    detailLimitPerQuery: 0,
    evaluationRequired: true,
    evaluationTargetUrl: profileUrl,
  }, {
    extract: async (url) => {
      visited.push(url)
      if (url === profileUrl) return [card('account', 1)]
      return [card('one', 1)]
    },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(result.phase, 'completed')
  assert.equal(result.evaluationCompleted, true)
  assert.equal(result.evaluationReceipt?.state, 'content_evidence')
  assert.equal(result.evaluationEvidence?.length, 1)
  assert.equal(visited[0], profileUrl)
  assert.match(visited[1], /search_result\?keyword=one/)
})

test('an empty account stores a structured receipt without inventing evidence', async () => {
  const profileUrl = 'https://www.xiaohongshu.com/user/profile/empty-account'
  const result = await runSiteResearch({
    scope: 'current_site', siteUrl: profileUrl, queries: ['one'], urls: [],
    perQueryLimit: 2, detailLimitPerQuery: 0, evaluationRequired: true, evaluationTargetUrl: profileUrl,
  }, {
    extract: async (url) => url === profileUrl
      ? [{
          sourceUrl: url,
          title: '__READY_RESEARCH_STATE__',
          link: url,
          rawFields: {
            researchState: 'account_read',
            accountTitle: 'Empty creator account',
            accountSummary: 'Profile bio with no visible notes',
          },
        }]
      : [card('one', 1)],
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })
  assert.equal(result.evaluationEvidence?.length, 0)
  assert.deepEqual(result.evaluationReceipt, {
    targetUrl: profileUrl,
    state: 'account_read',
    capturedAt: '2026-07-18T00:00:00.000Z',
    title: 'Empty creator account',
    summary: 'Profile bio with no visible notes',
    visibleItemCount: 0,
  })
})

test('resuming an incomplete completed pass retries missing detail evidence', async () => {
  let detailAttempts = 0
  let searchAttempts = 0
  const input = {
    scope: 'current_site' as const,
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 1,
    detailLimitPerQuery: 1,
  }
  const port = {
    extract: async (url: string) => {
      if (url.includes('/search_result')) {
        searchAttempts += 1
        return [card('one', 0)]
      }
      detailAttempts += 1
      if (detailAttempts === 1) throw new Error('temporary detail failure')
      return [{ sourceUrl: url, summary: 'recovered body' }]
    },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  }
  const first = await runSiteResearch(input, port)
  assert.equal(first.phase, 'completed')
  assert.equal(first.queryResults[0].candidates[0].body, null)

  const resumed = await runSiteResearch({ ...input, checkpoint: first }, port)
  assert.equal(detailAttempts, 2)
  assert.equal(searchAttempts, 1)
  assert.equal(resumed.queryResults[0].candidates[0].body, 'recovered body')
})

test('resuming a human-blocked detail read does not rerun its completed query search', async () => {
  let searchAttempts = 0
  let detailAttempts = 0
  const input = {
    scope: 'current_site' as const,
    siteUrl: 'https://www.xiaohongshu.com/',
    queries: ['one'],
    urls: [],
    perQueryLimit: 1,
    detailLimitPerQuery: 1,
  }
  const port = {
    extract: async (url: string) => {
      if (url.includes('/search_result')) {
        searchAttempts += 1
        return [card('one', 0)]
      }
      detailAttempts += 1
      if (detailAttempts === 1) throw new Error('captcha verification required')
      return [{ sourceUrl: url, summary: 'recovered body' }]
    },
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  }

  const first = await runSiteResearch(input, port)
  assert.equal(first.phase, 'waiting_human')
  const resumed = await runSiteResearch({ ...input, checkpoint: first }, port)
  assert.equal(resumed.phase, 'completed')
  assert.equal(searchAttempts, 1)
  assert.equal(detailAttempts, 2)
  assert.equal(resumed.queryResults[0].candidates[0].body, 'recovered body')
})

test('essential output floor rejects coverage without requested engagement or body evidence', () => {
  assert.deepEqual(assessSiteResearchEssentialOutput({
    phase: 'completed',
    completedQueries: 18,
    expectedQueries: 18,
    candidateCount: 12,
    detailCount: 0,
    engagementCount: 0,
    fields: ['title', 'engagement', 'body'],
  }), {
    satisfied: false,
    missing: ['engagement', 'body'],
  })
})

test('essential output floor requires requested evidence for every non-empty query', () => {
  const candidate = (query: string, engagement: number | null, body: string | null) => ({
    rank: 1,
    queryRanks: { [query]: 1 },
    canonicalUrl: `https://example.com/${query}`,
    title: query,
    author: null,
    engagement,
    publishedAt: null,
    body,
    bodyUnavailableReason: null,
    capturedAt: '2026-07-18T00:00:00.000Z',
    matchedQueries: [query],
  })
  const queryResults = [
    { query: 'covered', status: 'completed' as const, candidates: [candidate('covered', 10, 'body')], error: null },
    { query: 'missing', status: 'completed' as const, candidates: [candidate('missing', null, null)], error: null },
  ]
  assert.deepEqual(assessSiteResearchEssentialOutput({
    phase: 'completed',
    completedQueries: 2,
    expectedQueries: 2,
    candidateCount: 2,
    detailCount: 1,
    engagementCount: 1,
    fields: ['engagement', 'body'],
    queryResults,
  }), { satisfied: false, missing: ['engagement', 'body'] })
})

test('essential output floor only accepts complete query coverage', () => {
  for (const completedQueries of [0, 1, 17, 18]) {
    const result = assessSiteResearchEssentialOutput({
      phase: 'completed',
      completedQueries,
      expectedQueries: 18,
      candidateCount: 1,
      detailCount: 0,
      engagementCount: 0,
      fields: ['title'],
    })
    assert.equal(result.satisfied, completedQueries === 18)
    assert.equal(result.missing.includes('query_coverage'), completedQueries !== 18)
  }
})

test('site research reuses one bound agent tab and never opens or activates a new tab', async () => {
  const navigations: Array<{ tabId: string; url: string }> = []
  const leaseService = new BrowserWriteLeaseService()
  const lease = leaseService.acquire({ surface: 'agent-view', taskId: 'task-1', runId: 'run-1', tabId: 'agent-tab' })
  assert.equal('errorCode' in lease, false)
  if ('errorCode' in lease) return
  const session = new BrowserSiteResearchTabSession({
    openTarget: async () => { throw new Error('must not open a foreground tab') },
    navigateTargetTab: async (tabId: string, url: string) => {
      navigations.push({ tabId, url })
      return { success: true, tabId }
    },
    extractStructured: async (_tabId: string, options: { template: 'card_list' | 'article_list' }) => ({
      items: [],
      template: options.template,
    }),
  } as never, leaseService, 'agent-view', lease.leaseId, 'agent-tab')

  await session.extract('https://example.com/one', { template: 'card_list', limit: 3 })
  await session.extract('https://example.com/two', { template: 'article_list', limit: 3 })
  assert.deepEqual(navigations, [
    { tabId: 'agent-tab', url: 'https://example.com/one' },
    { tabId: 'agent-tab', url: 'https://example.com/two' },
  ])
})

test('Xiaohongshu research uses its site adapter without changing the bound tab', async () => {
  const leaseService = new BrowserWriteLeaseService()
  const lease = leaseService.acquire({ surface: 'agent-view', taskId: 'task-xhs', runId: 'run-xhs', tabId: 'agent-tab-xhs' })
  assert.equal('errorCode' in lease, false)
  if ('errorCode' in lease) return
  let extraction: Record<string, unknown> | null = null
  const session = new BrowserSiteResearchTabSession({
    navigateTargetTab: async (tabId: string) => ({ success: true, tabId }),
    extractStructured: async (tabId: string, options: Record<string, unknown>) => {
      assert.equal(tabId, 'agent-tab-xhs')
      extraction = options
      return { items: [], template: 'custom' }
    },
  } as never, leaseService, 'agent-view', lease.leaseId, 'agent-tab-xhs')

  await session.extract('https://www.xiaohongshu.com/search_result/note?xsec_token=required', {
    template: 'article_list',
    limit: 4,
  })
  assert.equal(extraction?.template, 'custom')
  assert.match(String(extraction?.customScript), /#detail-desc/)
  const wait = extraction?.wait as Record<string, unknown>
  assert.doesNotMatch(String(wait.customJs), /querySelector\([^)]*\bmain\b/)
  assert.match(String(wait.customJs), /#detail-desc/)
})

test('a direct Xiaohongshu article uses the production tab session once and waits for real detail content', async () => {
  const leaseService = new BrowserWriteLeaseService()
  const lease = leaseService.acquire({ surface: 'agent-view', taskId: 'task-direct', runId: 'run-direct', tabId: 'agent-tab-direct' })
  assert.equal('errorCode' in lease, false)
  if ('errorCode' in lease) return
  const navigations: string[] = []
  const extractions: Record<string, unknown>[] = []
  const directUrl = 'https://www.xiaohongshu.com/explore/direct-production?xsec_token=required'
  const session = new BrowserSiteResearchTabSession({
    navigateTargetTab: async (tabId: string, url: string) => {
      assert.equal(tabId, 'agent-tab-direct')
      navigations.push(url)
      return { success: true, tabId }
    },
    extractStructured: async (_tabId: string, options: Record<string, unknown>) => {
      extractions.push(options)
      return {
        template: 'custom',
        items: [{ sourceUrl: directUrl, title: 'Direct production article', summary: 'Ready body' }],
      }
    },
  } as never, leaseService, 'agent-view', lease.leaseId, 'agent-tab-direct')

  const result = await runSiteResearch({
    scope: 'url_set', siteUrl: null, queries: ['direct'], urls: [directUrl],
    perQueryLimit: 2, detailLimitPerQuery: 1,
  }, {
    extract: (url, options) => session.extract(url, options),
    onCheckpoint: () => undefined,
    shouldStop: () => false,
    now: () => '2026-07-18T00:00:00.000Z',
  })

  assert.deepEqual(navigations, [directUrl])
  assert.equal(extractions.length, 1)
  assert.equal(extractions[0].template, 'custom')
  const wait = extractions[0].wait as Record<string, unknown>
  assert.doesNotMatch(String(wait.customJs), /querySelector\([^)]*\bmain\b/)
  assert.match(String(wait.customJs), /#detail-desc/)
  assert.equal(result.queryResults[0].candidates[0].body, 'Ready body')
})

test('site research without its background tab is terminal and explicitly not resumable', async () => {
  let saved: Record<string, unknown> | null = null
  let projections = 0
  await runBrowserSiteResearchTask({
    taskId: 'task-missing-agent-tab',
    payload: {
      scope: 'current_site',
      siteUrl: 'https://www.xiaohongshu.com/',
      queries: ['one'],
      fields: ['title'],
    },
    capabilityService: {} as never,
    persistenceService: {
      getTask: () => null,
      updateProgress: (_taskId: string, _progress: unknown, extras: Record<string, unknown>) => {
        saved = structuredClone(extras)
        return null
      },
    } as never,
    leaseService: new BrowserWriteLeaseService(),
    isCancelled: () => false,
    project: () => { projections += 1 },
  })

  assert.equal(saved?.status, 'failed')
  assert.equal(typeof saved?.finishedAt, 'string')
  const result = saved?.result as Record<string, unknown>
  assert.equal(result.canResume, false)
  assert.equal(result.essentialOutputSatisfied, false)
  assert.equal((result.interruption as Record<string, unknown>).classification, 'invalid_input')
  assert.equal(projections, 1)
})

test('site research blocked by an existing lease is paused with a truthful resumable result', async () => {
  const leaseService = new BrowserWriteLeaseService()
  const held = leaseService.acquire({ surface: 'agent-view', taskId: 'holder', runId: 'holder', tabId: 'holder-tab' })
  assert.equal('errorCode' in held, false)
  let saved: Record<string, unknown> | null = null
  await runBrowserSiteResearchTask({
    taskId: 'task-lease-wait',
    payload: {
      scope: 'current_site',
      siteUrl: 'https://www.xiaohongshu.com/',
      agentTabId: 'agent-tab',
      queries: ['one'],
      fields: ['title'],
    },
    capabilityService: {} as never,
    persistenceService: {
      getTask: () => null,
      updateProgress: (_taskId: string, _progress: unknown, extras: Record<string, unknown>) => {
        saved = structuredClone(extras)
        return null
      },
    } as never,
    leaseService,
    isCancelled: () => false,
    project: () => undefined,
  })

  assert.equal(saved?.status, 'paused')
  assert.equal(saved?.finishedAt, null)
  const result = saved?.result as Record<string, unknown>
  assert.equal(result.canResume, true)
  assert.equal(result.essentialOutputSatisfied, false)
  assert.equal((result.interruption as Record<string, unknown>).retryable, true)
})

test('site research reprojects the latest task revision after a concurrent projection sync', async () => {
  const task = {
    taskId: 'browser-task-research-projection-race',
    kind: 'site_research' as const,
    status: 'running' as const,
    progress: { total: 1, completed: 0, failed: 0, currentLabel: 'one' },
    result: { queryCount: 1, completedQueries: 0, candidateCount: 0, detailCount: 0, engagementCount: 0 },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    revision: 1,
    projectionRevision: 0,
    projectionSync: null as Record<string, unknown> | null,
  }
  const payload = { scopeId: 'scope-projection-race', queries: ['one'] }
  let firstProjection = true
  const persistence = {
    listTasks: () => [structuredClone(task)],
    getTask: () => structuredClone(task),
    getTaskPayload: () => structuredClone(payload),
    updateProjectionSync: (_taskId: string, input: { projectionRevision: number; sync: Record<string, unknown> | null }) => {
      if (input.sync) {
        task.projectionSync = structuredClone(input.sync)
      } else if (input.projectionRevision >= task.revision) {
        task.projectionRevision = input.projectionRevision
        task.projectionSync = null
      }
      return structuredClone(task)
    },
  }
  const projections: Array<{ completed: number; summary: string }> = []
  const runner = new BrowserContentTaskRunner({} as never, persistence as never, new BrowserWriteLeaseService())
  runner.setTaskProjectionSink({
    upsert: (input) => {
      projections.push({ completed: input.completed, summary: input.summary })
      if (firstProjection) {
        firstProjection = false
        task.revision = 2
        task.progress.completed = 1
        task.result = { ...task.result, completedQueries: 1, candidateCount: 1 }
        task.updatedAt = '2026-07-18T00:00:01.000Z'
      }
    },
  })

  for (let attempt = 0; attempt < 20 && projections.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(projections.length, 2)
  assert.equal(projections[1].completed, 1)
  assert.match(projections[1].summary, /查询 1\/1/)
  assert.equal(task.projectionRevision, 2)
  assert.equal(task.projectionSync, null)
})

test('browser research binds source identity to a dedicated agent tab and starts as incomplete', async () => {
  let request: { kind?: string; payload?: Record<string, unknown> } = {}
  const controller = {
    getTabList: () => [{ id: 'user-tab', url: 'https://www.xiaohongshu.com/user/profile/me', active: true, owner: 'manual' }],
    getActiveTab: () => ({ id: 'user-tab', url: 'https://www.xiaohongshu.com/user/profile/me', active: true, owner: 'manual' }),
    ensureAgentTab: async () => 'agent-tab',
    startTask: async (input: { kind: string; payload: Record<string, unknown> }) => {
      request = input
      return {
        taskId: 'browser-task-research-1',
        kind: 'site_research',
        status: 'queued',
        progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      }
    },
  }
  const output = await executeBrowserTool('browser_research', {
    scope: 'current_site',
    queries: ['one'],
    site_tab_id: 'user-tab',
  }, controller as never, undefined, 'scope-1', undefined, '搜索关键词：\none\n然后筛选适合当前账号的选题')
  const data = typeof output === 'string' ? JSON.parse(output) : output.data
  assert.equal(request.kind, 'site_research')
  assert.equal(request.payload?.siteTabId, 'user-tab')
  assert.equal(request.payload?.agentTabId, 'agent-tab')
  assert.equal(request.payload?.surface, 'agent-view')
  assert.equal(request.payload?.evaluationRequired, true)
  assert.equal(request.payload?.evaluationTargetUrl, 'https://www.xiaohongshu.com/user/profile/me')
  assert.equal('leaseId' in (request.payload || {}), false)
  assert.equal(data?.browserTaskId, 'browser-task-research-1')
  if (typeof output !== 'string') {
    assert.equal(output.projectionPatch?.browserResearchEssentialOutputSatisfied, false)
    assert.ok(output.projectionPatch?.continuationRef)
    assert.equal('terminalFailureReason' in (output.projectionPatch || {}), false)
  }
})

test('browser task authorization blocks cross-scope and cross-owner reads before leaking results', async () => {
  const task = {
    taskId: 'browser-task-research-1',
    kind: 'site_research',
    status: 'completed',
    progress: { total: 1, completed: 1, failed: 0, currentLabel: null },
    result: { essentialOutputSatisfied: true, queryResults: [] },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const controller = {
    getTask: async () => task,
    getTaskPayload: () => ({ scopeId: 'scope-a', ownerAgentId: 'agent-a', parentTaskId: 'parent-a' }),
  }
  const output = await executeBrowserTool(
    'browser_task',
    { action: 'get', task_id: task.taskId },
    controller as never,
    undefined,
    'scope-b',
    undefined,
    undefined,
    undefined,
    { ownerAgentId: 'agent-b', parentTaskId: 'parent-b' },
  )
  const data = typeof output === 'string' ? JSON.parse(output) : output.data
  assert.equal(data?.errorKind, 'authorization_denied')
})

test('browser task status remains readable from a later parent task in the same scope and agent', async () => {
  const task = {
    taskId: 'browser-task-research-follow-up',
    kind: 'site_research',
    status: 'failed',
    progress: { total: 18, completed: 18, failed: 0, currentLabel: null },
    result: {
      essentialOutputSatisfied: false,
      missingEssentialOutputs: ['detail_body'],
      queryResults: [],
    },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const output = await executeBrowserTool(
    'browser_task',
    { action: 'get', task_id: task.taskId },
    {
      getTask: async () => task,
      getTaskPayload: () => ({
        scopeId: 'scope-a',
        ownerAgentId: 'agent-a',
        parentTaskId: 'parent-original',
      }),
    } as never,
    undefined,
    'scope-a',
    undefined,
    undefined,
    undefined,
    { ownerAgentId: 'agent-a', parentTaskId: 'parent-follow-up' },
  )
  const data = typeof output === 'string' ? JSON.parse(output) : output.data
  assert.equal(data?.taskId, task.taskId)
  assert.equal(data?.status, 'failed')
  assert.equal(data?.errorKind, undefined)
})

test('browser task resume stops before scheduling when ownership rebinding conflicts', async () => {
  let resumed = false
  const task = {
    taskId: 'browser-task-research-conflict',
    kind: 'site_research',
    status: 'paused',
    progress: { total: 18, completed: 9, failed: 0, currentLabel: null },
    checkpoint: { taskId: 'browser-task-research-conflict', stage: 'site_research', cursor: '9' },
    result: { essentialOutputSatisfied: false, canResume: true },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const output = await executeBrowserTool('browser_task', {
    action: 'resume',
    task_id: task.taskId,
  }, {
    getTask: async () => task,
    getTaskPayload: () => ({ scopeId: 'scope-a', ownerAgentId: 'agent-a' }),
    rebindTaskExecution: () => false,
    resumeTask: async () => {
      resumed = true
      return task
    },
  } as never, undefined, 'scope-a', undefined, undefined, undefined, {
    ownerAgentId: 'agent-a',
    ownerRunId: 'run-new',
  })
  const data = typeof output === 'string' ? JSON.parse(output) : output.data
  assert.equal(data?.errorKind, 'task_rebind_conflict')
  assert.equal(resumed, false)
})

test('terminal site research failure cannot be rebound or resumed', async () => {
  let rebound = false
  let resumed = false
  const task = {
    taskId: 'browser-task-research-terminal',
    kind: 'site_research',
    status: 'failed',
    progress: { total: 1, completed: 0, failed: 1, currentLabel: null },
    checkpoint: { taskId: 'browser-task-research-terminal', stage: 'site_research', cursor: '0' },
    result: { essentialOutputSatisfied: false, canResume: false },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const output = await executeBrowserTool('browser_task', {
    action: 'resume', task_id: task.taskId,
  }, {
    getTask: async () => task,
    getTaskPayload: () => ({ scopeId: 'scope-a', ownerAgentId: 'agent-a' }),
    rebindTaskExecution: () => { rebound = true; return true },
    resumeTask: async () => { resumed = true; return task },
  } as never, undefined, 'scope-a', undefined, undefined, undefined, { ownerAgentId: 'agent-a' })
  const data = typeof output === 'string' ? JSON.parse(output) : output.data
  assert.equal(data?.errorKind, 'task_not_resumable')
  assert.equal(rebound, false)
  assert.equal(resumed, false)
})

test('failed research with a checkpoint remains resumable instead of becoming a terminal failure', async () => {
  const task = {
    taskId: 'browser-task-research-recoverable',
    kind: 'site_research',
    status: 'failed',
    progress: { total: 18, completed: 9, failed: 1, currentLabel: null },
    checkpoint: { taskId: 'browser-task-research-recoverable', stage: 'site_research', cursor: '9' },
    result: { essentialOutputSatisfied: false, canResume: true, queryCount: 18, completedQueries: 9 },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const output = await executeBrowserTool('browser_task', {
    action: 'get',
    task_id: task.taskId,
  }, {
    getTask: async () => task,
    getTaskPayload: () => ({ scopeId: 'scope-a' }),
  } as never, undefined, 'scope-a')
  assert.equal(typeof output === 'string', false)
  if (typeof output === 'string') return
  assert.ok(output.projectionPatch?.continuationRef)
  assert.equal('terminalFailureReason' in (output.projectionPatch || {}), false)
})

test('browser research result is bounded by query, candidate, and body caps', async () => {
  const longBody = 'b'.repeat(2_500)
  const queryResults = Array.from({ length: 22 }, (_, queryIndex) => ({
    query: `query-${queryIndex}`,
    status: 'completed',
    error: null,
    candidates: Array.from({ length: 6 }, (_, candidateIndex) => ({
      rank: candidateIndex + 1,
      canonicalUrl: `https://example.com/${queryIndex}/${candidateIndex}`,
      title: `candidate-${candidateIndex}`,
      body: longBody,
    })),
  }))
  const task = {
    taskId: 'browser-task-research-bounded',
    kind: 'site_research',
    status: 'completed',
    progress: { total: 22, completed: 22, failed: 0, currentLabel: null },
    result: {
      essentialOutputSatisfied: true,
      queryCount: 22,
      completedQueries: 22,
      candidateCount: 132,
      detailCount: 132,
      engagementCount: 132,
      evaluationRequired: true,
      evaluationCompleted: true,
      evaluationTargetUrl: 'https://www.xiaohongshu.com/user/profile/account-1',
      evaluationReceipt: {
        targetUrl: 'https://www.xiaohongshu.com/user/profile/account-1',
        state: 'content_evidence',
        capturedAt: '2026-07-18T00:00:00.000Z',
        title: 'Creator',
        summary: 'Creator profile summary',
        visibleItemCount: 15,
      },
      evaluationEvidence: Array.from({ length: 15 }, (_, index) => ({
        title: `account-note-${index}`,
        canonicalUrl: `https://www.xiaohongshu.com/explore/account-${index}`,
        author: 'Creator',
        engagement: index,
      })),
      queryResults,
    },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  }
  const output = await executeBrowserTool('browser_task', {
    action: 'result',
    task_id: task.taskId,
  }, {
    getTask: async () => task,
    getTaskPayload: () => ({ scopeId: 'scope-a' }),
  } as never, undefined, 'scope-a')
  const data = typeof output === 'string' ? JSON.parse(output) : output.data
  const results = data?.result?.queryResults as Array<{ candidates: Array<{ body: string }> }>
  assert.equal(data?.result?.truncated, true)
  assert.ok(results.every((entry) => entry.candidates.length <= 5))
  assert.ok(results.flatMap((entry) => entry.candidates).length <= 100)
  assert.ok(results.flatMap((entry) => entry.candidates).every((candidate) => candidate.body.length <= 2_000))
  assert.equal(data?.result?.evaluationEvidenceCount, 15)
  assert.equal(data?.result?.evaluationEvidence.length, 12)
  assert.equal(data?.result?.evaluationReceipt.state, 'content_evidence')
  assert.equal(data?.result?.evaluationTargetUrl, 'https://www.xiaohongshu.com/user/profile/account-1')
})
