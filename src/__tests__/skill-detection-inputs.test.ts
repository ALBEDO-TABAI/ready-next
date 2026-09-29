import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isRetryOnlyTurn
} from '../main/modules/agent-control/skills/skill-detection-inputs'

test('isRetryOnlyTurn — strict short forms (historical contract)', () => {
  // These shapes were already supported and must keep working.
  assert.equal(isRetryOnlyTurn('继续'), true)
  assert.equal(isRetryOnlyTurn('继续上次'), true)
  assert.equal(isRetryOnlyTurn('继续任务'), true)
  assert.equal(isRetryOnlyTurn('再试一次'), true)
  assert.equal(isRetryOnlyTurn('你再试一次'), true)
  assert.equal(isRetryOnlyTurn('重新开始'), true)
  assert.equal(isRetryOnlyTurn('接着做'), true)
  assert.equal(isRetryOnlyTurn('恢复上次'), true)
  assert.equal(isRetryOnlyTurn('retry'), true)
  assert.equal(isRetryOnlyTurn('Continue'), true)
  assert.equal(isRetryOnlyTurn('resume'), true)
})

test('isRetryOnlyTurn — G1 liberal extension catches natural Chinese phrasings', () => {
  // Cases the original strict regex missed, all observed in real usage.
  assert.equal(isRetryOnlyTurn('继续之前任务'), true, 'continuation + 之前 + 任务')
  assert.equal(isRetryOnlyTurn('继续上次的任务'), true, '上次的任务 trailing')
  assert.equal(isRetryOnlyTurn('继续上次的视频分析'), true, 'task topic trailing')
  assert.equal(isRetryOnlyTurn('继续未完成的任务'), true, '未完成 modifier')
  assert.equal(isRetryOnlyTurn('接着上次做'), true, '接着上次做 form')
  assert.equal(isRetryOnlyTurn('继续完成视频分析'), true, '继续完成 + topic')
})

test('isRetryOnlyTurn — rejects fresh-task signals even when they start with a continuation root', () => {
  // Signals that look like new requests must NOT be classified as retry-only,
  // otherwise we'd auto-attach recall + arm hint for fresh asks.
  assert.equal(isRetryOnlyTurn('继续帮我处理新的'), false, '帮我 → fresh request')
  assert.equal(isRetryOnlyTurn('继续吗?'), false, 'question mark')
  assert.equal(isRetryOnlyTurn('继续，我想换个方向'), false, '我想 → new direction')
  assert.equal(isRetryOnlyTurn('帮我继续'), false, 'doesn\'t start with continuation root')
  assert.equal(isRetryOnlyTurn('怎么继续呢'), false, 'starts with 怎么')
  assert.equal(isRetryOnlyTurn('我要继续做这个'), false, 'starts with 我要')
})

test('isRetryOnlyTurn — length and prefix guards', () => {
  // 32-char hard cap (strict path inherits, liberal path tightens to 24)
  assert.equal(isRetryOnlyTurn('a'.repeat(33)), false)
  // No continuation root → not retry-only even when short
  assert.equal(isRetryOnlyTurn('帮忙'), false)
  assert.equal(isRetryOnlyTurn(''), false)
  assert.equal(isRetryOnlyTurn('   '), false)
})
