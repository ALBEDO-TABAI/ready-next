import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  allowsRSSHubFallbackAfterBrowser,
  buildBenchmarkSummary,
  buildSourceDiagnostics,
  getRouteCapabilityMatrix,
  recordSourceRouteAttempt,
} from '../main/modules/rss-engine/source-diagnostics'
import { needsRSSHub } from '../main/modules/rss-engine/scrapers/index'

describe('RSS source diagnostics', () => {
  it('marks xiaohongshu RSSHub failures without browser-session requirements', () => {
    recordSourceRouteAttempt({
      sourceId: 'xhs-source',
      sourceName: 'XHS Creator',
      url: 'https://www.xiaohongshu.com/user/profile/test',
      groupName: 'creator-watchlist',
      platform: 'xiaohongshu',
      durationMs: 1840,
      itemCount: 0,
      success: false,
      error: 'RSSHub unavailable: embedded worker failed to start',
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

    assert.equal(entry.backend, 'rsshub')
    assert.equal(entry.backendState, 'failing')
    assert.equal(entry.chromiumRequired, false)
    assert.equal(entry.scraplingEligible, false)
    assert.equal(entry.lastRouteError?.kind, 'startup')
    assert.equal(entry.lastRouteError?.detail, 'rsshub_runtime_unavailable')
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
        sourceId: 'douyin-source',
        sourceName: 'Douyin Creator',
        platform: 'douyin',
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
    assert.deepEqual(summary.scraplingCandidatePlatforms, ['douyin'])
  })

  it('exposes the fixed route capability matrix', () => {
    const matrix = getRouteCapabilityMatrix()
    const weibo = matrix.find((entry) => entry.platform === 'weibo')
    const douyin = matrix.find((entry) => entry.platform === 'douyin')
    const xiaohongshu = matrix.find((entry) => entry.platform === 'xiaohongshu')
    const behance = matrix.find((entry) => entry.platform === 'behance')

    assert.equal(weibo?.backend, 'browser')
    assert.deepEqual(weibo?.fallbackOrder, ['browser', 'scrapling'])
    assert.equal(douyin?.backend, 'browser')
    assert.deepEqual(douyin?.fallbackOrder, ['browser', 'scrapling'])
    assert.equal(xiaohongshu?.backend, 'rsshub')
    assert.deepEqual(xiaohongshu?.fallbackOrder, ['rsshub'])
    assert.equal(xiaohongshu?.chromiumRequired, false)
    assert.equal(douyin?.scraplingEligible, true)
    assert.equal(behance?.backend, 'native')
    assert.equal(behance?.scraplingEligible, false)
  })

  it('disables RSSHub fallback after browser for browser-first creator platforms', () => {
    assert.equal(allowsRSSHubFallbackAfterBrowser('weibo'), false)
    assert.equal(allowsRSSHubFallbackAfterBrowser('douyin'), false)
    assert.equal(allowsRSSHubFallbackAfterBrowser('xiaohongshu'), false)
  })

  it('treats bilibili and xiaohongshu as RSSHub-required among creator platforms', () => {
    assert.equal(needsRSSHub('bilibili'), true)
    assert.equal(needsRSSHub('weibo'), false)
    assert.equal(needsRSSHub('douyin'), false)
    assert.equal(needsRSSHub('xiaohongshu'), true)
  })
})
