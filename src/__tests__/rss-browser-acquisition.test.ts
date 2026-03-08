import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  fetchFeedViaBrowserSession,
  normalizeBrowserAcquisitionUrl,
  supportsBrowserSessionAcquisition,
} from '../main/modules/rss-engine/browser-acquisition'

describe('RSS browser acquisition', () => {
  it('marks weibo/xiaohongshu/douyin as browser-session capable', () => {
    assert.equal(supportsBrowserSessionAcquisition('weibo'), true)
    assert.equal(supportsBrowserSessionAcquisition('xiaohongshu'), true)
    assert.equal(supportsBrowserSessionAcquisition('douyin'), true)
    assert.equal(supportsBrowserSessionAcquisition('youtube'), false)
  })

  it('normalizes extracted browser candidates into scraped items', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '创作者主页',
        finalUrl: 'https://www.xiaohongshu.com/user/profile/abc',
        items: [
          {
            title: '第一条内容',
            link: 'https://www.xiaohongshu.com/explore/1',
            description: '描述一',
          },
          {
            title: '第一条内容',
            link: 'https://www.xiaohongshu.com/explore/1',
            description: '重复内容',
          },
          {
            title: '第二条内容',
            link: 'https://www.xiaohongshu.com/explore/2',
            description: '描述二',
          },
          {
            title: '坏链接',
            link: 'https://www.xiaohongshu.com/explore/',
            description: '应当被过滤',
          },
        ],
      }),
    }

    const result = await fetchFeedViaBrowserSession(controller as any, 'xiaohongshu', 'https://xhslink.com/demo')

    assert.equal(result.feedTitle, '创作者主页')
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0]?.title, '第一条内容')
    assert.equal(result.items[1]?.title, '第二条内容')
    assert.equal(result.error, undefined)
  })

  it('filters malformed xiaohongshu links returned by browser capture', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '创作者主页',
        finalUrl: 'https://www.xiaohongshu.com/user/profile/abc',
        items: [
          {
            title: '坏链接',
            link: 'https://www.xiaohongshu.com/explore/',
            description: '应当被过滤',
          },
        ],
      }),
    }

    const result = await fetchFeedViaBrowserSession(controller as any, 'xiaohongshu', 'https://xhslink.com/demo')

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /未提取到可用条目/)
  })

  it('normalizes browser acquisition URLs into canonical profile routes', async () => {
    const douyin = await normalizeBrowserAcquisitionUrl(
      'douyin',
      'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST',
    )
    const xiaohongshu = await normalizeBrowserAcquisitionUrl(
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60?foo=bar',
    )
    const weibo = await normalizeBrowserAcquisitionUrl(
      'weibo',
      'https://m.weibo.cn/profile/6182606334',
    )

    assert.equal(
      douyin,
      'https://www.iesdouyin.com/share/user/demo?sec_uid=MS4wLjABAAAATEST',
    )
    assert.equal(xiaohongshu, 'https://www.xiaohongshu.com/user/profile/5b6af7459e8ccb000181bd60')
    assert.equal(weibo, 'https://weibo.com/u/6182606334')
  })

  it('surfaces a useful error when the page loads but no feed-like items are found', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '空白主页',
        finalUrl: 'https://www.douyin.com/user/demo',
        items: [],
      }),
    }

    const result = await fetchFeedViaBrowserSession(controller as any, 'douyin', 'https://v.douyin.com/demo')

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /未提取到可用条目/)
  })

  it('surfaces a login-required error when browser session is redirected to login', async () => {
    let seenOptions: Record<string, unknown> | undefined
    const controller = {
      captureBackgroundPage: async (_url: string, options?: Record<string, unknown>) => {
        seenOptions = options
        return ({
        title: '小红书登录',
        finalUrl: 'https://www.xiaohongshu.com/login?redirectPath=%2Fuser%2Fprofile%2Fabc',
        state: 'auth',
        items: [],
        })
      },
    }

    const result = await fetchFeedViaBrowserSession(
      controller as any,
      'xiaohongshu',
      'https://www.xiaohongshu.com/user/profile/abc',
    )

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /未登录|登录页/)
    assert.equal(seenOptions?.cookies, undefined)
  })

  it('surfaces an anti-bot error when browser session hits verification', async () => {
    const controller = {
      captureBackgroundPage: async () => ({
        title: '抖音',
        finalUrl: 'https://www.douyin.com/user/demo',
        state: 'anti_bot',
        textSnippet: '系统检测到异常行为，请先完成验证',
        items: [],
      }),
    }

    const result = await fetchFeedViaBrowserSession(
      controller as any,
      'douyin',
      'https://v.douyin.com/demo',
    )

    assert.equal(result.items.length, 0)
    assert.match(result.error || '', /验证码|风控|验证/)
  })
})
