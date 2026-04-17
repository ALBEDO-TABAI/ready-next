import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'

test('request envelope keeps only the pure user instruction for first-pass intent and records provenance', () => {
  const envelope = buildRequestEnvelope({
    userText: [
      '## L1 会话上下文',
      '### 旧任务',
      '这里是系统注入的历史摘要',
      '',
      '在文档里生成一张分析型信息卡',
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
      '正文里提到了 RSS、飞书和日程，但这些只是文档内容。',
      '--- 文档摘要结束 ---',
      '',
      '--- 引用文件: notes.md ---',
      '- 路径: /tmp/notes.md',
      '这里是附件正文 openclaw pairing approve feishu FNXQH9PN',
    ].join('\n'),
  })

  assert.equal(envelope.pureUserText, '在文档里生成一张分析型信息卡')
  assert.equal(envelope.primaryInstruction, '在文档里生成一张分析型信息卡')
  assert.equal(envelope.environmentHints.hasDocumentContext, true)
  assert.equal(envelope.environmentHints.hasAttachments, true)
  assert.ok(envelope.chunks.some((chunk) => chunk.source === 'document_excerpt'))
  assert.ok(envelope.chunks.some((chunk) => chunk.source === 'attachment_body'))
  assert.ok(envelope.chunks.some((chunk) => chunk.source === 'system_generated'))
  assert.equal(envelope.provenanceSummary.userControllableSourcesOnly, false)
})

test('request envelope keeps repeated attachments and references as distinct resources', () => {
  const envelope = buildRequestEnvelope({
    userText: [
      '请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡',
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
      '--- 附件: 新文档.md ---',
      '- 路径: /tmp/新文档.md',
      '这里是新文档正文',
      '',
      '--- 引用文件: storyboard.pdf ---',
      '- 路径: /tmp/storyboard.pdf',
      '这里是 storyboard 引用块',
      '',
      '--- 引用文件: 新文档.md ---',
      '- 路径: /tmp/新文档.md',
      '这里是新文档引用块',
    ].join('\n'),
  })

  assert.equal(envelope.resources.length, 5)
  assert.equal(
    envelope.resources.filter((resource) => resource.kind === 'attachment').length,
    4,
  )
  assert.equal(
    envelope.resources.filter((resource) => resource.kind === 'document_context').length,
    1,
  )
  assert.ok(
    envelope.resources.some((resource) => resource.name === 'storyboard.pdf' && resource.source === 'user_attachment'),
  )
  assert.ok(
    envelope.resources.some((resource) => resource.name === 'storyboard.pdf' && resource.source === 'explicit_reference'),
  )
  assert.ok(
    envelope.resources.some((resource) => resource.name === '新文档.md' && resource.canWrite === true),
  )
})
