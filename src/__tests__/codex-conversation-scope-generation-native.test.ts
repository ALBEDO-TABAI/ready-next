import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DatabaseManager,
  type ChatConversationRecord,
  type DatabaseConnection,
} from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { ConversationScopeStore } from '../main/modules/agent-control/runtime-core/conversation-scope-store'
import { SessionRecallService } from '../main/modules/agent-control/session/session-recall-service'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

type NativeDb = import('better-sqlite3').Database

const createdAt = '2026-08-08T00:00:00.000Z'
const scopeRow: ChatConversationRecord = {
  id: 'scope-generation-1',
  agent: 'butler',
  active_agent_id: 'butler',
  handoff_generation: 0,
  user_id: 'default-user',
  title: '新对话',
  parent_conversation_id: null,
  lineage_root_id: 'scope-generation-1',
  resume_title: '新对话',
  source_kind: 'local',
  source_id: 'app',
  thread_key: 'scope-generation-1',
  meta_json: '{}',
  created_at: createdAt,
  updated_at: createdAt,
}

function createStore(repository: CodexBindingRepository): ConversationScopeStore {
  const db = {
    listConversationScopes: () => [scopeRow],
    getConversationScope: (scopeId: string) => scopeId === scopeRow.id ? scopeRow : null,
    getChatMessages: () => [],
  } as unknown as DatabaseManager
  return new ConversationScopeStore({
    db,
    emitConversationEvent() {},
    mapChannelRow() { throw new Error('unexpected_channel_mapping') },
    getScopedRemoteThreadKey() { throw new Error('unexpected_remote_scope') },
    getRemoteChannelSessionSettingKey() { throw new Error('unexpected_remote_scope') },
    restoreReferenceHintFromScope() {},
    persistReferenceHintToScope() {},
    resolveConversationAgentId: (agentId) => agentId,
    readAliasGeneration: (aliasId) => (
      repository.readActiveAliasBinding(aliasId)?.aliasGeneration ?? null
    ),
    readLatestAliasGeneration: (aliasId) => repository.readLatestAliasGeneration(aliasId),
  })
}

function createRealStore(
  database: DatabaseManager,
  repository: CodexBindingRepository,
): ConversationScopeStore {
  return new ConversationScopeStore({
    db: database,
    emitConversationEvent() {},
    mapChannelRow() { throw new Error('unexpected_channel_mapping') },
    getScopedRemoteThreadKey() { throw new Error('unexpected_remote_scope') },
    getRemoteChannelSessionSettingKey() { throw new Error('unexpected_remote_scope') },
    restoreReferenceHintFromScope() {},
    persistReferenceHintToScope() {},
    resolveConversationAgentId: (agentId) => agentId,
    readAliasGeneration: (aliasId) => (
      repository.readActiveAliasBinding(aliasId)?.aliasGeneration ?? null
    ),
    readLatestAliasGeneration: (aliasId) => repository.readLatestAliasGeneration(aliasId),
  })
}

async function withRepository(
  t: Parameters<typeof skipIfSqliteUnavailable>[0],
  work: (db: NativeDb, repository: CodexBindingRepository) => void | Promise<void>,
): Promise<void> {
  if (skipIfSqliteUnavailable(t, 'Codex conversation scope generation')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        meta_json TEXT NOT NULL DEFAULT '{}',
        closed_at TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT '2026-08-08T00:00:00.000Z'
      )
    `)
    db.prepare(`
      INSERT INTO chat_conversations (id, meta_json, closed_at, message_visibility_epoch, updated_at)
      VALUES (?, '{}', NULL, 0, ?)
    `).run(scopeRow.id, createdAt)
    __runMigrationForTests('088_codex_runtime_bindings', db as unknown as MigrationDatabase)
    const repository = new CodexBindingRepository(db as unknown as DatabaseConnection)
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-binding-generation-1',
      aliasId: scopeRow.id,
      aliasGeneration: 1,
      readyScopeId: scopeRow.id,
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt,
    })
    await work(db, repository)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
}

test('create to first send maps generation from the durable Main binding', async (t) => {
  await withRepository(t, (_db, repository) => {
    const scope = createStore(repository).getConversationScope(scopeRow.id)

    assert.equal(scope?.id, scopeRow.id)
    assert.equal(scope?.aliasGeneration, 1)
    assert.equal(scope?.latestAliasGeneration, 1)
  })
})

test('reload to follow-up restores generation from a reopened repository', async (t) => {
  await withRepository(t, (db) => {
    const reopened = new CodexBindingRepository(db as unknown as DatabaseConnection)
    const scopes = createStore(reopened).listConversationScopes('butler')

    assert.equal(scopes.length, 1)
    assert.equal(scopes[0].aliasGeneration, 1)
  })
})

test('reset then reload exposes only the new durable generation', async (t) => {
  await withRepository(t, (db, repository) => {
    const reset = repository.resetIdleAlias({
      aliasId: scopeRow.id,
      expectedGeneration: 1,
      retirementEvidenceDigest: 'reset-generation-evidence',
      resetAt: '2026-08-08T00:01:00.000Z',
    })
    assert.equal(reset.newGeneration, 2)

    const reopened = new CodexBindingRepository(db as unknown as DatabaseConnection)
    const scopes = createStore(reopened).listConversationScopes('butler')

    assert.equal(scopes.length, 1)
    assert.equal(scopes[0].aliasGeneration, 2)
    assert.equal(scopes[0].latestAliasGeneration, 2)
  })
})

test('list keeps latestAliasGeneration when the active binding is gone', async () => {
  const db = {
    listConversationScopes: () => [scopeRow],
    getConversationScope: (scopeId: string) => scopeId === scopeRow.id ? scopeRow : null,
    getChatMessages: () => [],
  } as unknown as DatabaseManager
  const store = new ConversationScopeStore({
    db,
    emitConversationEvent() {},
    mapChannelRow() { throw new Error('unexpected_channel_mapping') },
    getScopedRemoteThreadKey() { throw new Error('unexpected_remote_scope') },
    getRemoteChannelSessionSettingKey() { throw new Error('unexpected_remote_scope') },
    restoreReferenceHintFromScope() {},
    persistReferenceHintToScope() {},
    resolveConversationAgentId: (agentId) => agentId,
    readAliasGeneration: () => null,
    readLatestAliasGeneration: () => 2,
  })
  const scope = store.getConversationScope(scopeRow.id)
  assert.equal(scope?.aliasGeneration, null)
  assert.equal(scope?.latestAliasGeneration, 2)
})

test('reset advances the durable message epoch while preserving old rows only for audit', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex reset message visibility epoch')) return
  const database = new DatabaseManager(true)
  try {
    const rawDb = database.getRawDb()
    assert.ok(rawDb)
    const repository = new CodexBindingRepository(rawDb)
    const store = createRealStore(database, repository)
    const scope = store.createLocalScope('butler', 'scope-reset-visibility')
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-binding-reset-visibility-1',
      aliasId: scope.id,
      aliasGeneration: 1,
      readyScopeId: scope.id,
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt,
    })
    database.updateConversationScopeMeta(scope.id, {
      lastReferenceSkill: { skillId: 'old-reference-skill', recordedAt: createdAt },
      sessionRecallContext: { attached: ['old-recall-capsule'] },
      actionAuthorizationMode: 'oa_mode',
    })
    database.addChatMessage(
      'old-visibility-message',
      scope.id,
      'assistant',
      '旧消息雅典关键词',
      '2026-08-08T00:00:10.000Z',
      {
        attachments: [{
          id: 'old-attachment',
          name: '旧附件火星关键词.txt',
          path: '/tmp/old-attachment.txt',
          type: 'text',
          size: 1,
          ext: '.txt',
        }],
      },
      0,
    )
    database.updateConversationRecallTaskState(
      scope.id,
      '旧任务奥林匹斯关键词',
      '旧任务摘要',
    )
    const taskProjections = new TaskProjectionRepository({ getRawDb: () => rawDb })
    taskProjections.create({
      taskId: 'old-visibility-task',
      taskOrigin: 'system_background',
      scopeId: scope.id,
      messageVisibilityEpoch: 0,
      runId: 'old-visibility-run',
      taskType: 'short_task',
      module: 'system',
      taskTitle: '旧任务奥林匹斯关键词',
      taskSummary: '旧任务摘要',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      createdAt,
      updatedAt: createdAt,
    })
    const recall = new SessionRecallService(database)
    assert.deepEqual(
      recall.searchSessionRecall({ query: '雅典关键词' }).map((hit) => hit.conversationId),
      [scope.id],
    )
    assert.deepEqual(
      recall.searchSessionRecall({ query: '火星关键词' }).map((hit) => hit.conversationId),
      [scope.id],
    )
    assert.deepEqual(
      recall.searchSessionRecall({ query: '奥林匹斯关键词' }).map((hit) => hit.conversationId),
      [scope.id],
    )

    const reset = repository.resetIdleAlias({
      aliasId: scope.id,
      expectedGeneration: 1,
      retirementEvidenceDigest: 'e'.repeat(64),
      resetAt: '2026-08-08T00:01:00.000Z',
    })
    assert.equal(reset.newGeneration, 2)
    assert.deepEqual(rawDb.prepare(`
      SELECT message_visibility_epoch, meta_json FROM chat_conversations WHERE id = ?
    `).get(scope.id), {
      message_visibility_epoch: 1,
      meta_json: JSON.stringify({ actionAuthorizationMode: 'oa_mode' }),
    })
    assert.deepEqual(rawDb.prepare(`
      SELECT id, message_visibility_epoch FROM chat_messages WHERE conversation_id = ?
    `).all(scope.id), [{ id: 'old-visibility-message', message_visibility_epoch: 0 }])

    const coldStore = createRealStore(database, new CodexBindingRepository(rawDb))
    assert.deepEqual(coldStore.getConversationScopeMessages(scope.id), [])
    assert.deepEqual(database.listConversationAttachments(scope.id), [])
    assert.equal(database.getChatMessageById('old-visibility-message'), null)
    assert.equal(database.updateChatMessageMeta('old-visibility-message', { revived: true }), false)
    assert.deepEqual(recall.searchSessionRecall({ query: '雅典关键词' }), [])
    assert.deepEqual(recall.searchSessionRecall({ query: '火星关键词' }), [])
    assert.deepEqual(recall.searchSessionRecall({ query: '奥林匹斯关键词' }), [])
    assert.deepEqual(taskProjections.listByScope(scope.id), [])
    assert.equal(rawDb.prepare(`
      SELECT message_visibility_epoch FROM task_projections WHERE task_id = ?
    `).get<{ message_visibility_epoch: number }>('old-visibility-task')?.message_visibility_epoch, 0)
    assert.throws(() => taskProjections.update('old-visibility-task', {
      taskSummary: '不得晚到复活',
      updatedAt: '2026-08-08T00:01:05.000Z',
    }), /task_projection_visibility_epoch_stale/)
    assert.throws(() => database.addChatMessage(
      'old-visibility-message', scope.id, 'assistant', '不得复活',
      '2026-08-08T00:01:10.000Z', {}, 1,
    ), /visibility epoch mismatch/)
    assert.throws(() => database.addChatMessage(
      'stale-fresh-message', scope.id, 'assistant', '旧代新 ID 不得写入',
      '2026-08-08T00:01:11.000Z', {}, 0,
    ), /visibility epoch mismatch/)

    database.addChatMessage(
      'new-visibility-message',
      scope.id,
      'assistant',
      '新消息斯巴达关键词',
      '2026-08-08T00:01:20.000Z',
      {},
      1,
    )
    taskProjections.create({
      taskId: 'new-visibility-task',
      taskOrigin: 'system_background',
      scopeId: scope.id,
      messageVisibilityEpoch: 1,
      runId: 'new-visibility-run',
      taskType: 'short_task',
      module: 'system',
      taskTitle: '新任务',
      taskSummary: '新代可见',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      createdAt: '2026-08-08T00:01:20.000Z',
      updatedAt: '2026-08-08T00:01:20.000Z',
    })
    assert.deepEqual(
      taskProjections.listByScope(scope.id).map((projection) => projection.taskId),
      ['new-visibility-task'],
    )
    assert.deepEqual(
      coldStore.getConversationScopeMessages(scope.id).map((message) => message.id),
      ['new-visibility-message'],
    )
    assert.deepEqual(
      recall.searchSessionRecall({ query: '斯巴达关键词' }).map((hit) => hit.conversationId),
      [scope.id],
    )

    rawDb.exec('VACUUM')
    assert.deepEqual(
      coldStore.getConversationScopeMessages(scope.id).map((message) => message.id),
      ['new-visibility-message'],
    )
    assert.equal(rawDb.prepare(`
      SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?
    `).get<{ count: number }>(scope.id)?.count, 2)
  } finally {
    database.close()
  }
})
