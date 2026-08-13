import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { ConversationScope, ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import {
  createCodexTaskActivityProjector,
  type CodexTaskActivityPatch,
} from '../main/modules/agent-control/codex-runtime/codex-task-activity-projector'
import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'

function projection(): TaskProjectionRecord {
  return {
    taskId: 'task-1',
    scopeId: 'scope-1',
    messageVisibilityEpoch: 3,
    runId: 'run-1',
    taskType: 'direct_answer',
    module: 'system',
    taskTitle: '正在理解需求',
    taskSummary: '正在整理任务边界、资源与可用能力',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [],
    budget: {
      taskType: 'direct_answer',
      maxIterations: 8,
      maxToolCalls: 32,
      maxParallelToolGroups: 1,
      toolCallsUsed: 0,
    },
    taskOrigin: 'user_root',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  }
}

test('Codex task activity streams safe narration alongside durable tool progress', () => {
  let row = projection()
  const patches: CodexTaskActivityPatch[] = []
  const projector = createCodexTaskActivityProjector({
    taskId: 'task-1',
    runId: 'run-1',
    messageVisibilityEpoch: 3,
    larkCliRead: true,
    now: () => '2026-08-13T00:00:01.000Z',
    store: {
      get: () => row,
    },
    publish: (patch) => {
      patches.push(patch)
      row = { ...row, ...patch, status: 'running', updatedAt: patch.timestamp }
    },
  })

  projector.observe({
    kind: 'narration',
    source: 'commentary',
    stage: 'streaming',
    atMs: 1,
    itemId: 'commentary-1',
    text: '我先定位文档，再统计 7 月数据。',
  })
  assert.equal(row.taskSummary, '我先定位文档，再统计 7 月数据。')
  assert.deepEqual(patches.at(-1)?.activityNarration, {
    itemId: 'commentary-1',
    source: 'commentary',
    text: '我先定位文档，再统计 7 月数据。',
    status: 'streaming',
  })

  const toolItem = {
    type: 'dynamicToolCall' as const,
    id: 'call-1',
    tool: 'skill_run_shell',
    namespace: null,
    arguments: { command: 'lark-cli doc search --token super-secret' },
    status: 'inProgress' as const,
    success: null,
  }
  projector.observe({ kind: 'item', stage: 'started', atMs: 2, item: toolItem })
  projector.observe({ kind: 'item', stage: 'started', atMs: 2, item: toolItem })

  assert.equal(row.taskTitle, '正在通过飞书查询')
  assert.equal(row.taskSummary, '正在读取并整理飞书信息')
  assert.equal(row.steps.length, 0, 'tool calls stay activity items instead of becoming fake plan steps')
  assert.equal(patches.filter((patch) => patch.toolEvent?.kind === 'call').length, 1)
  assert.equal(patches.at(-1)?.toolEvent?.toolName, 'skill_run_shell')
  assert.doesNotMatch(JSON.stringify(patches), /lark-cli|super-secret|--token/)

  projector.observe({
    kind: 'narration',
    source: 'reasoning_summary',
    stage: 'streaming',
    atMs: 2,
    itemId: 'reasoning-1',
    text: '正在核对统计口径。',
  })
  assert.equal(patches.at(-1)?.phase, 'tool_running')
  assert.equal(patches.at(-1)?.activityNarration?.text, '正在核对统计口径。')

  projector.observe({
    kind: 'item',
    stage: 'completed',
    atMs: 3,
    item: { ...toolItem, status: 'completed', success: true },
  })
  assert.equal(row.steps.length, 0)
  assert.equal(row.taskTitle, '正在整理查询结果')
  assert.equal(row.taskSummary, '飞书查询已完成，正在整理结果')
  assert.equal(patches.at(-1)?.toolEvent?.kind, 'result')
})

test('Codex task activity ignores final answers, stale runs, and unsafe raw-command commentary', () => {
  let row = projection()
  const projector = createCodexTaskActivityProjector({
    taskId: 'task-1',
    runId: 'run-1',
    messageVisibilityEpoch: 3,
    larkCliRead: true,
    now: () => '2026-08-13T00:00:01.000Z',
    store: {
      get: () => row,
    },
    publish: (patch) => { row = { ...row, ...patch, status: 'running', updatedAt: patch.timestamp } },
  })

  projector.observe({
    kind: 'narration',
    source: 'commentary',
    stage: 'streaming',
    atMs: 1,
    itemId: 'commentary-1',
    text: 'lark-cli doc search --token super-secret',
  })
  assert.equal(row.taskSummary, '正在通过飞书查询并整理信息')
  projector.observe({
    kind: 'item',
    stage: 'completed',
    atMs: 2,
    item: { type: 'agentMessage', id: 'final-1', text: '不应提前展示', phase: 'final_answer' },
  })
  assert.doesNotMatch(String(row.taskSummary), /不应提前展示/)

  row = { ...row, runId: 'run-2' }
  projector.observe({
    kind: 'item',
    stage: 'started',
    atMs: 3,
    item: {
      type: 'dynamicToolCall', id: 'call-stale', tool: 'skill_run_shell', namespace: null,
      arguments: {}, status: 'inProgress', success: null,
    },
  })
  assert.equal(row.steps.length, 0)
})

test('Codex task activity stays in the single run projection and survives terminal closeout', () => {
  const now = '2026-08-13T00:00:00.000Z'
  const scope: ConversationScope = {
    id: 'scope-1',
    aliasGeneration: 1,
    messageVisibilityEpoch: 3,
    agent: 'ready',
    activeAgentId: 'ready',
    handoffGeneration: 0,
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-1',
    meta: {},
    createdAt: now,
    updatedAt: now,
  }
  let summary: ScopeRunSummary | undefined
  const runProjection = new RunProjection({
    getScope: () => scope,
    getPrevious: () => summary,
    setSummary: (_scopeId, value) => { summary = value },
    toChannelKey: () => 'local:scope-1',
  })
  const base = {
    scopeId: 'scope-1',
    aliasGeneration: 1,
    messageVisibilityEpoch: 3,
    visibilityOwnerKind: 'product_alias' as const,
    agent: 'ready',
    ownerAgentId: 'ready',
    taskOrigin: 'user_root' as const,
    handoffGeneration: 0,
    runId: 'run-1',
    taskId: 'task-1',
    taskProjectionId: 'task-1',
    taskType: 'direct_answer' as const,
    module: 'system' as const,
  }
  runProjection.recordEvent({
    ...base,
    type: 'started',
    phase: 'planning',
    taskTitle: '正在理解需求',
    taskSummary: '正在整理任务边界、资源与可用能力',
    timestamp: now,
  })
  const row = projection()
  const projector = createCodexTaskActivityProjector({
    taskId: 'task-1',
    runId: 'run-1',
    messageVisibilityEpoch: 3,
    larkCliRead: true,
    store: { get: () => row },
    publish: (patch) => {
      runProjection.recordEvent({
        ...base,
        ...patch,
        type: 'updated',
      } as ScopeRunEventPayload)
    },
  })
  projector.observe({
    kind: 'item',
    stage: 'started',
    atMs: 2,
    item: {
      type: 'dynamicToolCall', id: 'call-1', tool: 'skill_run_shell', namespace: null,
      arguments: {}, status: 'inProgress', success: null,
    },
  })
  assert.equal(summary?.steps.length, 0)
  assert.equal(summary?.taskTitle, '正在通过飞书查询')

  runProjection.recordEvent({
    ...base,
    type: 'updated',
    phase: 'done',
    terminalReason: 'done',
    timestamp: '2026-08-13T00:00:03.000Z',
  })
  assert.equal(summary?.phase, 'done')
  assert.equal(summary?.taskTitle, '正在通过飞书查询')
  assert.equal(summary?.steps.length, 0)
})
