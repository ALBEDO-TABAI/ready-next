import assert from 'node:assert/strict'
import test from 'node:test'

import * as continuationStateModule from '../main/modules/agent-control/continuation-state'
import { parseContinuationControlText } from '../main/modules/agent-control/continuation-state'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'

test('continuation request sanitization rebuilds the request envelope from sanitized raw user text while preserving the bootstrap prefix in content', () => {
  const rawUserText = [
    'Task ID: task-prev',
    'Execution ID: exec-prev',
    '继续前上下文：等待确认',
    '我的回复：可以继续',
    '',
    '请继续处理这个文档，并参考当前文档上下文。',
    '',
    '### 当前文档上下文',
    '- 标题: 当前文档',
    '- 路径: /tmp/current.md',
    '--- 文档内容开始 ---',
    '这里是文档内容',
    '--- 文档内容结束 ---',
    '',
    '@[current.md]',
  ].join('\n')
  const bootstrapPrefix = [
    '## L1 会话上下文',
    '- 保留这一段格式',
    '',
    '## L2 按需规则',
    '- 优先保留结构化资源',
  ].join('\n')
  const requestEnvelope = buildRequestEnvelope({ userText: rawUserText })
  const sanitizedRawUserText = parseContinuationControlText(rawUserText).sanitizedUserText
  const expectedEnvelope = buildRequestEnvelope({ userText: sanitizedRawUserText })

  const sanitized = (continuationStateModule as any).sanitizeContinuationRequest({
    content: `${bootstrapPrefix}\n\n${rawUserText}`,
    rawUserText,
    requestEnvelope,
  })

  assert.equal(sanitized.content, `${bootstrapPrefix}\n\n${sanitizedRawUserText}`)
  assert.equal(sanitized.requestEnvelope.rawUserText, sanitizedRawUserText)
  assert.deepEqual(sanitized.requestEnvelope.resources, expectedEnvelope.resources)
  assert.deepEqual(sanitized.requestEnvelope.referencedResources, expectedEnvelope.referencedResources)
  assert.deepEqual(sanitized.requestEnvelope.environmentHints, expectedEnvelope.environmentHints)
})
