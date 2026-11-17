import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildBenchmarkSummary,
  buildSourceDiagnostics,
  getRouteCapabilityMatrix,
  recordSourceRouteAttempt,
} from '../main/modules/rss-engine/source-diagnostics'
import { mayUseRSSHub } from '../main/modules/rss-engine/scrapers/index'

describe('RSS source diagnostics', () => {
  it('marks a Xiaohongshu sign-in page as a browser-session failure the person can act on', () => {
    recordSourceRouteAttempt({
      sourceId: 'xhs-source',
      sourceName: 'XHS Creator',
      url: 'https://www.xiaohongshu.com/user/profile/test',
      groupName: 'creator-watchlist',
      platform: 'xiaohongshu',
      durationMs: 1840,
      itemCount: 0,
      success: false,
      error: '[XHS Creator] 小红书 应用内浏览器会话当前未登录，或已被重定向到登录页 (https://www.xiaohongshu.com/login)。请先在 Ready 浏览器中登录该站点后再刷新。',
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
    assert.equal(entry.scraplingEligible, false)
    assert.equal(entry.lastRouteError?.kind, 'auth')
    assert.equal(entry.lastRouteError?.detail, 'login_or_cookie_required')
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

  it('classifies RSSHub timeout and parser failures as route failures', () => {
    recordSourceRouteAttempt({
      sourceId: 'xhs-timeout',
      sourceName: 'XHS Timeout',
      url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
      groupName: 'creator-watchlist',
      platform: 'xiaohongshu',
      durationMs: 35000,
      itemCount: 0,
      success: false,
      error: 'Request timed out after 35000ms',
    })
    recordSourceRouteAttempt({
      sourceId: 'xhs-parser',
      sourceName: 'XHS Parser',
      url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
      groupName: 'creator-watchlist',
      platform: 'xiaohongshu',
      durationMs: 8500,
      itemCount: 0,
      success: false,
      error: "HTTP 503: Service Unavailable | Cannot read properties of undefined (reading 'user')",
    })

    const [timeoutEntry, parserEntry] = buildSourceDiagnostics([
      {
        id: 'xhs-timeout',
        name: 'XHS Timeout',
        url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
        group_name: 'creator-watchlist',
        platform: 'xiaohongshu',
      },
      {
        id: 'xhs-parser',
        name: 'XHS Parser',
        url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
        group_name: 'creator-watchlist',
        platform: 'xiaohongshu',
      },
    ])

    assert.equal(timeoutEntry.lastRouteError?.kind, 'route')
    assert.equal(timeoutEntry.lastRouteError?.detail, 'route_request_timeout')
    assert.equal(parserEntry.lastRouteError?.kind, 'route')
    assert.equal(parserEntry.lastRouteError?.detail, 'route_parser_failed')
  })

  it('classifies a Xiaohongshu profile behind its security restriction as upstream risk control', () => {
    recordSourceRouteAttempt({
      sourceId: 'xhs-blocked',
      sourceName: 'XHS Blocked',
      url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
      platform: 'xiaohongshu',
      durationMs: 33000,
      itemCount: 0,
      success: false,
      error: '[XHS Blocked] 小红书没有打开这个主页：访问被转到了登录或安全限制页，多为当前网络被小红书风控。换个网络后再刷新。',
    })

    const [entry] = buildSourceDiagnostics([
      { id: 'xhs-blocked', name: 'XHS Blocked', url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06', platform: 'xiaohongshu' },
    ])

    assert.equal(entry.lastRouteError?.kind, 'waf')
    assert.equal(entry.lastRouteError?.detail, 'upstream_waf_or_risk_control')
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
    const bilibili = matrix.find((entry) => entry.platform === 'bilibili')
    const weibo = matrix.find((entry) => entry.platform === 'weibo')
    const douyin = matrix.find((entry) => entry.platform === 'douyin')
    const xiaohongshu = matrix.find((entry) => entry.platform === 'xiaohongshu')
    const behance = matrix.find((entry) => entry.platform === 'behance')

    assert.equal(bilibili?.backend, 'browser')
    assert.deepEqual(bilibili?.fallbackOrder, ['browser', 'rsshub'])
    assert.equal(weibo?.backend, 'browser')
    assert.deepEqual(weibo?.fallbackOrder, ['browser', 'scrapling'])
    assert.equal(douyin?.backend, 'browser')
    assert.deepEqual(douyin?.fallbackOrder, ['browser', 'scrapling'])
    assert.equal(xiaohongshu?.backend, 'browser')
    assert.deepEqual(xiaohongshu?.fallbackOrder, ['browser'])
    assert.equal(xiaohongshu?.chromiumRequired, true)
    assert.equal(douyin?.scraplingEligible, true)
    assert.equal(behance?.backend, 'native')
    assert.equal(behance?.scraplingEligible, false)
  })

  it('only a signed-out Bilibili space can end up asking RSSHub', () => {
    assert.equal(mayUseRSSHub('bilibili'), true)
    assert.equal(mayUseRSSHub('weibo'), false)
    assert.equal(mayUseRSSHub('douyin'), false)
    assert.equal(mayUseRSSHub('xiaohongshu'), false)
    assert.equal(mayUseRSSHub('rss'), false)
  })

  it('tells sign-in pages, verification pages and risk pages apart from the session messages', () => {
    const kindOf = (message: string) => {
      recordSourceRouteAttempt({
        sourceId: 'kind-probe',
        sourceName: 'Probe',
        url: 'https://space.bilibili.com/1',
        platform: 'bilibili',
        durationMs: 1,
        itemCount: 0,
        success: false,
        error: message,
      })
      return buildSourceDiagnostics([{ id: 'kind-probe', name: 'Probe', url: 'https://space.bilibili.com/1', platform: 'bilibili' }])[0]
        .lastRouteError?.kind
    }
    assert.equal(kindOf('[影视飓风] Bilibili 应用内浏览器会话当前未登录，或已被重定向到登录页 (https://space.bilibili.com/946974/upload/video)。请先在 Ready 浏览器中登录该站点后再刷新。'), 'auth')
    assert.equal(kindOf('[影视飓风] Bilibili 应用内浏览器当前遇到验证码/风控校验 (https://space.bilibili.com/946974/upload/video)：访问异常'), 'anti_bot')
    assert.equal(kindOf('[广州潮会吃] 小红书 应用内浏览器当前被平台风控/WAF 拦截 (https://www.xiaohongshu.com/website-login/error)'), 'waf')
  })
})
