import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canAttemptVisualAnalysis,
  classifyBrowserTabResource,
  extractXiaohongshuNoteId,
  hasLikelyVideoResource,
} from '../shared/browser-tab-resource-classifier'

test('browser tab resource classifier recognizes Xiaohongshu note URLs with token-bearing query', () => {
  const url = 'https://www.xiaohongshu.com/explore/665f5a23000000001e03a123?xsec_token=abc&xsec_source=pc_user'
  const result = classifyBrowserTabResource(url)

  assert.equal(result.kind, 'xiaohongshu_note')
  assert.equal(result.stableId, '665f5a23000000001e03a123')
  assert.equal(result.canAttemptVisualAnalysis, true)
  assert.equal(result.hasLikelyVideo, false)
  assert.equal(canAttemptVisualAnalysis(url), true)
  assert.equal(extractXiaohongshuNoteId(url), '665f5a23000000001e03a123')
})

test('browser tab resource classifier recognizes Xiaohongshu account-page note URLs', () => {
  const url = 'https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f/6928017e000000001e0334f4?xsec_token=abc&xsec_source=pc_user'
  const result = classifyBrowserTabResource(url)

  assert.equal(result.kind, 'xiaohongshu_note')
  assert.equal(result.stableId, '6928017e000000001e0334f4')
  assert.equal(result.canAttemptVisualAnalysis, true)
  assert.equal(extractXiaohongshuNoteId(url), '6928017e000000001e0334f4')
})

test('browser tab resource classifier keeps Xiaohongshu account pages out of visual analysis', () => {
  const result = classifyBrowserTabResource('https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06')

  assert.equal(result.kind, 'xiaohongshu_account')
  assert.equal(result.canAttemptVisualAnalysis, false)
  assert.equal(result.supportedActions.includes('browser_collection'), true)
})

test('browser tab resource classifier keeps direct and known video pages as likely video resources', () => {
  assert.equal(hasLikelyVideoResource('https://www.bilibili.com/video/BV1h9Ln6DEJE/'), true)
  assert.equal(hasLikelyVideoResource('https://cdn.example.com/foo.mp4'), true)
  assert.equal(canAttemptVisualAnalysis('https://cdn.example.com/foo.mp4'), true)
  assert.equal(canAttemptVisualAnalysis('https://example.com/article'), false)
})
