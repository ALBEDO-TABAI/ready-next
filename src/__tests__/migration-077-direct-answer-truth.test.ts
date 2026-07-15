import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface TestDatabase extends MigrationDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all<T = unknown>(...params: unknown[]): T[]
    get<T = unknown>(...params: unknown[]): T | undefined
  }
  close(): void
}

async function openDatabase(): Promise<TestDatabase> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as TestDatabase
}

function createSchema(db: TestDatabase): void {
  db.exec(`
    CREATE TABLE task_projections (
      task_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      module TEXT NOT NULL,
      status TEXT NOT NULL,
      interaction_state TEXT NOT NULL,
      waiting_for TEXT,
      steps_json TEXT NOT NULL,
      budget_json TEXT,
      budget_usage_percent INTEGER,
      budget_warning_level TEXT,
      recovery_history_json TEXT,
      degradation_reason TEXT,
      blocked_reason TEXT,
      resumable_actions_json TEXT,
      continuation_ref_json TEXT,
      recent_artifacts_json TEXT,
      criteria_json TEXT,
      checkins_json TEXT,
      proof_refs_json TEXT,
      learning_refs_json TEXT,
      model_criteria_json TEXT,
      expected_outputs_json TEXT,
      delivery_state_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE run_meta (
      run_id TEXT PRIMARY KEY,
      task_id TEXT,
      scope_id TEXT,
      status TEXT NOT NULL,
      task_type TEXT,
      terminal_reason TEXT,
      budget_json TEXT,
      last_message_text TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      meta_json TEXT DEFAULT '{}'
    );
  `)
}

const OBSOLETE_CRITERIA = {
  items: [{
    id: 'c1',
    kind: 'tool_call',
    text: '至少一次工具调用，或结构化声明"无需工具"（C1.2 守卫的数据化）',
    source: 'template',
  }],
  satisfiedCount: 0,
  totalCount: 1,
}

function inertSinglePathDeliveryState(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    stateRevision: 0,
    decision: 'single_path',
    parentGeneration: 2897686690,
    packages: [],
    verifier: { status: 'not_required', repaired: false },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageSource: 'missing',
      providerCallCount: 0,
      missingCallCount: 0,
    },
    ...overrides,
  }
}

function falseFailureFixture(taskId: string, overrides: {
  answer?: string
  projection?: Record<string, unknown>
  run?: Record<string, unknown>
  message?: Record<string, unknown>
} = {}) {
  const runId = `run-${taskId}`
  const scopeId = `scope-${taskId}`
  const answer = overrides.answer ?? `answer-${taskId}`
  const ts = '2026-07-15T08:25:35.767Z'
  const projection = {
    task_id: taskId,
    scope_id: scopeId,
    run_id: runId,
    task_type: 'direct_answer',
    module: 'system',
    status: 'failed',
    interaction_state: 'suspended',
    waiting_for: 'none',
    steps_json: '[]',
    budget_json: JSON.stringify({
      taskType: 'short_task',
      maxIterations: 24,
      maxToolCalls: 24,
      maxParallelToolGroups: 5,
      reservedToolCalls: 0,
      iterationsUsed: 1,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
      stepBudget: null,
      frozen: false,
      bootstrapBudget: true,
    }),
    budget_usage_percent: 4,
    budget_warning_level: null,
    recovery_history_json: null,
    degradation_reason: null,
    blocked_reason: null,
    resumable_actions_json: '["retry"]',
    continuation_ref_json: null,
    recent_artifacts_json: '[]',
    criteria_json: JSON.stringify(OBSOLETE_CRITERIA),
    checkins_json: JSON.stringify([{
      kind: 'enforce',
      verdict: 'degraded',
      terminalStatus: 'done',
      terminalReason: 'done',
      satisfiedCount: 0,
      totalCount: 1,
      proofCount: 1,
      blockers: ['criteria_unsatisfied:c1'],
      ts,
      learningDecision: { learned: false, refCount: 0 },
    }]),
    proof_refs_json: JSON.stringify([{
      kind: 'assistant_response',
      ref: answer.slice(0, 120),
      ts,
      digest: createHash('sha256').update(answer).digest('hex'),
    }]),
    learning_refs_json: '[]',
    model_criteria_json: null,
    expected_outputs_json: null,
    delivery_state_json: null,
    created_at: ts,
    updated_at: ts,
    ...overrides.projection,
  }
  const run = {
    run_id: runId,
    task_id: taskId,
    scope_id: scopeId,
    status: 'error',
    task_type: 'short_task',
    terminal_reason: 'adjudication_degraded',
    budget_json: JSON.stringify({
      maxIterations: 24,
      maxToolCalls: 24,
      maxParallelToolGroups: 5,
      reservedToolCalls: 0,
      iterationsUsed: 1,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    }),
    last_message_text: answer,
    updated_at: Date.parse(ts),
    ...overrides.run,
  }
  const messageMeta = {
    runId,
    keep: 'preserved',
    taskSnapshot: {
      scopeId,
      taskId,
      phase: 'error',
      terminalReason: 'adjudication_degraded',
      waitingFor: 'none',
      resumableActions: [],
      blockedReason: null,
      error: null,
      updatedAt: ts,
    },
  }
  const message = {
    id: `message-${taskId}`,
    conversation_id: scopeId,
    role: 'assistant',
    content: answer,
    timestamp: ts,
    meta_json: JSON.stringify(messageMeta),
    ...overrides.message,
  }
  return { projection, run, message }
}

function insertFixture(db: TestDatabase, fixture: ReturnType<typeof falseFailureFixture>): void {
  const insertRecord = (table: string, record: Record<string, unknown>) => {
    const columns = Object.keys(record)
    db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map((column) => record[column]))
  }
  insertRecord('task_projections', fixture.projection)
  insertRecord('run_meta', fixture.run)
  insertRecord('chat_messages', fixture.message)
}

test('migration 077 atomically repairs only the strict false-failure shape and is idempotent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-077 direct-answer truth')) return
  const db = await openDatabase()
  createSchema(db)
  const longAnswer = '这是一条需要保留完整正文、但证据引用只保存固定长度前缀的历史回复。'.repeat(8)
  insertFixture(db, falseFailureFixture('repair-me'))
  insertFixture(db, falseFailureFixture('repair-realistic-delivery-state', {
    answer: longAnswer,
    projection: { delivery_state_json: JSON.stringify(inertSinglePathDeliveryState()) },
  }))
  insertFixture(db, falseFailureFixture('model-criteria', {
    projection: { model_criteria_json: '["必须交付一份报告"]' },
  }))
  insertFixture(db, falseFailureFixture('tool-bearing', {
    projection: {
      budget_json: JSON.stringify({
        taskType: 'short_task', maxIterations: 24, maxToolCalls: 24,
        maxParallelToolGroups: 5, reservedToolCalls: 0, iterationsUsed: 1,
        toolCallsUsed: 1, parallelToolGroupsUsed: 0, stepBudget: null,
        frozen: false, bootstrapBudget: true,
      }),
    },
  }))
  insertFixture(db, falseFailureFixture('empty-answer', {
    run: { last_message_text: '' },
    message: { content: '' },
  }))
  insertFixture(db, falseFailureFixture('real-research', {
    projection: { task_type: 'research' },
    run: { task_type: 'research' },
  }))
  insertFixture(db, falseFailureFixture('wrong-message-snapshot', {
    message: { meta_json: JSON.stringify({ runId: 'other-run', taskSnapshot: { taskId: 'other-task' } }) },
  }))
  insertFixture(db, falseFailureFixture('malformed-quality-json', {
    projection: { criteria_json: '{not-json' },
  }))
  insertFixture(db, falseFailureFixture('extra-proof', {
    projection: {
      proof_refs_json: JSON.stringify([
        { kind: 'assistant_response', ref: 'answer-extra-proof', digest: 'digest-extra-proof' },
        { kind: 'tool_result', ref: 'unexpected-tool' },
      ]),
    },
  }))
  insertFixture(db, falseFailureFixture('delivery-not-single-path', {
    projection: {
      delivery_state_json: JSON.stringify(inertSinglePathDeliveryState({ decision: 'verify_only' })),
    },
  }))
  insertFixture(db, falseFailureFixture('delivery-has-package', {
    projection: {
      delivery_state_json: JSON.stringify(inertSinglePathDeliveryState({ packages: [{ packageId: 'pkg' }] })),
    },
  }))
  insertFixture(db, falseFailureFixture('delivery-verifier-active', {
    projection: {
      delivery_state_json: JSON.stringify(inertSinglePathDeliveryState({
        verifier: { status: 'pending', repaired: false },
      })),
    },
  }))
  insertFixture(db, falseFailureFixture('delivery-usage-present', {
    projection: {
      delivery_state_json: JSON.stringify(inertSinglePathDeliveryState({
        usage: {
          inputTokens: 1,
          outputTokens: 0,
          totalTokens: 1,
          usageSource: 'provider',
          providerCallCount: 1,
          missingCallCount: 0,
        },
      })),
    },
  }))
  insertFixture(db, falseFailureFixture('delivery-extra-state', {
    projection: {
      delivery_state_json: JSON.stringify(inertSinglePathDeliveryState({ unexpected: true })),
    },
  }))
  insertFixture(db, falseFailureFixture('proof-ref-119', {
    answer: longAnswer,
    projection: {
      proof_refs_json: JSON.stringify([{
        kind: 'assistant_response',
        ref: longAnswer.slice(0, 119),
        digest: createHash('sha256').update(longAnswer).digest('hex'),
      }]),
    },
  }))
  insertFixture(db, falseFailureFixture('proof-ref-121', {
    answer: longAnswer,
    projection: {
      proof_refs_json: JSON.stringify([{
        kind: 'assistant_response',
        ref: longAnswer.slice(0, 121),
        digest: createHash('sha256').update(longAnswer).digest('hex'),
      }]),
    },
  }))
  insertFixture(db, falseFailureFixture('proof-ref-wrong-prefix', {
    answer: longAnswer,
    projection: {
      proof_refs_json: JSON.stringify([{
        kind: 'assistant_response',
        ref: `错${longAnswer.slice(1, 120)}`,
        digest: createHash('sha256').update(longAnswer).digest('hex'),
      }]),
    },
  }))
  insertFixture(db, falseFailureFixture('proof-digest-mismatch', {
    answer: longAnswer,
    projection: {
      proof_refs_json: JSON.stringify([{
        kind: 'assistant_response',
        ref: longAnswer.slice(0, 120),
        digest: createHash('sha256').update(`${longAnswer}wrong`).digest('hex'),
      }]),
    },
  }))

  __runMigrationForTests('077_repair_false_failed_direct_answers', db)

  const repaired = db.prepare('SELECT * FROM task_projections WHERE task_id = ?')
    .get<Record<string, unknown>>('repair-me')!
  const repairedBudget = JSON.parse(String(repaired.budget_json))
  const repairedCriteria = JSON.parse(String(repaired.criteria_json))
  const repairedCheckIn = JSON.parse(String(repaired.checkins_json))[0]
  assert.equal(repaired.status, 'completed')
  assert.equal(repaired.task_type, 'direct_answer')
  assert.equal(repaired.interaction_state, 'suspended')
  assert.equal(repaired.waiting_for, 'none')
  assert.equal(repaired.resumable_actions_json, '[]')
  assert.equal(repaired.budget_usage_percent, 13)
  assert.equal(repairedBudget.taskType, 'direct_answer')
  assert.equal(repairedBudget.maxIterations, 8)
  assert.equal(repairedBudget.maxToolCalls, 8)
  assert.equal(repairedBudget.bootstrapBudget, false)
  assert.equal(repairedBudget.iterationsUsed, 1)
  assert.equal(repairedCriteria.items[0].kind, 'response_digest')
  assert.equal(repairedCriteria.satisfiedCount, 1)
  assert.equal(repairedCheckIn.verdict, 'accept')
  assert.equal(repairedCheckIn.satisfiedCount, 1)
  assert.deepEqual(repairedCheckIn.blockers, [])

  const repairedRun = db.prepare('SELECT * FROM run_meta WHERE task_id = ?')
    .get<Record<string, unknown>>('repair-me')!
  const repairedRunBudget = JSON.parse(String(repairedRun.budget_json))
  assert.equal(repairedRun.status, 'done')
  assert.equal(repairedRun.task_type, 'direct_answer')
  assert.equal(repairedRun.terminal_reason, 'done')
  assert.equal(repairedRunBudget.maxIterations, 8)
  assert.equal(repairedRunBudget.maxToolCalls, 8)
  assert.equal(repairedRunBudget.toolCallsUsed, 0)

  const repairedMessage = db.prepare('SELECT * FROM chat_messages WHERE id = ?')
    .get<Record<string, unknown>>('message-repair-me')!
  const repairedMeta = JSON.parse(String(repairedMessage.meta_json))
  assert.equal(repairedMeta.keep, 'preserved')
  assert.equal(repairedMeta.taskSnapshot.phase, 'done')
  assert.equal(repairedMeta.taskSnapshot.terminalReason, 'done')
  assert.equal(repairedMeta.taskSnapshot.waitingFor, 'none')
  assert.deepEqual(repairedMeta.taskSnapshot.resumableActions, [])

  const realisticDeliveryState = db.prepare('SELECT status FROM task_projections WHERE task_id = ?')
    .get<{ status: string }>('repair-realistic-delivery-state')
  const realisticRun = db.prepare('SELECT status FROM run_meta WHERE task_id = ?')
    .get<{ status: string }>('repair-realistic-delivery-state')
  const realisticMessage = db.prepare('SELECT meta_json FROM chat_messages WHERE id = ?')
    .get<{ meta_json: string }>('message-repair-realistic-delivery-state')
  assert.equal(realisticDeliveryState?.status, 'completed')
  assert.equal(realisticRun?.status, 'done')
  assert.equal(JSON.parse(realisticMessage?.meta_json || '{}').taskSnapshot?.phase, 'done')

  for (const untouchedTaskId of [
    'model-criteria',
    'tool-bearing',
    'empty-answer',
    'real-research',
    'wrong-message-snapshot',
    'malformed-quality-json',
    'extra-proof',
    'delivery-not-single-path',
    'delivery-has-package',
    'delivery-verifier-active',
    'delivery-usage-present',
    'delivery-extra-state',
    'proof-ref-119',
    'proof-ref-121',
    'proof-ref-wrong-prefix',
    'proof-digest-mismatch',
  ]) {
    const row = db.prepare('SELECT status FROM task_projections WHERE task_id = ?')
      .get<{ status: string }>(untouchedTaskId)
    assert.equal(row?.status, 'failed', `${untouchedTaskId} must remain untouched`)
  }

  const snapshotAfterFirstRun = JSON.stringify({
    projection: repaired,
    run: repairedRun,
    message: repairedMessage,
  })
  assert.doesNotThrow(() => __runMigrationForTests('077_repair_false_failed_direct_answers', db))
  const snapshotAfterSecondRun = JSON.stringify({
    projection: db.prepare('SELECT * FROM task_projections WHERE task_id = ?').get('repair-me'),
    run: db.prepare('SELECT * FROM run_meta WHERE task_id = ?').get('repair-me'),
    message: db.prepare('SELECT * FROM chat_messages WHERE id = ?').get('message-repair-me'),
  })
  assert.equal(snapshotAfterSecondRun, snapshotAfterFirstRun)
  db.close()
})
