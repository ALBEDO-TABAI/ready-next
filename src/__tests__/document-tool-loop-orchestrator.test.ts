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

test('DocumentToolLoopOrchestrator sanitizes inspection result and emits telemetry on 2nd fallback', () => {
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = []
  const orchestrator = new DocumentToolLoopOrchestrator({
    logMetric: (name, payload) => {
      calls.push({ name, payload })
    },
  })
  const rawInspection = [
    '当前文档共有 2 个 widget（my-notes.md）：',
    '1. 指引 [static-html] · id=widget_abc · 可 patch',
    '2. 进度卡 [static-html] · id=widget_def · 可 patch',
    '',
    '```json',
    JSON.stringify([
      { id: 'widget_abc', index: 1, title: '指引', mode: 'static-html', componentHint: null, preview: '', hasState: false, hasComponentSpec: true, canPatch: true, canReplace: true },
      { id: 'widget_def', index: 2, title: '进度卡', mode: 'static-html', componentHint: null, preview: '', hasState: false, hasComponentSpec: true, canPatch: true, canReplace: true },
    ]),
    '```',
  ].join('\n')

  const state = orchestrator.createState({
    lastDocumentInspectionResult: rawInspection,
    forceDocInspectionResultNudges: 1, // 2nd fallback
  })

  const result = orchestrator.handleNoToolCall({
    state,
    forceDocumentTool: true,
    responseText: '我刚才调用了 document_list_widgets。',
    toolTransport: 'native',
  })

  assert.equal(result.finish, true)
  assert.ok(result.finalText, 'finalText must be present')
  const finalText = result.finalText || ''
  assert.notEqual(finalText, rawInspection, 'finalText must not be the raw tool output')
  assert.equal(finalText.includes('id=widget_'), false, 'finalText must not leak internal ids')
  assert.equal(finalText.includes('```json'), false, 'finalText must not leak json fence')
  assert.equal(finalText.includes('· 可 patch'), false, 'finalText must not leak debug markers')
  assert.match(finalText, /「my-notes\.md」/)
  assert.match(finalText, /「指引」/)

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, 'tool_resolution_violation_post_arbitration')
  const payload = calls[0]?.payload || {}
  assert.equal(payload.reason, 'inspection_result_used_as_final_text')
  assert.equal(payload.stage, 'document_tool_loop_orchestrator')
  assert.equal(payload.toolTransport, 'native')
  assert.equal(payload.forceDocInspectionResultNudges, 1)
})

test('DocumentToolLoopOrchestrator suppresses inspection fallback under text transport', () => {
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = []
  const orchestrator = new DocumentToolLoopOrchestrator({
    logMetric: (name, payload) => {
      calls.push({ name, payload })
    },
  })
  const state = orchestrator.createState({
    lastDocumentInspectionResult: '当前文档共有 1 个 widget（x.md）：\n1. A · id=widget_a',
    forceDocInspectionResultNudges: 1,
  })

  const result = orchestrator.handleNoToolCall({
    state,
    forceDocumentTool: true,
    responseText: '', // empty — would have hit fallback on native
    toolTransport: 'text',
  })

  assert.equal(result.finish, undefined)
  assert.equal(result.finalText, undefined)
  assert.equal(calls.length, 0)
})

test('DocumentToolLoopOrchestrator does not regress to "no mutation" after a save-only follow-up iteration', () => {
  const orchestrator = new DocumentToolLoopOrchestrator()
  const state = orchestrator.createState({
    documentToolProgress: {
      executedMutatingDocActionCount: 1,
      executedSaveDocActionCount: 0,
      toolResults: ['已更新 widget：basketball_scoreboard_red（新文档.md）'],
    },
    documentToolTaskCompleted: true,
  })

  const result = orchestrator.handleIterationResult({
    state,
    forceDocumentTool: true,
    documentWidgetTaskKind: null,
    executedDocActionCount: 1,
    executedMutatingDocActionCount: 0,
    executedInspectionDocActionCount: 0,
    executedSaveDocActionCount: 1,
    documentToolResultsThisIteration: ['已保存文档：/Users/user/新文档.md'],
  })

  assert.equal(result.nextUserMessage, undefined)
  assert.equal(
    result.completionText,
    '已更新 widget：basketball_scoreboard_red（新文档.md）\n已保存文档：/Users/user/新文档.md',
  )
  assert.equal(result.finish, true)
})
