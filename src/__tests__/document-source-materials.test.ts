import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildDocumentTaskPlan } from '../main/modules/agent-control/document-task-plan'
import { buildRequestEnvelope, type RequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { buildDocumentInsightSourceMaterial } from '../main/modules/agent-control/document-source-materials'

function createEnvelope(chunks: RequestEnvelope['chunks']): RequestEnvelope {
  return {
    rawUserText: '',
    pureUserText: '',
    primaryInstruction: '',
    chunks,
    resources: [],
    referencedResources: [],
    environmentHints: {
      hasDocumentContext: false,
      hasWidgetTargetContext: false,
      hasAttachments: chunks.some((chunk) => chunk.source === 'attachment_body'),
      hasBootstrapContext: false,
    },
    provenanceSummary: {
      countsBySource: {
        user_message: chunks.filter((chunk) => chunk.source === 'user_message').length,
        ui_resource_ref: chunks.filter((chunk) => chunk.source === 'ui_resource_ref').length,
        environment_hint: chunks.filter((chunk) => chunk.source === 'environment_hint').length,
        session_recall: chunks.filter((chunk) => chunk.source === 'session_recall').length,
        attachment_body: chunks.filter((chunk) => chunk.source === 'attachment_body').length,
        document_excerpt: chunks.filter((chunk) => chunk.source === 'document_excerpt').length,
        tool_echo: 0,
        system_generated: 0,
      },
      userControllableSourcesOnly: true,
    },
  }
}

describe('document insight source materials', () => {
  it('prefers attachment body chunks over the target document snapshot', () => {
    const envelope = createEnvelope([
      {
        source: 'attachment_body',
        participatesInFirstPassIntent: false,
        text: ['--- 引用文件: storyboard.pdf ---', '- 路径: /tmp/storyboard.pdf', '这里是附件正文'].join('\n'),
      },
    ])

    const result = buildDocumentInsightSourceMaterial({
      requestEnvelope: envelope,
      snapshotContent: '这是目标文档正文',
    })

    assert.equal(result.kind, 'attachment_body')
    assert.match(result.text, /这里是附件正文/)
    assert.doesNotMatch(result.text, /目标文档正文/)
  })

  it('falls back to the current document snapshot when no attachment body exists', () => {
    const envelope = createEnvelope([])

    const result = buildDocumentInsightSourceMaterial({
      requestEnvelope: envelope,
      snapshotContent: '这是当前文档正文',
    })

    assert.equal(result.kind, 'snapshot')
    assert.equal(result.text, '这是当前文档正文')
  })

  it('uses planned source bindings instead of the writable target document', () => {
    const envelope = {
      ...createEnvelope([]),
      rawUserText: [
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
      ].join('\n'),
    } as RequestEnvelope

    const normalizedEnvelope = {
      ...envelope,
      ...buildRequestEnvelope({
        userText: envelope.rawUserText,
      }),
    } as RequestEnvelope
    const plan = buildDocumentTaskPlan({
      requestEnvelope: normalizedEnvelope,
      userInstructionText: normalizedEnvelope.primaryInstruction,
    })

    const result = buildDocumentInsightSourceMaterial({
      requestEnvelope: normalizedEnvelope,
      snapshotContent: '这是目标文档正文',
      job: plan.jobs[0],
    })

    assert.equal(result.kind, 'task_plan')
    assert.match(result.text, /storyboard 正文/)
    assert.doesNotMatch(result.text, /新文档正文/)
    assert.equal(result.sourceDocumentTitle, 'storyboard.pdf')
  })
})
