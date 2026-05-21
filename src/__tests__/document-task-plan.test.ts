import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDocumentTaskPlan } from '../main/modules/agent-control/document-task-plan'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'

function buildEnvelope(userInstruction: string): ReturnType<typeof buildRequestEnvelope> {
  return buildRequestEnvelope({
    userText: [
      userInstruction,
      '',
      '## 环境信息',
      '- 当前模式: 文档模式',
      '',
      '### 当前文档上下文',
      '- 标题: 新文档.md',
      '- 路径: /tmp/新文档.md',
      '- 类型: md',
      '- 字符数: 200',
      '',
      '--- 文档摘要开始 ---',
      '这里是目标文档摘要',
      '--- 文档摘要结束 ---',
      '',
      '--- 附件: storyboard.pdf ---',
      '- 路径: /tmp/storyboard.pdf',
      '这里是 storyboard 正文',
      '',
      '--- 附件: A.md ---',
      '- 路径: /tmp/A.md',
      '这里是 A 正文',
      '',
      '--- 附件: B.md ---',
      '- 路径: /tmp/B.md',
      '这里是 B 正文',
      '',
      '--- 附件: C.pdf ---',
      '- 路径: /tmp/C.pdf',
      '这里是 C 正文',
      '',
      '--- 附件: D.md ---',
      '- 路径: /tmp/D.md',
      '这里是 D 正文',
    ].join('\n'),
  })
}

test('document task plan binds explicit source and target resources for a card request', () => {
  const envelope = buildEnvelope('请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡')
  const plan = buildDocumentTaskPlan({
    requestEnvelope: envelope,
    userInstructionText: envelope.primaryInstruction,
  })

  assert.equal(plan.jobs.length, 1)
  assert.equal(plan.requiresStructuredPlan, true)
  assert.equal(
    plan.jobs[0].bindings.find((binding) => binding.role === 'primary_source')?.resource.name,
    'storyboard.pdf',
  )
  assert.equal(
    plan.jobs[0].bindings.find((binding) => binding.role === 'target_document')?.resource.name,
    '新文档.md',
  )
})

test('document task plan splits two source-to-target instructions into separate jobs', () => {
  const envelope = buildEnvelope('根据@[A.md]在@[B.md]做信息卡，然后根据@[C.pdf]在@[D.md]做信息卡')
  const plan = buildDocumentTaskPlan({
    requestEnvelope: envelope,
    userInstructionText: envelope.primaryInstruction,
  })

  assert.equal(plan.jobs.length, 2)
  assert.equal(plan.jobs[0].bindings.find((binding) => binding.role === 'primary_source')?.resource.name, 'A.md')
  assert.equal(plan.jobs[0].bindings.find((binding) => binding.role === 'target_document')?.resource.name, 'B.md')
  assert.equal(plan.jobs[1].bindings.find((binding) => binding.role === 'primary_source')?.resource.name, 'C.pdf')
  assert.equal(plan.jobs[1].bindings.find((binding) => binding.role === 'target_document')?.resource.name, 'D.md')
})

test('document task plan blocks ambiguous multi-target requests before writeback', () => {
  const envelope = buildEnvelope('根据@[storyboard.pdf]分别写到@[B.md]和@[D.md]里')
  const plan = buildDocumentTaskPlan({
    requestEnvelope: envelope,
    userInstructionText: envelope.primaryInstruction,
  })

  assert.equal(plan.jobs.length, 0)
  assert.match(plan.blockedReason || '', /无法明确/)
})
