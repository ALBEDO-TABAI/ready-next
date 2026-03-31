import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildRSSBrowserOpenAction, shouldPauseSilentBrowserRetry } from '../main/modules/rss-engine/browser-handoff'

describe('RSS browser handoff helpers', () => {
  it('builds a login action for auth failures', () => {
    const action = buildRSSBrowserOpenAction('weibo', 'https://weibo.com/u/123', 'auth')

    assert.deepEqual(action, {
      type: 'open_in_browser',
      label: '去浏览器登录',
      url: 'https://weibo.com/u/123',
      platform: 'weibo',
      reason: 'login',
    })
  })

  it('builds a verification action for anti-bot failures', () => {
    const action = buildRSSBrowserOpenAction(
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/demo',
      'anti_bot',
    )

    assert.deepEqual(action, {
      type: 'open_in_browser',
      label: '去浏览器继续验证',
      url: 'https://www.xiaohongshu.com/user/profile/demo',
      platform: 'xiaohongshu',
      reason: 'verify',
    })
  })

  it('builds a generic inspect action for route failures', () => {
    const action = buildRSSBrowserOpenAction(
      'douyin',
      'https://www.douyin.com/user/demo',
      'route',
    )

    assert.deepEqual(action, {
      type: 'open_in_browser',
      label: '去浏览器查看页面',
      url: 'https://www.douyin.com/user/demo',
      platform: 'douyin',
      reason: 'inspect',
    })
  })

  it('pauses silent retry for recent anti-bot failures when no reusable page exists', () => {
    const now = Date.parse('2026-03-31T06:10:00.000Z')
    const paused = shouldPauseSilentBrowserRetry(
      'anti_bot',
      '2026-03-31T06:05:00.000Z',
      false,
      now,
    )

    assert.equal(paused, true)
  })

  it('allows retry after anti-bot when a reusable page already exists', () => {
    const now = Date.parse('2026-03-31T06:10:00.000Z')
    const paused = shouldPauseSilentBrowserRetry(
      'anti_bot',
      '2026-03-31T06:05:00.000Z',
      true,
      now,
    )

    assert.equal(paused, false)
  })
})
