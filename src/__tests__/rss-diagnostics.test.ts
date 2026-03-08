import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  allowsRSSHubFallbackAfterBrowser,
  buildBenchmarkSummary,
  buildSourceDiagnostics,
  getRouteCapabilityMatrix,
  recordSourceRouteAttempt,
} from '../main/modules/rss-engine/source-diagnostics'

describe('RSS source diagnostics', () => {
  it('marks browser-backed failures with structured failure kinds', () => {
    recordSourceRouteAttempt({
      sourceId: 'xhs-source',
      sourceName: 'XHS Creator',
      url: 'https://www.xiaohongshu.com/user/profile/test',
      groupName: 'creator-watchlist',
      platform: 'xiaohongshu',
      durationMs: 1840,
      itemCount: 0,
      success: false,
      error:
        'HTTP 503: Service Unavailable | {"error":{"message":"Waiting for selector `div.reds-tab-item:nth-child(2), #red-captcha` failed: Protocol error (Runtime.callFunctionOn): Target closed"}}',
    })

    const [entry] = buildSourceDiagnostics([
      {
        id: 'xhs-source',
        name: 'XHS Creator',
        url: 'https://www.xiaohongshu.com/user/profile/test',
        group_name: 'creator-watchlist',
        platform: 'xiaohongshu',
      },
    ])

    assert.equal(entry.backend, 'browser')
    assert.equal(entry.backendState, 'failing')
    assert.equal(entry.chromiumRequired, true)
    assert.equal(entry.scraplingEligible, true)
    assert.equal(entry.lastRouteError?.kind, 'route')
    assert.equal(entry.lastRouteError?.detail, 'browser_target_closed')
  })

  it('marks Chromium-dependent successful routes as conditional instead of stable', () => {
    recordSourceRouteAttempt({
      sourceId: 'weibo-source',
      sourceName: 'Weibo Creator',
      url: 'https://weibo.com/u/123',
      groupName: 'creator-watchlist',
      platform: 'weibo',
      durationMs: 920,
      itemCount: 12,
      success: true,
    })

    const [entry] = buildSourceDiagnostics([
      {
        id: 'weibo-source',
        name: 'Weibo Creator',
        url: 'https://weibo.com/u/123',
        group_name: 'creator-watchlist',
        platform: 'weibo',
      },
    ])

    assert.equal(entry.backendState, 'conditional')
    assert.equal(entry.lastRouteError, null)
  })
})

describe('RSS benchmark summary', () => {
  it('surfaces Scrapling candidate platforms only for failing eligible backends', () => {
    const summary = buildBenchmarkSummary([
      {
        sourceId: 'yt-source',
        sourceName: 'YouTube Creator',
        platform: 'youtube',
        backend: 'native',
        chromiumRequired: false,
        scraplingEligible: false,
        success: true,
        durationMs: 300,
        itemCount: 10,
        error: null,
        failureKind: null,
      },
      {
        sourceId: 'xhs-source',
        sourceName: 'XHS Creator',
        platform: 'xiaohongshu',
        backend: 'browser',
        chromiumRequired: true,
        scraplingEligible: true,
        success: false,
        durationMs: 2200,
        itemCount: 0,
        error: 'TargetCloseError',
        failureKind: 'route',
      },
    ])

    assert.equal(summary.sourceCount, 2)
    assert.equal(summary.failureCount, 1)
    assert.deepEqual(summary.scraplingCandidatePlatforms, ['xiaohongshu'])
  })

  it('exposes the fixed route capability matrix', () => {
    const matrix = getRouteCapabilityMatrix()
    const douyin = matrix.find((entry) => entry.platform === 'douyin')
    const xiaohongshu = matrix.find((entry) => entry.platform === 'xiaohongshu')
    const behance = matrix.find((entry) => entry.platform === 'behance')

    assert.equal(douyin?.backend, 'browser')
    assert.deepEqual(douyin?.fallbackOrder, ['browser', 'scrapling'])
    assert.deepEqual(xiaohongshu?.fallbackOrder, ['browser', 'scrapling'])
    assert.equal(douyin?.scraplingEligible, true)
    assert.equal(behance?.backend, 'native')
    assert.equal(behance?.scraplingEligible, false)
  })

  it('allows RSSHub fallback after browser only for weibo', () => {
    assert.equal(allowsRSSHubFallbackAfterBrowser('weibo'), true)
    assert.equal(allowsRSSHubFallbackAfterBrowser('douyin'), false)
    assert.equal(allowsRSSHubFallbackAfterBrowser('xiaohongshu'), false)
  })
})
