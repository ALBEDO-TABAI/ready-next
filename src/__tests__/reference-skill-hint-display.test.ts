import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldDisplayReferenceSkillHintForLatestUserText } from '../main/modules/agent-control/reference-skill-hint-display'

test('reference skill hint badge is hidden for unrelated latest user turns', () => {
  assert.equal(
    shouldDisplayReferenceSkillHintForLatestUserText({
      latestUserText: '广州未来两天天气怎么样',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer (VNext)',
    }),
    false,
  )
})

test('reference skill hint badge remains visible for explicit skill and continuation turns', () => {
  assert.equal(
    shouldDisplayReferenceSkillHintForLatestUserText({
      latestUserText: '使用 Video Expert Analyzer 分析这个视频',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer (VNext)',
    }),
    true,
  )
  assert.equal(
    shouldDisplayReferenceSkillHintForLatestUserText({
      latestUserText: '继续',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer (VNext)',
    }),
    true,
  )
  assert.equal(
    shouldDisplayReferenceSkillHintForLatestUserText({
      latestUserText: '看看当前任务进度',
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer (VNext)',
    }),
    true,
  )
})
