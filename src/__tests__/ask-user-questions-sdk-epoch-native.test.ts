import assert from 'node:assert/strict'
import test from 'node:test'

import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import {
  persistAskUserQuestionsCardPending,
} from '../main/modules/claude-bridge/ask-user-questions-card-persistence'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { DatabaseManager } from '../main/modules/database'
import type { MigrationDatabase } from '../main/modules/migrations'
import {
  executeAskUserQuestions,
  type AskUserQuestionsCardEvent,
} from '../main/modules/tools/builtins/ask-user-questions'
import { AskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import { openProviderCheckpointTestDb as openDb } from './provider-checkpoint-test-fixtures'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type TestDatabase = DatabaseConnection & MigrationDatabase

function setupSdkOwner(db: TestDatabase, suffix: string) {
  const scopeId = `scope-${suffix}`
  const runId = `run-${suffix}`
  const now = '2026-08-12T02:00:00.000Z'
  db.prepare(
    `INSERT INTO chat_conversations (
       id, agent, title, created_at, updated_at, message_visibility_epoch
     ) VALUES (?, 'butler', ?, ?, ?, 0)`,
  ).run(scopeId, suffix, now, now)
  new RunMetaRepository(db).create({
    runId,
    taskId: `task-${suffix}`,
    scopeId,
    messageVisibilityEpoch: 0,
    status: 'running',
  }, Date.parse(now))
  const database = Object.create(DatabaseManager.prototype) as DatabaseManager
  ;(database as unknown as { db: DatabaseConnection | null }).db = db
  return { database, scopeId, runId }
}

const args = {
  questions: [{ id: 'q1', question: 'Continue?', kind: 'free_text' as const }],
}

test('current SDK ask persists and pushes its exact run epoch without a Codex alias', async (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-sdk-current-native')) return
  const db = openDb()
  const { database, scopeId, runId } = setupSdkOwner(db, 'ask-sdk-current')
  const store = new AskUserQuestionsStore()
  let emitted: AskUserQuestionsCardEvent | null = null
  try {
    const pending = executeAskUserQuestions(args, {
      sessionId: scopeId,
      conversationId: scopeId,
      scopeId,
      requestId: runId,
      store,
      persistCardPending: (input) => persistAskUserQuestionsCardPending(input, database),
      emitAskUserQuestionsCard: (event) => { emitted = event },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(emitted)
    assert.equal(emitted.readyRunId, runId)
    assert.equal(emitted.aliasGeneration, null)
    assert.equal(emitted.messageVisibilityEpoch, 0)
    assert.equal(
      db.prepare(
        'SELECT message_visibility_epoch FROM chat_messages WHERE id = ?',
      ).get<{ message_visibility_epoch: number }>(emitted.cardId)?.message_visibility_epoch,
      0,
    )

    store.resolve(emitted.cardId, { answers: [{ id: 'q1', answer: 'yes' }], answeredAt: 1 })
    await pending
  } finally {
    database.close()
  }
})

test('reset and terminal SDK owners persist zero ask rows and push zero cards', async (t) => {
  if (skipIfSqliteUnavailable(t, 'ask-user-sdk-stale-native')) return

  for (const state of ['reset', 'terminal'] as const) {
    const db = openDb()
    const { database, scopeId, runId } = setupSdkOwner(db, `ask-sdk-${state}`)
    const store = new AskUserQuestionsStore()
    let pushes = 0
    try {
      if (state === 'reset') {
        db.prepare(
          `UPDATE chat_conversations
              SET message_visibility_epoch = message_visibility_epoch + 1
            WHERE id = ?`,
        ).run(scopeId)
      } else {
        db.prepare("UPDATE run_meta SET status = 'done' WHERE run_id = ?").run(runId)
      }

      await assert.rejects(
        executeAskUserQuestions(args, {
          sessionId: scopeId,
          conversationId: scopeId,
          scopeId,
          requestId: runId,
          store,
          persistCardPending: (input) => persistAskUserQuestionsCardPending(input, database),
          emitAskUserQuestionsCard: () => { pushes += 1 },
        }),
        (error: unknown) => error instanceof ToolDomainError
          && error.errorKind === 'persistence_failed',
      )
      assert.equal(pushes, 0)
      assert.equal(store.size(), 0)
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'agent_card'")
          .get<{ count: number }>()?.count,
        0,
      )
    } finally {
      database.close()
    }
  }
})
