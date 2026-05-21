import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildDocumentTaskStepCacheKey } from '../main/modules/agent-control/document-pipeline/document-task-cache-key'
import { buildDocumentTaskPlan } from '../main/modules/agent-control/document-pipeline/document-task-plan'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'

function buildPlan(rawUserText: string) {
  const requestEnvelope = buildRequestEnvelope({ userText: rawUserText })
  return buildDocumentTaskPlan({
    requestEnvelope,
    userInstructionText: requestEnvelope.primaryInstruction,
  })
}

describe('document task cache key', () => {
  it('changes when the source material changes', () => {
    const rawA = [
      '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      '',
      '### 当前文档上下文',
      '- 标题: 新文档.md',
      '- 路径: /tmp/新文档.md',
      '',
      '--- 文档摘要开始 ---',
      '这里是目标文档摘要',
      '--- 文档摘要结束 ---',
      '',
      '--- 附件: storyboard.pdf ---',
      '- 路径: /tmp/storyboard.pdf',
      '第一版 storyboard 正文',
    ].join('\n')
    const rawB = rawA.replace('第一版 storyboard 正文', '第二版 storyboard 正文')
    const planA = buildPlan(rawA)
    const planB = buildPlan(rawB)

    const keyA = buildDocumentTaskStepCacheKey({
      question: '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      step: 'build_insight',
      job: planA.jobs[0],
    })
    const keyB = buildDocumentTaskStepCacheKey({
      question: '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      step: 'build_insight',
      job: planB.jobs[0],
    })

    assert.notEqual(keyA, keyB)
  })

  it('changes when only the target document text changes', () => {
    // Historically the key hard-coded 'target' for the target_document binding,
    // so two rounds against the same target would collide even after the user
    // mutated it. The arbitration work in 2026-04-19 replaced that with a real
    // content hash — widget re-writes must now cache-bust between rounds.
    const rawA = [
      '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      '',
      '### 当前文档上下文',
      '- 标题: 新文档.md',
      '- 路径: /tmp/新文档.md',
      '',
      '--- 文档摘要开始 ---',
      '这里是目标文档摘要 A',
      '--- 文档摘要结束 ---',
      '',
      '--- 附件: storyboard.pdf ---',
      '- 路径: /tmp/storyboard.pdf',
      '固定 storyboard 正文',
    ].join('\n')
    const rawB = rawA.replace('这里是目标文档摘要 A', '这里是目标文档摘要 B')
    const planA = buildPlan(rawA)
    const planB = buildPlan(rawB)

    const keyA = buildDocumentTaskStepCacheKey({
      question: '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      step: 'build_insight',
      job: planA.jobs[0],
    })
    const keyB = buildDocumentTaskStepCacheKey({
      question: '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      step: 'build_insight',
      job: planB.jobs[0],
    })

    assert.notEqual(keyA, keyB)
  })

  it('uses targetSnapshot.content to cache-bust when the live doc drifts from the binding text', () => {
    const raw = [
      '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      '',
      '### 当前文档上下文',
      '- 标题: 新文档.md',
      '- 路径: /tmp/新文档.md',
      '',
      '--- 文档摘要开始 ---',
      '这里是目标文档摘要 A',
      '--- 文档摘要结束 ---',
      '',
      '--- 附件: storyboard.pdf ---',
      '- 路径: /tmp/storyboard.pdf',
      '固定 storyboard 正文',
    ].join('\n')
    const plan = buildPlan(raw)

    const keyFirstRound = buildDocumentTaskStepCacheKey({
      question: '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      step: 'build_insight',
      job: plan.jobs[0],
      targetSnapshot: {
        title: '新文档.md',
        path: '/tmp/新文档.md',
        tabId: 'tab-1',
        content: '这里是目标文档摘要 A',
      },
    })
    const keySecondRound = buildDocumentTaskStepCacheKey({
      question: '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
      step: 'build_insight',
      job: plan.jobs[0],
      targetSnapshot: {
        title: '新文档.md',
        path: '/tmp/新文档.md',
        tabId: 'tab-1',
        content: '这里是目标文档摘要 B（用户刚改过）',
      },
    })
    assert.notEqual(keyFirstRound, keySecondRound)
  })
})
