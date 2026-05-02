import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSkillDetectionInputs,
  isRetryOnlyTurn,
} from '../main/modules/agent-control/skill-detection-inputs'

test('skill detection includes recent user goals for retry-only turns', () => {
  const inputs = buildSkillDetectionInputs({
    contextualUserInput: '再重试一次',
    primaryInstruction: '再重试一次',
    pureUserText: '再重试一次',
    previousPureUserInputs: [
      '使用 Video Expert Analyzer (VNext) 分析 Inside Notion 视频，输出到测试目录',
      '更新并生成 RSS 摘要',
    ],
  })

  assert.equal(inputs[0], '再重试一次')
  assert.ok(inputs.includes('使用 Video Expert Analyzer (VNext) 分析 Inside Notion 视频，输出到测试目录'))
})

test('skill detection does not reuse stale goals for unrelated new turns', () => {
  const inputs = buildSkillDetectionInputs({
    contextualUserInput: '帮我看看今天的天气',
    primaryInstruction: '帮我看看今天的天气',
    pureUserText: '帮我看看今天的天气',
    previousPureUserInputs: [
      '使用 Video Expert Analyzer (VNext) 分析 Inside Notion 视频',
    ],
  })

  assert.deepEqual(inputs, ['帮我看看今天的天气'])
})

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

test('skill detection only reuses the recent-first history window', () => {
  const inputs = buildSkillDetectionInputs({
    contextualUserInput: '继续',
    primaryInstruction: '继续',
    pureUserText: '继续',
    previousPureUserInputs: [
      '使用 Video Expert Analyzer (VNext) 分析最新视频',
      '第 2 条',
      '第 3 条',
      '第 4 条',
      '第 5 条',
      '第 6 条',
      '很久以前使用 novel_writer_system',
    ],
  })

  assert.ok(inputs.includes('使用 Video Expert Analyzer (VNext) 分析最新视频'))
  assert.equal(inputs.includes('很久以前使用 novel_writer_system'), false)
})
