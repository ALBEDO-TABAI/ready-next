import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DatabaseManager } from '../main/modules/database'
import {
  advanceCodexConversationMessageVisibilityInOpenTransaction,
} from '../main/modules/agent-control/codex-runtime/codex-conversation-scope-closure'
import { ConversationScopeStore } from '../main/modules/agent-control/runtime-core/conversation-scope-store'
import { ReferenceHintService } from '../main/modules/agent-control/runtime-core/reference-hint-service'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import {
  clearLastReferenceSkill,
  getLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'
import {
  loadScopeSessionSnapshot,
  writeScopeSessionSnapshot,
} from '../main/modules/agent-control/session/scope-session-snapshot'
import {
  __clearNegationStateForTests,
  activeNegations,
  recordNegations,
} from '../main/modules/agent-control/safety/negation-state'
import {
  clearLarkCliAuthFlowsForTests,
  consumeLarkCliAuthCompletion,
  rememberLarkCliAuthInitiation,
} from '../main/modules/agent-control/safety/lark-cli-auth-flow-authority'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

test('reset rejects old message/context writers while the new epoch remains writable', async (t) => {
  if (skipIfSqliteUnavailable(t, 'conversation context epoch writers')) return
  const database = new DatabaseManager(true)
  __setScopeContextEpochDatabaseForTests(database)
  const scopeId = 'scope-context-writer'
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'ready-context-writer-snapshot-'))
  __clearNegationStateForTests()
  clearLarkCliAuthFlowsForTests()
  try {
    let store!: ConversationScopeStore
    const referenceHints = new ReferenceHintService({
      db: database,
      mapConversationRow: (row) => store.mapConversationRow(row),
    })
    store = new ConversationScopeStore({
      ensureChannelAlias: () => {},
      db: database,
      emitConversationEvent() {},
      mapChannelRow() { throw new Error('unexpected_channel_mapping') },
      getScopedRemoteThreadKey() { throw new Error('unexpected_remote_scope') },
      getRemoteChannelSessionSettingKey() { throw new Error('unexpected_remote_scope') },
      restoreReferenceHintFromScope: (scope, id) => (
        referenceHints.restoreReferenceHintFromScope(scope, id)
      ),
      persistReferenceHintToScope: (id, expectedEpoch) => (
        referenceHints.persistReferenceHintToScope(id, expectedEpoch)
      ),
      resolveConversationAgentId: (agentId) => agentId,
      readAliasGeneration: () => null,
    })

    store.createLocalScope('butler', scopeId)
    const rawDb = database.getRawDb()
    assert.ok(rawDb)
    const runMeta = new RunMetaRepository(rawDb)
    runMeta.create({
      runId: 'old-provider-run',
      taskId: 'old-provider-task',
      scopeId,
      messageVisibilityEpoch: 0,
      agentId: 'butler',
      status: 'running',
    })
    rememberLastReferenceSkill(scopeId, {
      id: 'old-skill',
      name: 'Old skill',
      messageVisibilityEpoch: 0,
    })
    store.createConversationMessage(scopeId, {
      role: 'assistant',
      content: 'epoch zero',
    }, 0)
    assert.equal(database.chat.getChatMessages(scopeId).length, 1)
    assert.equal(
      (JSON.parse(database.chat.getConversationScope(scopeId)!.meta_json || '{}') as {
        lastReferenceSkill?: { id?: string }
      }).lastReferenceSkill?.id,
      'old-skill',
    )
    recordNegations(scopeId, ['collection'], 0)
    assert.deepEqual(activeNegations(scopeId, 0), ['collection'])
    const larkCommand = 'lark-cli auth login --scope "docs:document.content:read" --no-wait --json'
    const oldLark = rememberLarkCliAuthInitiation({
      sessionId: scopeId,
      skillId: 'lark-cli',
      command: larkCommand,
      output: createToolExecutionOutput('authorization initiated', {
        shape: 'json',
        data: {
          exitCode: 0,
          stdout: JSON.stringify({
            device_code: 'old-device-secret',
            verification_url: 'https://example.test/verify',
          }),
        },
      }),
      executableAuthorityDigest: 'lark-authority',
      messageVisibilityEpoch: 0,
    })
    assert.ok(oldLark)
    const oldLarkHandle = JSON.stringify(oldLark).match(/ready-lark-auth-[0-9a-f-]+/)?.[0]
    assert.ok(oldLarkHandle)

    rawDb.exec('BEGIN IMMEDIATE')
    try {
      advanceCodexConversationMessageVisibilityInOpenTransaction(rawDb, {
        scopeId,
        resetAt: '2026-08-12T03:00:00.000Z',
      })
      rawDb.exec('COMMIT')
    } catch (error) {
      if (rawDb.inTransaction) rawDb.exec('ROLLBACK')
      throw error
    }
    clearLastReferenceSkill(scopeId)

    const currentSnapshot = writeScopeSessionSnapshot(
      `butler::${scopeId}`,
      [{ role: 'assistant', content: 'new epoch snapshot' }],
      1,
      snapshotRoot,
    )
    assert.equal(currentSnapshot.ok, true)
    const lateOldSnapshot = writeScopeSessionSnapshot(
      `butler::${scopeId}`,
      [{ role: 'assistant', content: 'late old snapshot' }],
      0,
      snapshotRoot,
    )
    assert.equal(lateOldSnapshot.ok, false)
    assert.match(lateOldSnapshot.error || '', /scope_session_snapshot_context_stale/)
    const restoredSnapshot = loadScopeSessionSnapshot(`butler::${scopeId}`, 1, snapshotRoot)
    assert.equal(restoredSnapshot.ok, true)
    if (restoredSnapshot.ok) {
      assert.deepEqual(restoredSnapshot.items, [{ role: 'assistant', content: 'new epoch snapshot' }])
      assert.ok(restoredSnapshot.updatedAt)
    }

    rememberLastReferenceSkill(scopeId, {
      id: 'late-old-skill',
      name: 'Late old skill',
      messageVisibilityEpoch: 0,
    })

    assert.throws(() => store.createConversationMessage(scopeId, {
      role: 'assistant',
      content: 'late old writer',
    }, 0), /visibility epoch mismatch/)
    assert.deepEqual(database.chat.getChatMessages(scopeId), [])
    assert.equal(
      'lastReferenceSkill' in JSON.parse(database.chat.getConversationScope(scopeId)!.meta_json || '{}'),
      false,
    )
    assert.equal(runMeta.update('old-provider-run', {
      status: 'done',
      lastMessageText: 'late provider result',
    }), null)
    assert.equal(runMeta.upsertTokens('old-provider-run', {
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
    }), null)
    const staleRun = runMeta.get('old-provider-run')
    assert.equal(staleRun?.status, 'running')
    assert.equal(staleRun?.lastMessageText, null)
    assert.equal(staleRun?.inputTokens, 0)
    assert.equal(staleRun?.outputTokens, 0)
    assert.equal(staleRun?.totalTokens, 0)

    assert.equal(getLastReferenceSkill(scopeId), null, 'a late old-run hint writer cannot re-arm the reset context')
    assert.deepEqual(activeNegations(scopeId, 0), [])
    assert.deepEqual(activeNegations(scopeId, 1), [])
    recordNegations(scopeId, ['external_send'], 0)
    assert.deepEqual(activeNegations(scopeId, 1), [])
    assert.equal(consumeLarkCliAuthCompletion({
      sessionId: scopeId,
      skillId: 'lark-cli',
      command: `lark-cli auth login --device-code "${oldLarkHandle}" --json`,
      executableAuthorityDigest: 'lark-authority',
      messageVisibilityEpoch: 1,
    }), null)
    assert.equal(rememberLarkCliAuthInitiation({
      sessionId: scopeId,
      skillId: 'lark-cli',
      command: larkCommand,
      output: createToolExecutionOutput('late authorization', {
        shape: 'json',
        data: {
          exitCode: 0,
          stdout: JSON.stringify({
            device_code: 'late-old-secret',
            verification_url: 'https://example.test/verify',
          }),
        },
      }),
      executableAuthorityDigest: 'lark-authority',
      messageVisibilityEpoch: 0,
    }), null)
    const currentLark = rememberLarkCliAuthInitiation({
      sessionId: scopeId,
      skillId: 'lark-cli',
      command: larkCommand,
      output: createToolExecutionOutput('current authorization', {
        shape: 'json',
        data: {
          exitCode: 0,
          stdout: JSON.stringify({
            device_code: 'current-device-secret',
            verification_url: 'https://example.test/verify',
          }),
        },
      }),
      executableAuthorityDigest: 'lark-authority',
      messageVisibilityEpoch: 1,
    })
    const currentLarkHandle = JSON.stringify(currentLark).match(/ready-lark-auth-[0-9a-f-]+/)?.[0]
    assert.ok(currentLarkHandle)
    assert.equal(consumeLarkCliAuthCompletion({
      sessionId: scopeId,
      skillId: 'lark-cli',
      command: `lark-cli auth login --device-code "${currentLarkHandle}" --json`,
      executableAuthorityDigest: 'lark-authority',
      messageVisibilityEpoch: 1,
    }), 'current-device-secret')

    recordNegations(scopeId, ['external_send'], 1)
    assert.deepEqual(activeNegations(scopeId, 1), ['external_send'])
    rememberLastReferenceSkill(scopeId, {
      id: 'new-skill',
      name: 'New skill',
      messageVisibilityEpoch: 1,
    })
    store.createConversationMessage(scopeId, {
      role: 'assistant',
      content: 'epoch one',
    }, 1)
    // Alias-only rollover (stop) does not change message visibility; another
    // writer frozen at the same epoch remains valid.
    store.createConversationMessage(scopeId, {
      role: 'assistant',
      content: 'same epoch after stop',
    }, 1)
    runMeta.create({
      runId: 'current-provider-run',
      taskId: 'current-provider-task',
      scopeId,
      messageVisibilityEpoch: 1,
      agentId: 'butler',
      status: 'running',
    })
    assert.equal(runMeta.update('current-provider-run', { status: 'done' })?.status, 'done')
    assert.equal(
      runMeta.upsertTokens('current-provider-run', { totalTokens: 3 })?.totalTokens,
      3,
    )

    assert.deepEqual(
      database.chat.getChatMessages(scopeId).map((message) => message.content),
      ['epoch one', 'same epoch after stop'],
    )
    assert.equal(
      (JSON.parse(database.chat.getConversationScope(scopeId)!.meta_json || '{}') as {
        lastReferenceSkill?: { id?: string }
      }).lastReferenceSkill?.id,
      'new-skill',
    )
  } finally {
    clearLastReferenceSkill(scopeId)
    __clearNegationStateForTests()
    clearLarkCliAuthFlowsForTests()
    __setScopeContextEpochDatabaseForTests(null)
    rmSync(snapshotRoot, { recursive: true, force: true })
    database.close()
  }
})
