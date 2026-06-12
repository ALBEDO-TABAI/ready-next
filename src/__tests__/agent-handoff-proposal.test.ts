/**
 * EP3-A4 — handoff proposal end-to-end: 提议 → 用户采纳 → ownerAgentId
 * 写值（经 repository.update，全仓唯一写值点）→ A2 注入切换（A2 降级掉的
 * 验收在此兑现）。Plus: verbatim byte-equality through the flow, the
 * rejection path as a structured RESULT, new-session prefill, and invalid
 * proposals that never even open a card.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runHandoffProposal,
  HANDOFF_QUESTION_ID,
  HANDOFF_ADOPT_OPTION,
  HANDOFF_NEW_SESSION_OPTION,
  HANDOFF_REJECT_OPTION,
} from '../main/modules/agent-control/agents/handoff-proposal'
import { executeProposeHandoff } from '../main/modules/tools/builtins/propose-handoff'
import { AskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'

const VERBATIM = '  帮我盯小红书穿搭行情，明早九点前出对比！！\n（别忘了截图）  '

const AGENTS = new Map<string, AgentRegistryRecord>([
  ['collector', { id: 'collector', name: '采集手', charter: '负责小红书与微博采集', personaRef: null, status: 'active', createdAt: '2026-06-12' }],
  ['sleeper', { id: 'sleeper', name: '退休者', charter: '已退休', personaRef: null, status: 'retired', createdAt: '2026-06-12' }],
])

/** Drives the card like a user: when the card is emitted, click `option`. */
function cardDeps(option: string | null) {
  const store = new AskUserQuestionsStore()
  let emitted = 0
  return {
    store,
    emittedCount: () => emitted,
    deps: {
      getAgent: (id: string) => AGENTS.get(id) ?? null,
      updateTaskOwner: () => undefined,
      sessionId: 'sess-1',
      askUserStore: store,
      timeoutMs: option === null ? 60 : 10_000,
      emitCard: (event: { cardId: string }) => {
        emitted += 1
        if (option === null) return // never answer → timeout
        queueMicrotask(() => {
          store.resolve(event.cardId, {
            answers: [{ id: HANDOFF_QUESTION_ID, answer: option }],
            answeredAt: Date.now(),
          })
        })
      },
    },
  }
}

/** Fake raw db speaking exactly the repository's SQL surface. */
function fakeProjectionDb() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    raw: {
      prepare(sql: string) {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        if (normalized.startsWith('INSERT INTO task_projections')) {
          const columns = normalized.slice(normalized.indexOf('(') + 1, normalized.indexOf(')')).split(',').map((column) => column.trim())
          return {
            run: (...params: unknown[]) => {
              const row: Record<string, unknown> = {}
              columns.forEach((column, index) => { row[column] = params[index] })
              rows.set(String(row.task_id), row)
            },
            all: () => [], get: () => undefined,
          }
        }
        if (normalized.startsWith('SELECT * FROM task_projections WHERE task_id = ?')) {
          return { get: <R>(taskId: unknown) => rows.get(String(taskId)) as R | undefined, run: () => undefined, all: () => [] }
        }
        if (normalized.startsWith('SELECT owner_agent_id FROM task_projections WHERE scope_id = ?')) {
          return {
            get: <R>(scopeId: unknown) => {
              const owned = [...rows.values()]
                .filter((row) => row.scope_id === String(scopeId) && row.owner_agent_id)
                .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
              return owned[0] as R | undefined
            },
            run: () => undefined, all: () => [],
          }
        }
        if (normalized.startsWith('UPDATE task_projections SET')) {
          const setColumns = normalized.slice('UPDATE task_projections SET '.length, normalized.indexOf(' WHERE')).split(',').map((part) => part.trim().split(' ')[0])
          return {
            run: (...params: unknown[]) => {
              const row = rows.get(String(params[params.length - 1]))
              if (row) setColumns.forEach((column, index) => { row[column] = params[index] })
            },
            all: () => [], get: () => undefined,
          }
        }
        throw new Error(`unexpected SQL: ${normalized}`)
      },
    },
  }
}

test('end-to-end: 提议 → 采纳 → ownerAgentId 经 repository.update 写值 → A2 注入切换', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-a4-'))
  try {
    // the adopted agent owns a scope card that must appear AFTER adoption
    mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
    mkdirSync(join(root, 'agents', 'collector', 'knowledge'), { recursive: true })
    writeFileSync(join(root, 'agents', 'collector', 'knowledge', 'xhs.md'), [
      '---', 'title: COLLECTOR_SCOPE_CARD', 'description: 一句话', 'confidence: H',
      'tag: knowledge', 'created: 2026-06-12', 'status: active', '---', '正文',
    ].join('\n'), 'utf-8')

    const { rows, raw } = fakeProjectionDb()
    const repository = new TaskProjectionRepository({ getRawDb: () => raw as never })
    repository.create({
      taskId: 'task-1', scopeId: 'scope-1', runId: 'r1', taskType: 'multi_step_task', module: 'system',
      status: 'running', interactionState: 'running', steps: [],
      createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
    } as never, { silent: true })

    const { deps } = cardDeps(HANDOFF_ADOPT_OPTION)
    const outcome = await runHandoffProposal(
      { targetAgentId: 'collector', reason: '采集类任务更对口', userRequestVerbatim: VERBATIM, taskId: 'task-1' },
      {
        ...deps,
        // 全仓唯一写值点：经 repository.update
        updateTaskOwner: (taskId, ownerAgentId) => repository.update(taskId, { ownerAgentId } as never, { silent: true }),
      },
    )
    assert.equal(outcome.kind, 'adopted')
    assert.equal(rows.get('task-1')?.owner_agent_id, 'collector', 'ownerAgentId written through the repository')
    assert.equal(repository.getLatestOwnerAgentForScope('scope-1'), 'collector', '后续轮 owner 解析读到切换结果')

    // A2 injection switch: next turn builds with the scope's owner
    const svc = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getBeliefCardStore: () => new BeliefCardStore({ memoryRoot: root }),
    })
    const scope: ConversationScope = {
      id: 'scope-1', agent: 'butler', title: '会话', sourceKind: 'local', sourceId: 'app',
      threadKey: 'scope-1', meta: {}, createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
    }
    const before = await svc.buildForScopedRun({ scope, message: '继续', coordinators: [], ownerAgentId: null })
    const after = await svc.buildForScopedRun({
      scope, message: '继续', coordinators: [],
      ownerAgentId: repository.getLatestOwnerAgentForScope('scope-1'),
    })
    const beforeText = [before.systemPrompt, ...before.bootstrapMessages].join('\n')
    const afterText = [after.systemPrompt, ...after.bootstrapMessages].join('\n')
    assert.ok(!beforeText.includes('COLLECTOR_SCOPE_CARD'), '采纳前不含目标 agent 谱系')
    assert.ok(afterText.includes('COLLECTOR_SCOPE_CARD'), '采纳后注入切换到目标 agent 作用域（A2 通道生效）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verbatim passes byte-for-byte into the new-session prefill', async () => {
  const { deps } = cardDeps(HANDOFF_NEW_SESSION_OPTION)
  let ownerWrites = 0
  const outcome = await runHandoffProposal(
    { targetAgentId: 'collector', reason: 'r', userRequestVerbatim: VERBATIM, contextRefs: ['card:xhs'], taskId: 'task-9' },
    { ...deps, updateTaskOwner: () => { ownerWrites += 1 } },
  )
  assert.equal(outcome.kind, 'adopted_new_session')
  if (outcome.kind === 'adopted_new_session') {
    assert.equal(outcome.prefillVerbatim, VERBATIM, '原话逐字预填，一个字节不许动')
    assert.deepEqual(outcome.contextRefs, ['card:xhs'])
  }
  assert.equal(ownerWrites, 0, '新会话路径不改当前任务 owner')
})

test('rejection is a structured RESULT back to the model, not an error', async () => {
  const { deps } = cardDeps(HANDOFF_REJECT_OPTION)
  const output = await executeProposeHandoff(
    { target_agent_id: 'collector', reason: 'r', user_request_verbatim: VERBATIM },
    { ...deps, taskId: null },
  )
  const outcome = (output.data as { outcome: { kind: string } }).outcome
  assert.equal(outcome.kind, 'rejected_by_user')
  assert.ok(output.text.includes('不要再次提议'), '结构化拒绝引导模型继续当前身份')
})

test('invalid proposals never open a card: unknown / main-agent / inactive / empty verbatim / bad refs', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ targetAgentId: 'ghost', reason: 'r', userRequestVerbatim: 'x' }, /unknown agent/],
    [{ targetAgentId: 'butler', reason: 'r', userRequestVerbatim: 'x' }, /main agent/],
    [{ targetAgentId: 'sleeper', reason: 'r', userRequestVerbatim: 'x' }, /not active/],
    [{ targetAgentId: 'collector', reason: 'r', userRequestVerbatim: '' }, /禁止摘要|userRequestVerbatim/],
    [{ targetAgentId: 'collector', reason: 'r', userRequestVerbatim: 'x', contextRefs: ['转'.repeat(301)] }, /contextRefs/],
  ]
  for (const [input, pattern] of cases) {
    const { deps, emittedCount } = cardDeps(HANDOFF_ADOPT_OPTION)
    const getAgent = (id: string) =>
      id === 'butler'
        ? { id: 'butler', name: '管家', charter: '主', personaRef: null, status: 'active', createdAt: '2026-06-12' }
        : AGENTS.get(id) ?? null
    const outcome = await runHandoffProposal(input as never, { ...deps, getAgent })
    assert.equal(outcome.kind, 'invalid', JSON.stringify(input))
    if (outcome.kind === 'invalid') assert.match(outcome.reason, pattern)
    assert.equal(emittedCount(), 0, '结构化拒绝不开卡')
  }
})

test('card timeout degrades to card_failed — the proposal never half-adopts', async () => {
  const { deps } = cardDeps(null) // emitted but never answered
  let ownerWrites = 0
  const outcome = await runHandoffProposal(
    { targetAgentId: 'collector', reason: 'r', userRequestVerbatim: 'x', taskId: 'task-1' },
    { ...deps, updateTaskOwner: () => { ownerWrites += 1 } },
  )
  assert.equal(outcome.kind, 'card_failed')
  assert.equal(ownerWrites, 0)
})
