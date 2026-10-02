import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRequestEnvelope, envelopeHasLocalDocumentResource } from '../main/modules/agent-control/contracts/request-envelope'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'

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

test('request envelope carries validated file-manager workspace roots', () => {
  const envelope = buildRequestEnvelope({
    userText: '整理当前文件管理器里的文件',
    workspaceRoots: [
      '/tmp/ready/workspace/lib-a',
      '/tmp/ready/workspace/lib-a',
      '/tmp',
      '',
    ],
  })

  assert.deepEqual(envelope.environmentHints.workspaceRoots, ['/tmp/ready/workspace/lib-a'])
})

test('request envelope records calendar event references as structured resources', () => {
  const envelope = buildRequestEnvelope({
    userText: [
      '帮我看看这个日程前后要准备什么',
      '',
      '### 日程事件引用',
      '- 标题: 周会',
      '- eventId: event-1',
      '- 时间: 2026-05-18T09:00:00.000Z - 2026-05-18T10:00:00.000Z',
      '- 日历: work',
      '- 备注: 同步 Ready 输入框引用能力。',
    ].join('\n'),
  })

  const calendarResource = envelope.resources.find((resource) => resource.kind === 'calendar_event')
  assert.ok(calendarResource)
  assert.equal(calendarResource.name, '周会')
  assert.equal(calendarResource.path, 'calendar-event://event-1')
  assert.equal(calendarResource.source, 'calendar_context')
  assert.equal(calendarResource.canRead, true)
  assert.equal(calendarResource.canWrite, false)
  assert.equal(envelope.primaryInstruction, '帮我看看这个日程前后要准备什么')
  assert.ok(envelope.chunks.some((chunk) => chunk.source === 'ui_resource_ref'))
})

test('request envelope carries an unresolved @[skill] mention as a skill_reference resource (P1-1)', () => {
  const envelope = buildRequestEnvelope({
    userText: [
      '用@[ready-human-touch-ppt]根据@[analysis.md]生成一个人文感风格 ppt',
      '',
      '--- 附件: analysis.md ---',
      '- 路径: /tmp/analysis.md',
    ].join('\n'),
  })
  const skillRefs = envelope.resources.filter((r) => r.kind === 'skill_reference')
  assert.equal(skillRefs.length, 1)
  assert.equal(skillRefs[0].name, 'ready-human-touch-ppt')
  assert.equal(skillRefs[0].source, 'explicit_reference')
  assert.equal(skillRefs[0].canRead, false)
  assert.equal(skillRefs[0].canWrite, false)
  const mdResource = envelope.resources.find((r) => r.name === 'analysis.md')
  assert.ok(mdResource)
  assert.equal(mdResource?.kind, 'attachment')
})

test('request envelope produces no skill_reference when there is no @[mention] (P1-1)', () => {
  const envelope = buildRequestEnvelope({ userText: '帮我在文档里生成一张信息卡' })
  assert.equal(envelope.resources.filter((r) => r.kind === 'skill_reference').length, 0)
})

test('request envelope does not double-count a resolved attachment mention as skill_reference (P1-1)', () => {
  const envelope = buildRequestEnvelope({
    userText: [
      '根据@[普通文件.md]整理要点',
      '',
      '--- 附件: 普通文件.md ---',
      '- 路径: /tmp/普通文件.md',
    ].join('\n'),
  })
  assert.equal(envelope.resources.filter((r) => r.kind === 'skill_reference').length, 0)
})

test('request envelope does not turn a stale @[skill] mention in assembled context into a skill_reference (P1-1 staleness)', () => {
  const envelope = buildRequestEnvelope({
    userText: [
      '## L1 会话上下文',
      '### 旧任务',
      '上一轮用户曾说 用@[ready-human-touch-ppt]生成 ppt',
      '',
      '帮我讲讲今天的天气怎么描述比较好',
    ].join('\n'),
  })
  assert.equal(envelope.resources.filter((r) => r.kind === 'skill_reference').length, 0)
})

test('trusted Codex widget targets keep the 0.8 live-info routing for a widget refresh request', () => {
  const userText = '把这张卡更新成今天上海的实时天气'
  const widgetTarget = {
    id: 'widget-1', kind: 'widget_target' as const, source: 'explicit_reference' as const, name: '天气卡', path: null,
    text: '', summary: '天气卡', order: 0, canRead: true, canWrite: true,
  }
  const plain = buildRequestEnvelope({ userText })
  const withTarget = buildRequestEnvelope({ userText, trustedResources: [widgetTarget] })
  // Hints come from assembled context markers only; a structured target must not flip the request to document-only work.
  assert.deepEqual(withTarget.environmentHints, plain.environmentHints)
  assert.deepEqual(classifyIntent(withTarget).excludedDomains, classifyIntent(plain).excludedDomains)
  assert.equal(classifyIntent(withTarget).primaryDomain, classifyIntent(plain).primaryDomain)
})

test('an RSS reference label is data: a title that looks like a file never becomes a document or skill resource', () => {
  const envelope = buildRequestEnvelope({
    userText: '总结 @[article.md] 的要点',
    trustedResources: [{
      id: '6f1c2c0e-3d3a-4a51-9a51-2a8b9b3f4e10', kind: 'rss_reference', source: 'rss_context', name: 'article.md', path: 'rss-reference://fixture',
      text: '', summary: null, order: 0, canRead: true, canWrite: false,
      rssReference: { kind: 'article', read: { itemId: 'a', expectedRevision: 'r', offset: 0, length: 12000 } },
    }],
  })
  assert.equal(envelope.primaryInstruction.includes('article.md'), false)
  assert.deepEqual(envelope.resources.map((resource) => resource.kind), ['rss_reference'])
  assert.equal(envelopeHasLocalDocumentResource(envelope), false)
})
