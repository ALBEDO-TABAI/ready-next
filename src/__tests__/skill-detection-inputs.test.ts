import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSkillDetectionInputs } from '../main/modules/agent-control/skill-detection-inputs'

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
