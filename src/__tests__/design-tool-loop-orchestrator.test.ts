import assert from 'node:assert/strict'
import test from 'node:test'

import { DesignToolLoopOrchestrator } from '../main/modules/agent-control/design-tool-loop-orchestrator'

test('DesignToolLoopOrchestrator filters repeated primary artifact calls after one artifact exists', () => {
  const orchestrator = new DesignToolLoopOrchestrator()
  const result = orchestrator.filterToolCalls({
    toolCalls: [
      { id: '1', name: 'design_create_frame', input: {} },
      { id: '2', name: 'design_verify_layout', input: {} },
    ],
    policy: {
      forceDesignTool: true,
      preferredDesignTool: 'design_create_frame',
      allowMultipleDesignArtifacts: false,
      primaryDesignInstruction: null,
    },
    primaryArtifactProduced: true,
  })

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0]?.name, 'design_verify_layout')
})

test('DesignToolLoopOrchestrator builds completion text from primary artifact result', () => {
  const orchestrator = new DesignToolLoopOrchestrator()
  const result = orchestrator.recordToolResult({
    state: orchestrator.createState(),
    toolName: 'design_create_frame',
    rawResult: JSON.stringify({ status: 'completed', summary: '主版式已生成' }),
    policy: {
      forceDesignTool: true,
      preferredDesignTool: 'design_create_frame',
      allowMultipleDesignArtifacts: false,
      primaryDesignInstruction: null,
    },
  })

  assert.equal(result.state.primaryArtifactProduced, true)
  assert.equal(orchestrator.buildCompletionText(result.state), '主版式已生成')
})

test('DesignToolLoopOrchestrator builds structured task payloads for blocked and completed states', () => {
  const orchestrator = new DesignToolLoopOrchestrator()
  const blockedPayload = orchestrator.buildStructuredTaskPayload({
    taskTitle: '设计任务',
    taskSummary: '不要再次新建额外版面',
    state: orchestrator.createState(),
    phase: 'blocked',
  })
  const donePayload = orchestrator.buildStructuredTaskPayload({
    taskTitle: '设计任务',
    taskSummary: '主版式已生成',
    state: orchestrator.createState({
      primaryArtifactProduced: true,
    }),
    phase: 'done',
  })

  assert.equal(blockedPayload.module, 'design')
  assert.equal(blockedPayload.steps[0]?.status, 'blocked')
  assert.equal(donePayload.steps[0]?.status, 'done')
})

test('DesignToolLoopOrchestrator exposes review headroom hints without owning counters', () => {
  const orchestrator = new DesignToolLoopOrchestrator()

  const hint = orchestrator.getBudgetHint({
    forceDesignTool: true,
    primaryArtifactProduced: true,
  })

  assert.deepEqual(hint, { reserveToolCalls: 1 })
})
