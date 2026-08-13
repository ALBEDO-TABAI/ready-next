import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { loadSkillRunContract } from '../main/modules/agent-control/contracts/skill-run-contract-loader'
import type { DatabaseConnection } from '../main/modules/database'
import type { MigrationDatabase } from '../main/modules/migrations'
import {
  SkillTaskRunRepository,
  type SkillTaskRunRecord,
} from '../main/modules/repositories/skill-task-run-repository'
import { openProviderCheckpointTestDb as openDb } from './provider-checkpoint-test-fixtures'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import {
  __resetSkillChildRunnerForTests,
  configureSkillChildRunner,
} from '../main/modules/agent-control/skills/skill-child-runner'
import { DetachedSkillTaskTracker } from '../main/modules/agent-control/detached-skill-task-tracker'
import { DetachedSkillService } from '../main/modules/agent-control/runtime-core/detached-skill-service'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'
import type { SkillRunResult } from '../main/modules/skills-runtime/runtime-manager'

type TestDatabase = DatabaseConnection & MigrationDatabase

const now = '2026-08-12T03:00:00.000Z'

function insertScope(db: TestDatabase, scopeId: string, epoch: number): void {
  db.prepare(
    `INSERT INTO chat_conversations (
       id, agent, title, created_at, updated_at, message_visibility_epoch
     ) VALUES (?, 'butler', ?, ?, ?, ?)`,
  ).run(scopeId, scopeId, now, now, epoch)
}

function insertOwner(db: TestDatabase, scopeId: string, runId: string, epoch: number): void {
  new RunMetaRepository(db).create({
    runId,
    taskId: `task-${runId}`,
    scopeId,
    messageVisibilityEpoch: epoch,
    status: 'running',
  }, Date.parse(now))
}

function makeRecord(id: string, scopeId: string, runId: string): SkillTaskRunRecord {
  return {
    id,
    scopeId,
    sessionId: scopeId,
    runId,
    skillId: 'context-epoch-skill',
    skillName: 'Context Epoch Skill',
    action: 'run',
    runKind: 'typed_action',
    status: 'running',
    interactionState: 'running',
    steps: [],
    artifacts: [],
    detachedTaskId: `detached-${id}`,
    createdAt: now,
    updatedAt: now,
  }
}

test('skill task rows freeze owner epoch, hide after reset, and reject every stale write', (t) => {
  if (skipIfSqliteUnavailable(t, 'skill-task-run-context-epoch-native')) return
  const db = openDb()
  const repository = new SkillTaskRunRepository({ getRawDb: () => db })
  const scopeId = 'scope-skill-task-epoch'
  const oldRunId = 'run-skill-task-old'
  try {
    insertScope(db, scopeId, 0)
    insertOwner(db, scopeId, oldRunId, 0)
    repository.create(makeRecord('skill-task-old', scopeId, oldRunId))

    assert.equal(repository.get('skill-task-old')?.messageVisibilityEpoch, 0)
    assert.deepEqual(repository.listByScope(scopeId).map((row) => row.id), ['skill-task-old'])
    assert.equal(repository.findByDetachedTaskId('detached-skill-task-old')?.id, 'skill-task-old')

    db.prepare(
      `UPDATE chat_conversations
          SET message_visibility_epoch = message_visibility_epoch + 1
        WHERE id = ?`,
    ).run(scopeId)

    assert.equal(repository.listByScope(scopeId).length, 0)
    assert.equal(repository.listActiveBySession(scopeId).length, 0)
    assert.equal(repository.findLatestRecoverable({ scopeId }), null)
    assert.equal(repository.findByDetachedTaskId('detached-skill-task-old'), null)
    assert.equal(repository.get('skill-task-old')?.messageVisibilityEpoch, 0, 'raw id read remains audit-visible')

    assert.throws(
      () => repository.updateRowSync('skill-task-old', { updatedAt: '2026-08-12T03:01:00.000Z' }),
      /skill_task_run_visibility_epoch_stale/,
    )
    assert.equal(repository.get('skill-task-old')?.updatedAt, now)
    assert.throws(
      () => repository.create(makeRecord('skill-task-old-late', scopeId, oldRunId)),
      /skill_task_run_visibility_epoch_mismatch/,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM skill_task_runs')
        .get<{ count: number }>()?.count,
      1,
    )

    const currentRunId = 'run-skill-task-current'
    insertOwner(db, scopeId, currentRunId, 1)
    repository.create(makeRecord('skill-task-current', scopeId, currentRunId))
    assert.equal(repository.get('skill-task-current')?.messageVisibilityEpoch, 1)
    assert.deepEqual(repository.listByScope(scopeId).map((row) => row.id), ['skill-task-current'])

    // Stop/alias rollover does not replace the message context. Same-epoch
    // task closeout remains writable even when its owner run is terminal.
    db.prepare("UPDATE run_meta SET status = 'done' WHERE run_id = ?").run(currentRunId)
    repository.updateRowSync('skill-task-current', {
      status: 'done',
      updatedAt: '2026-08-12T03:02:00.000Z',
      finishedAt: '2026-08-12T03:02:00.000Z',
    })
    assert.equal(repository.get('skill-task-current')?.status, 'done')
  } finally {
    db.close()
  }
})

test('explicit child-run contracts use current-visible lookup while raw audit remains exact', (t) => {
  if (skipIfSqliteUnavailable(t, 'skill-child-contract-context-epoch-native')) return
  const db = openDb()
  const repository = new SkillTaskRunRepository({ getRawDb: () => db })
  const scopeId = 'scope-child-contract-epoch'
  const createChild = (childRunId: string, ownerRunId: string, epoch: number) => {
    insertOwner(db, scopeId, ownerRunId, epoch)
    return repository.createChildRun({
      childRunId,
      scopeId,
      parentRunId: ownerRunId,
      sessionId: scopeId,
      skillId: 'context-epoch-skill',
      skillName: 'Context Epoch Skill',
      action: 'run',
      requestedInput: {},
      singleFlightKey: `${scopeId}:${epoch}`,
      parentNextHint: 'wait_for_close_event',
      outputDir: `/tmp/${childRunId}`,
      runStatePath: `/tmp/${childRunId}/run_state.json`,
      eventLogPath: `/tmp/${childRunId}/events.jsonl`,
      status: 'running',
    })
  }
  const load = (childRunId: string) => loadSkillRunContract({
    scopeId,
    sessionId: scopeId,
    skillId: 'context-epoch-skill',
    childRunId,
    skillTaskRunRepository: repository,
  })
  try {
    insertScope(db, scopeId, 0)
    const oldChildId = 'schild-contract-old'
    createChild(oldChildId, 'run-child-contract-old', 0)
    assert.equal(load(oldChildId)?.childRunId, oldChildId)

    db.prepare(
      `UPDATE chat_conversations
          SET message_visibility_epoch = message_visibility_epoch + 1
        WHERE id = ?`,
    ).run(scopeId)
    assert.equal(load(oldChildId)?.childRunId, undefined)
    assert.equal(repository.getCurrentVisible(oldChildId), null)
    assert.equal(repository.getRaw(oldChildId)?.id, oldChildId)

    const currentChildId = 'schild-contract-current'
    const currentRunId = 'run-child-contract-current'
    createChild(currentChildId, currentRunId, 1)
    db.prepare("UPDATE run_meta SET status = 'done' WHERE run_id = ?").run(currentRunId)
    assert.equal(load(currentChildId)?.childRunId, currentChildId)
  } finally {
    db.close()
  }
})

test('stale child-run id cannot cancel the old context while same-epoch stop remains cancellable', async (t) => {
  if (skipIfSqliteUnavailable(t, 'skill-child-cancel-context-epoch-native')) return
  const db = openDb()
  const repository = new SkillTaskRunRepository({ getRawDb: () => db })
  const scopeId = 'scope-child-cancel-epoch'
  const createChild = (childRunId: string, ownerRunId: string, epoch: number) => {
    insertOwner(db, scopeId, ownerRunId, epoch)
    repository.createChildRun({
      childRunId,
      scopeId,
      parentRunId: ownerRunId,
      messageVisibilityEpoch: epoch,
      sessionId: scopeId,
      skillId: 'context-epoch-skill',
      skillName: 'Context Epoch Skill',
      action: 'run',
      requestedInput: {},
      singleFlightKey: `${scopeId}:${epoch}:${childRunId}`,
      parentNextHint: 'wait_for_close_event',
      outputDir: `/tmp/${childRunId}`,
      runStatePath: `/tmp/${childRunId}/run_state.json`,
      eventLogPath: `/tmp/${childRunId}/events.jsonl`,
      status: 'running',
    })
  }
  try {
    insertScope(db, scopeId, 0)
    const oldChildId = 'schild-cancel-old'
    createChild(oldChildId, 'run-child-cancel-old', 0)
    const runner = configureSkillChildRunner({
      runtimeManager: {} as never,
      repository,
      publishScopeRunEvent: () => undefined,
    })

    db.prepare(
      `UPDATE chat_conversations
          SET message_visibility_epoch = message_visibility_epoch + 1
        WHERE id = ?`,
    ).run(scopeId)
    await assert.rejects(
      () => runner.cancelSkillChildRun(oldChildId, { source: 'ui_button' }),
      /skill_child_run_context_stale/,
    )
    assert.equal(repository.getRaw(oldChildId)?.status, 'running')

    const currentChildId = 'schild-cancel-current'
    createChild(currentChildId, 'run-child-cancel-current', 1)
    const close = await runner.cancelSkillChildRun(currentChildId, { source: 'ui_button' })
    assert.equal(close.status, 'killed')
    assert.equal(repository.getRaw(currentChildId)?.status, 'cancelled')
  } finally {
    __resetSkillChildRunnerForTests()
    db.close()
  }
})

test('stale detached task id cannot inspect or cancel the old context while same-epoch task remains cancellable', async (t) => {
  if (skipIfSqliteUnavailable(t, 'detached-task-action-context-epoch-native')) return
  const db = openDb()
  const storageRoot = mkdtempSync(join(tmpdir(), 'ready-detached-action-epoch-'))
  const scopeId = 'scope-detached-action-epoch'
  const signals = new Map<string, AbortSignal>()
  const resolvers = new Map<string, (result: SkillRunResult) => void>()
  const tracker = new DetachedSkillTaskTracker({
    storagePath: join(storageRoot, 'tasks.json'),
    runSkill: (request) => new Promise<SkillRunResult>((resolve) => {
      signals.set(String(request.params?.marker), request.signal!)
      resolvers.set(String(request.params?.marker), resolve)
      request.signal?.addEventListener('abort', () => resolve({
        success: false,
        skillId: request.skillId,
        action: request.action,
        stdout: '',
        stderr: '',
        command: [],
        error: 'aborted',
      }), { once: true })
    }),
  })
  const service = new DetachedSkillService({
    tracker,
    publishScopeRunEvent: () => undefined,
  })
  __setScopeContextEpochDatabaseForTests({ getRawDb: () => db })
  try {
    insertScope(db, scopeId, 0)
    const old = tracker.start({
      scopeId,
      sessionId: scopeId,
      messageVisibilityEpoch: 0,
      skillId: 'context-epoch-skill',
      action: 'run',
      params: { marker: 'old' },
    })
    assert.equal(service.inspectDetachedSkillTask(old.id, scopeId)?.id, old.id)

    db.prepare(
      `UPDATE chat_conversations
          SET message_visibility_epoch = message_visibility_epoch + 1
        WHERE id = ?`,
    ).run(scopeId)
    assert.equal(service.inspectDetachedSkillTask(old.id, scopeId), null)
    assert.equal(service.cancelDetachedSkillTask(old.id, scopeId), null)
    assert.equal(signals.get('old')?.aborted, false)
    assert.equal(tracker.inspect(old.id)?.status, 'running')

    const current = tracker.start({
      scopeId,
      sessionId: scopeId,
      messageVisibilityEpoch: 1,
      skillId: 'context-epoch-skill',
      action: 'run',
      params: { marker: 'current' },
    })
    assert.equal(service.cancelDetachedSkillTask(current.id, scopeId)?.status, 'cancelled')
    assert.equal(signals.get('current')?.aborted, true)

    resolvers.get('old')?.({
      success: true,
      skillId: 'context-epoch-skill',
      action: 'run',
      stdout: '',
      stderr: '',
      command: [],
    })
    await tracker.waitForTask(old.id)
    await tracker.waitForTask(current.id)
  } finally {
    __setScopeContextEpochDatabaseForTests(null)
    rmSync(storageRoot, { recursive: true, force: true })
    db.close()
  }
})
