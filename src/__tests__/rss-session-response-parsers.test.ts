import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseBilibiliSpaceResponses,
  parseXiaohongshuNoteResponses,
} from '../main/modules/rss-engine/session-response-parsers'

const OWNER = '946974'

function response(url: string, payload: unknown, status = 200) {
  return { url, status, body: typeof payload === 'string' ? payload : JSON.stringify(payload) }
}

function uploads(rows: unknown[]) {
  return response(
    `https://api.bilibili.com/x/space/wbi/arc/search?mid=${OWNER}&pn=1&ps=40&order=pubdate&w_rid=abc&wts=1`,
    { code: 0, data: { list: { vlist: rows }, page: { pn: 1, ps: 40, count: rows.length } } },
  )
}

const uploads2 = (rows: unknown[]) => uploads(rows)

describe('Bilibili space responses', () => {
  it('reads the uploads the space page requested, newest first, with time, summary and cover', () => {
    const reading = parseBilibiliSpaceResponses([
      uploads([
        { bvid: 'BV1aa411c7mD', title: '旧视频', description: '旧简介', pic: '//i0.hdslb.com/old.jpg', created: 1_790_000_000, author: '影视飓风', mid: 946974 },
        { bvid: 'BV1bb411c7mE', title: '新视频', description: '新简介', pic: 'http://i0.hdslb.com/new.jpg', created: 1_794_000_000, author: '影视飓风', mid: 946974 },
      ]),
    ], OWNER)

    assert.equal(reading.risk, null)
    assert.deepEqual(reading.rows, [
      { bvid: 'BV1bb411c7mE', title: '新视频', description: '新简介', cover: 'https://i0.hdslb.com/new.jpg', author: '影视飓风', publishedAt: 1_794_000_000 },
      { bvid: 'BV1aa411c7mD', title: '旧视频', description: '旧简介', cover: 'https://i0.hdslb.com/old.jpg', author: '影视飓风', publishedAt: 1_790_000_000 },
    ])
  })

  it('keeps a co-authored upload listed on the space even though it carries another uploader id', () => {
    const reading = parseBilibiliSpaceResponses([
      uploads([{ bvid: 'BV1cc411c7mF', title: '联合投稿', created: 1_794_000_100, author: '别的 UP', mid: 1 }]),
    ], OWNER)

    assert.equal(reading.rows.length, 1)
    assert.equal(reading.rows[0].bvid, 'BV1cc411c7mF')
  })

  it('ignores videos from other lists on the page: liked, coined, recommended', () => {
    const reading = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/like/video?vmid=${OWNER}`, {
        code: 0,
        data: { list: [{ bvid: 'BV1dd411c7mG', title: '别人被点赞的视频', pubdate: 1_794_000_200, owner: { mid: 777, name: '别人' } }] },
      }),
      response(`https://api.bilibili.com/x/space/coin/video?vmid=${OWNER}`, {
        code: 0,
        data: [{ bvid: 'BV1ee411c7mH', title: '别人被投币的视频', pubdate: 1_794_000_300, owner: { mid: 888 } }],
      }),
    ], OWNER)

    assert.deepEqual(reading.rows, [])
    assert.equal(reading.risk, null)
  })

  it('recognises a renamed endpoint by the shape of its data', () => {
    const reading = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/v3/uploads?host_mid=${OWNER}`, {
        code: 0,
        data: { archives: [{ bvid: 'BV1ff411c7mJ', title: '改名后的接口', pubdate: 1_794_000_400, cover: '//i0.hdslb.com/c.jpg', owner: { mid: 946974, name: '影视飓风' } }] },
      }),
    ], OWNER)

    assert.equal(reading.rows.length, 1)
    assert.equal(reading.rows[0].author, '影视飓风')
    assert.equal(reading.rows[0].publishedAt, 1_794_000_400)
  })

  it('reports the platform risk answer instead of treating it as an empty list', () => {
    const blocked = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/wbi/arc/search?mid=${OWNER}`, { code: -352, message: '风控校验失败', data: { v_voucher: 'x' } }),
    ], OWNER)
    assert.deepEqual(blocked.rows, [])
    assert.equal(blocked.risk?.kind, 'waf')

    const rejected = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/wbi/arc/search?mid=${OWNER}`, '{"code":-412,"message":"请求被拦截"}', 412),
    ], OWNER)
    assert.equal(rejected.risk?.kind, 'waf')
  })

  it('learns whether the person is signed in from the page own account request', () => {
    const signedOut = parseBilibiliSpaceResponses([
      response('https://api.bilibili.com/x/web-interface/nav', { code: -101, message: '账号未登录', data: { isLogin: false } }),
    ], OWNER)
    assert.equal(signedOut.loggedIn, false)
    assert.equal(signedOut.risk, null, 'the account request is not a failed list')

    const signedIn = parseBilibiliSpaceResponses([
      response('https://api.bilibili.com/x/web-interface/nav', { code: 0, data: { isLogin: true, mid: 42 } }),
    ], OWNER)
    assert.equal(signedIn.loggedIn, true)
  })

  it('survives bodies that are not JSON', () => {
    const reading = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/wbi/arc/search?mid=${OWNER}`, '<html>gateway error</html>', 502),
    ], OWNER)
    assert.deepEqual(reading, { rows: [], risk: null, uploadsRefused: false, loggedIn: null })
  })

  it('tells a refused uploads request from a risk answer on some other request of the page', () => {
    const elsewhere = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/wbi/acc/info?mid=${OWNER}`, { code: -352, message: '风控校验失败' }),
    ], OWNER)
    assert.equal(elsewhere.risk?.kind, 'waf')
    assert.equal(elsewhere.uploadsRefused, false, 'the list may still arrive')

    const uploads = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/wbi/arc/search?mid=${OWNER}`, { code: -352, message: '风控校验失败' }),
    ], OWNER)
    assert.equal(uploads.uploadsRefused, true)

    const later = parseBilibiliSpaceResponses([
      response(`https://api.bilibili.com/x/space/wbi/acc/info?mid=${OWNER}`, { code: -352, message: '风控校验失败' }),
      uploads2([{ bvid: 'BV1bb411c7mE', title: '后到的列表', created: 1_794_000_000 }]),
    ], OWNER)
    assert.equal(later.rows.length, 1, 'rows that arrive after a risk answer elsewhere are still read')
  })
})

const PROFILE = '5e31b693000000000100bb06'
const NOTE_A = '65f0a1b2c3d4e5f6a7b8c9d0'
const NOTE_B = '65f0a1b2c3d4e5f6a7b8c9d1'

describe('Xiaohongshu note responses', () => {
  it('reads the notes a profile page requested, with the access token the page attached', () => {
    const reading = parseXiaohongshuNoteResponses([
      response(`https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?num=30&cursor=&user_id=${PROFILE}`, {
        code: 0,
        success: true,
        data: {
          notes: [
            { note_id: NOTE_A, display_title: '第一篇', xsec_token: 'TOKEN_A', cover: { url_default: 'http://sns-img/a.jpg' }, user: { user_id: PROFILE, nickname: '广州潮会吃' } },
            { note_id: NOTE_B, display_title: '', xsec_token: 'TOKEN_B', cover: { info_list: [{ url: 'https://sns-img/b.jpg' }] }, user: { user_id: PROFILE, nick_name: '广州潮会吃' } },
          ],
          has_more: true,
        },
      }),
    ], PROFILE)

    assert.equal(reading.risk, null)
    assert.deepEqual(reading.rows, [
      { noteId: NOTE_A, title: '第一篇', cover: 'https://sns-img/a.jpg', author: '广州潮会吃', userId: PROFILE, xsecToken: 'TOKEN_A' },
      { noteId: NOTE_B, title: '小红书内容', cover: 'https://sns-img/b.jpg', author: '广州潮会吃', userId: PROFILE, xsecToken: 'TOKEN_B' },
    ])
  })

  it('leaves out notes that belong to someone else', () => {
    const reading = parseXiaohongshuNoteResponses([
      response('https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=someone-else', {
        code: 0,
        data: { notes: [{ note_id: NOTE_A, display_title: '别人的', user: { user_id: 'someone-else' } }] },
      }),
    ], PROFILE)
    assert.deepEqual(reading.rows, [])
  })

  it('does not take tags, topics or users for notes because their ids look alike', () => {
    const reading = parseXiaohongshuNoteResponses([
      response(`https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${PROFILE}`, {
        code: 0,
        data: {
          notes: [{ note_id: NOTE_A, display_title: '第一篇', user: { user_id: PROFILE }, tag_list: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: '探店' }] }],
          topics: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', title: '广州美食' }],
          wrapped: [{ id: NOTE_B, note_card: { display_title: '第二篇', user: { user_id: PROFILE } } }],
        },
      }),
    ], PROFILE)
    assert.deepEqual(reading.rows.map((row) => row.noteId), [NOTE_A, NOTE_B])
  })

  it('reports sign-in, risk and verification answers', () => {
    const expired = parseXiaohongshuNoteResponses([
      response(`https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${PROFILE}`, { code: -100, success: false, msg: '登录已过期' }),
    ], PROFILE)
    assert.equal(expired.risk?.kind, 'auth')

    const risky = parseXiaohongshuNoteResponses([
      response(`https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${PROFILE}`, { code: 300012, success: false, msg: '网络连接异常' }),
    ], PROFILE)
    assert.equal(risky.risk?.kind, 'waf')

    const verification = parseXiaohongshuNoteResponses([
      response(`https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?user_id=${PROFILE}`, '{}', 461),
    ], PROFILE)
    assert.equal(verification.risk?.kind, 'anti_bot')
  })
})
