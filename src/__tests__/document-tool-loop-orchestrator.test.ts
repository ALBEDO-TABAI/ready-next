import assert from 'node:assert/strict'
import test from 'node:test'

import { DocumentToolLoopOrchestrator } from '../main/modules/agent-control/document-tool-loop-orchestrator'

test('DocumentToolLoopOrchestrator nudges when document inspection result should be surfaced', () => {
  const orchestrator = new DocumentToolLoopOrchestrator()
  const state = orchestrator.createState({
    lastDocumentInspectionResult: 'widget list',
    documentToolTaskCompleted: true,
  })

  const result = orchestrator.handleNoToolCall({
    state,
    forceDocumentTool: true,
    responseText: '我刚才调用了 document_list_widgets，任务已完成。',
    toolTransport: 'native',
  })

  assert.match(result.nextUserMessage || '', /请直接把工具返回的列表结果交付给用户/)
  assert.equal(result.state.forceDocInspectionResultNudges, 1)
})

test('DocumentToolLoopOrchestrator produces completion text after mutation and save', () => {
  const orchestrator = new DocumentToolLoopOrchestrator()
  const state = orchestrator.createState()

  const result = orchestrator.handleIterationResult({
    state,
    forceDocumentTool: true,
    documentWidgetTaskKind: null,
    executedDocActionCount: 1,
    executedMutatingDocActionCount: 1,
    executedInspectionDocActionCount: 0,
    executedSaveDocActionCount: 1,
    documentToolResultsThisIteration: ['已完成改写并保存'],
  })

  assert.equal(result.state.documentToolTaskCompleted, true)
  assert.equal(result.completionText, '已完成改写并保存')
})

test('DocumentToolLoopOrchestrator builds structured task payloads for blocked and completed states', () => {
  const orchestrator = new DocumentToolLoopOrchestrator()
  const blockedPayload = orchestrator.buildStructuredTaskPayload({
    taskTitle: '文档改写',
    taskSummary: '还没有执行真实文档修改',
    state: orchestrator.createState(),
    phase: 'blocked',
  })
  const donePayload = orchestrator.buildStructuredTaskPayload({
    taskTitle: '文档改写',
    taskSummary: '已完成章节改写',
    state: orchestrator.createState({
      documentToolTaskCompleted: true,
    }),
    phase: 'done',
  })

  assert.equal(blockedPayload.module, 'document')
  assert.equal(blockedPayload.waitingFor, 'none')
  assert.equal(blockedPayload.steps[0]?.status, 'blocked')
  assert.equal(donePayload.steps[0]?.status, 'done')
})

test('DocumentToolLoopOrchestrator exposes tool-call headroom hints without owning counters', () => {
  const orchestrator = new DocumentToolLoopOrchestrator()

  const hint = orchestrator.getBudgetHint({
    forceDocumentTool: true,
    state: orchestrator.createState(),
  })

  assert.deepEqual(hint, { reserveToolCalls: 2 })
})
