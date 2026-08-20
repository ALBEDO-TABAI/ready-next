import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import type { CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import {
  CodexDurableThreadArchiveDispatchPort,
  CodexThreadArchiveIntentStore,
  recordCodexThreadArchiveIntentInOpenTransaction,
  type CodexThreadArchiveSourceKind,
  type CodexThreadRetirementReason,
} from '../main/modules/agent-control/codex-runtime/codex-thread-archive-cleanup'
import {
  CodexThreadArchiveCleanupOwner,
  type CodexThreadArchiveCleanupRuntime,
} from '../main/modules/agent-control/codex-runtime/codex-thread-archive-owner'
import {
  applyCodexThreadArchiveCleanupSchema,
} from '../main/modules/agent-control/codex-runtime/codex-thread-archive-schema'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type NativeDb = import('better-sqlite3').Database

const closedAt = '2026-08-12T01:00:00.000Z'
const retirementEvidenceDigest = 'a'.repeat(64)
const retirementTransactionDigest = 'b'.repeat(64)

function rootThread(): CodexThread {
  return {
    id: 'native-thread-1',
    sessionId: 'native-thread-1',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/tmp/ready-archive-alias-1',
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.146.1',
    createdAt: 1,
    ephemeral: false,
    preview: 'closed thread',
    status: { type: 'idle' },
    updatedAt: 2,
    turns: [{
      id: 'native-turn-1',
      status: 'completed',
      items: [],
      error: null,
    }],
  }
}

function installBaseSchema(db: NativeDb): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE codex_thread_bindings (
      thread_binding_id TEXT PRIMARY KEY,
      codex_thread_id TEXT UNIQUE,
      codex_session_id TEXT,
      isolated_thread_cwd TEXT UNIQUE,
      ready_conversation_alias TEXT NOT NULL,
      alias_generation INTEGER NOT NULL,
      retired_at TEXT,
      retired_reason TEXT,
      retirement_evidence_digest TEXT
    );
    CREATE TABLE codex_turn_bindings (
      ready_run_id TEXT PRIMARY KEY,
      thread_binding_id TEXT NOT NULL,
      product_terminal_digest TEXT,
      product_closeout_at TEXT
    );
  `)
  applyCodexThreadArchiveCleanupSchema(db as unknown as DatabaseConnection)
}

function insertRetiredBinding(db: NativeDb, input: {
  threadBindingId?: string
  threadId?: string
  aliasId?: string
  aliasGeneration?: number
  cwd?: string
  sourceKind?: CodexThreadArchiveSourceKind
  retiredReason?: CodexThreadRetirementReason
  readyRunId?: string | null
} = {}): void {
  const threadBindingId = input.threadBindingId || 'binding-1'
  const threadId = input.threadId || 'native-thread-1'
  const aliasId = input.aliasId || 'alias-1'
  const aliasGeneration = input.aliasGeneration || 1
  const cwd = input.cwd || '/tmp/ready-archive-alias-1'
  const sourceKind = input.sourceKind || 'idle_close'
  const retiredReason = input.retiredReason || 'closed'
  const readyRunId = input.readyRunId ?? null
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO codex_thread_bindings (
        thread_binding_id, codex_thread_id, codex_session_id, isolated_thread_cwd,
        ready_conversation_alias, alias_generation, retired_at, retired_reason,
        retirement_evidence_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadBindingId,
      threadId,
      threadId,
      cwd,
      aliasId,
      aliasGeneration,
      closedAt,
      retiredReason,
      retirementEvidenceDigest,
    )
    if (readyRunId) {
      db.prepare(`
        INSERT INTO codex_turn_bindings (
          ready_run_id, thread_binding_id, product_terminal_digest, product_closeout_at
        ) VALUES (?, ?, ?, ?)
      `).run(readyRunId, threadBindingId, 'c'.repeat(64), closedAt)
    }
    recordCodexThreadArchiveIntentInOpenTransaction(db as unknown as DatabaseConnection, {
      threadBindingId,
      codexThreadId: threadId,
      codexSessionId: threadId,
      isolatedThreadCwd: cwd,
      aliasId,
      aliasGeneration,
      sourceKind,
      retiredReason,
      readyRunId,
      retirementEvidenceDigest,
      retirementTransactionDigest,
      requestedAt: closedAt,
    })
    db.exec('COMMIT')
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function runtimeFixture(input: {
  archived: () => boolean
  onArchive: (threadId: string) => Promise<void>
  dispatchPort: CodexDurableThreadArchiveDispatchPort
  connectionEpoch: () => string
  thread?: CodexThread
  readThread?: (threadId: string) => CodexThread
  events?: string[]
}): CodexThreadArchiveCleanupRuntime {
  const thread = input.thread || rootThread()
  const events = input.events || []
  let rpcId = 0
  return {
    async threadList(params) {
      events.push(`list:${String(params.archived)}:${String(params.cursor)}`)
      const visible = params.archived === input.archived()
      return { data: visible ? [thread] : [], nextCursor: null }
    },
    async threadRead({ threadId }) {
      events.push(`read:${threadId}`)
      return { thread: input.readThread?.(threadId) || thread }
    },
    async threadArchive({ threadId }) {
      events.push(`archive:${threadId}`)
      rpcId += 1
      const connectionEpoch = input.connectionEpoch()
      const requestDigest = 'd'.repeat(64)
      const activation = await input.dispatchPort.activate({
        connectionEpoch,
        rpcId,
        codexThreadId: threadId,
        requestDigest,
      })
      await input.dispatchPort.markWriteAttempted({
        connectionEpoch,
        rpcId,
        archiveIntentId: activation.archiveIntentId,
      })
      await input.dispatchPort.markChildWriteConfirmed({
        connectionEpoch,
        rpcId,
        archiveIntentId: activation.archiveIntentId,
        childWriteDigest: requestDigest,
      })
      try {
        await input.onArchive(threadId)
      } catch (error) {
        await input.dispatchPort.markUnresolved({
          connectionEpoch,
          rpcId,
          archiveIntentId: activation.archiveIntentId,
          reason: 'connection_closed',
        })
        throw error
      }
      await input.dispatchPort.reconcileResponse({
        connectionEpoch,
        rpcId,
        archiveIntentId: activation.archiveIntentId,
        responseKind: 'accepted',
        responseDigest: 'e'.repeat(64),
      })
      return {}
    },
  }
}

test('close COMMIT survives a process crash and the next owner archives exactly once', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable thread archive restart')) return
  const Database = (await import('better-sqlite3')).default
  const dir = mkdtempSync(join(tmpdir(), 'ready-codex-archive-'))
  const dbPath = join(dir, 'ready.sqlite')
  try {
    const first = new Database(dbPath)
    installBaseSchema(first)
    insertRetiredBinding(first)
    assert.equal(new CodexThreadArchiveIntentStore(first as unknown as DatabaseConnection)
      .readOutstanding().length, 1)
    first.close()

    const restarted = new Database(dbPath)
    let archived = false
    let archiveCalls = 0
    const store = new CodexThreadArchiveIntentStore(restarted as unknown as DatabaseConnection)
    const connectionEpoch = 'connection-after-restart'
    const dispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => '2026-08-12T01:00:01.000Z',
    })
    const owner = new CodexThreadArchiveCleanupOwner({
      store,
      runtime: runtimeFixture({
        archived: () => archived,
        dispatchPort,
        connectionEpoch: () => connectionEpoch,
        async onArchive() {
          archiveCalls += 1
          archived = true
        },
      }),
      getConnectionEpoch: () => connectionEpoch,
      now: () => '2026-08-12T01:00:01.000Z',
    })
    const result = await owner.drain()
    assert.deepEqual(result, { processed: 1, acknowledged: 1, pending: 0 })
    assert.equal(archiveCalls, 1)
    assert.equal(store.readOutstanding().length, 0)
    assert.equal(store.readByThreadId('native-thread-1')?.acknowledgementKind, 'rpc_success')
    restarted.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('darwin cwd case aliases still identify the exact retired native thread', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable thread archive cwd case alias')) return
  if (process.platform !== 'darwin') {
    t.skip('darwin filesystem identity only')
    return
  }
  const Database = (await import('better-sqlite3')).default
  const dir = mkdtempSync(join(tmpdir(), 'ready-codex-archive-case-'))
  const intentCwd = join(dir, 'Ready', 'codex-threads', 'binding-case')
  const nativeCwd = join(dir, 'ready', 'codex-threads', 'binding-case')
  mkdirSync(intentCwd, { recursive: true })
  if (!existsSync(nativeCwd)) {
    rmSync(dir, { recursive: true, force: true })
    t.skip('case-sensitive macOS test volume')
    return
  }
  const db = new Database(':memory:')
  try {
    installBaseSchema(db)
    insertRetiredBinding(db, {
      threadBindingId: 'binding-case',
      threadId: 'native-case',
      aliasId: 'alias-case',
      cwd: intentCwd,
    })
    let archived = false
    let archiveCalls = 0
    const store = new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
    const connectionEpoch = 'connection-case'
    const dispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => '2026-08-12T01:00:02.000Z',
    })
    const thread = {
      ...rootThread(),
      id: 'native-case',
      sessionId: 'native-case',
      cwd: nativeCwd,
    }
    const owner = new CodexThreadArchiveCleanupOwner({
      store,
      runtime: runtimeFixture({
        archived: () => archived,
        thread,
        dispatchPort,
        connectionEpoch: () => connectionEpoch,
        async onArchive() {
          archiveCalls += 1
          archived = true
        },
      }),
      getConnectionEpoch: () => connectionEpoch,
      now: () => '2026-08-12T01:00:02.000Z',
    })
    assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 1, pending: 0 })
    assert.equal(archiveCalls, 1)
    assert.equal(store.readByThreadId('native-case')?.acknowledgementKind, 'rpc_success')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every irreversible native-thread retirement reason enters the same durable archive authority', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable retired thread archive coverage')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    installBaseSchema(db)
    insertRetiredBinding(db, {
      threadBindingId: 'binding-reset',
      threadId: 'native-reset',
      aliasId: 'alias-reset',
      cwd: '/tmp/ready-reset',
      sourceKind: 'idle_reset',
      retiredReason: 'user_reset',
    })
    insertRetiredBinding(db, {
      threadBindingId: 'binding-stop',
      threadId: 'native-stop',
      aliasId: 'alias-stop',
      cwd: '/tmp/ready-stop',
      sourceKind: 'engine_terminal_stop',
      retiredReason: 'publication_diverged',
      readyRunId: 'run-stop',
    })
    insertRetiredBinding(db, {
      threadBindingId: 'binding-manual',
      threadId: 'native-manual',
      aliasId: 'alias-manual',
      cwd: '/tmp/ready-manual',
      sourceKind: 'manual_compaction_quarantine',
      retiredReason: 'manual_compaction_quarantine',
    })
    insertRetiredBinding(db, {
      threadBindingId: 'binding-backfill',
      threadId: 'native-backfill',
      aliasId: 'alias-backfill',
      cwd: '/tmp/ready-backfill',
      sourceKind: 'retired_backfill',
      retiredReason: 'cleanup',
    })
    assert.deepEqual(
      new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
        .readOutstanding()
        .map((intent) => [intent.sourceKind, intent.retiredReason])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      [
        ['engine_terminal_stop', 'publication_diverged'],
        ['idle_reset', 'user_reset'],
        ['manual_compaction_quarantine', 'manual_compaction_quarantine'],
        ['retired_backfill', 'cleanup'],
      ],
    )
    assert.throws(() => insertRetiredBinding(db, {
      threadBindingId: 'binding-wrong',
      threadId: 'native-wrong',
      aliasId: 'alias-wrong',
      cwd: '/tmp/ready-wrong',
      sourceKind: 'idle_reset',
      retiredReason: 'closed',
    }), /codex_thread_archive_retirement_reason_mismatch/)
  } finally {
    db.close()
  }
})

test('a failed first archive is not retried on the same connection and is reconciled by a new sidecar generation', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable thread archive retry')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    installBaseSchema(db)
    insertRetiredBinding(db)
    let archived = false
    let archiveCalls = 0
    let connectionEpoch = 'connection-1'
    const events: string[] = []
    const store = new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
    const dispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => `2026-08-12T01:00:0${archiveCalls + 1}.000Z`,
    })
    const owner = new CodexThreadArchiveCleanupOwner({
      store,
      runtime: runtimeFixture({
        archived: () => archived,
        events,
        dispatchPort,
        connectionEpoch: () => connectionEpoch,
        async onArchive() {
          archiveCalls += 1
          if (archiveCalls === 1) throw new Error('connection_closed_after_write')
          archived = true
        },
      }),
      getConnectionEpoch: () => connectionEpoch,
      now: () => `2026-08-12T01:00:0${archiveCalls + 1}.000Z`,
    })
    assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 0, pending: 1 })
    assert.equal(store.readByThreadId('native-thread-1')?.state, 'result_unknown')
    assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 0, pending: 1 })
    assert.deepEqual(events, ['read:native-thread-1', 'archive:native-thread-1'])
    connectionEpoch = 'connection-2'
    assert.deepEqual(await owner.reconcileForBoot(), {
      processed: 1,
      acknowledged: 0,
      retryable: 1,
      unknown: 0,
    })
    assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 1, pending: 0 })
    assert.equal(archiveCalls, 2)
    assert.deepEqual(events, [
      'read:native-thread-1',
      'archive:native-thread-1',
      'list:true:null',
      'list:false:null',
      'read:native-thread-1',
      'read:native-thread-1',
      'archive:native-thread-1',
    ])
  } finally {
    db.close()
  }
})

test('an already archived result_unknown intent is acknowledged by readback without redispatch', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable thread archive readback')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    installBaseSchema(db)
    insertRetiredBinding(db)
    let archived = false
    let archiveCalls = 0
    let connectionEpoch = 'connection-1'
    const events: string[] = []
    const store = new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
    const dispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => `2026-08-12T01:00:0${archiveCalls + 1}.000Z`,
    })
    const owner = new CodexThreadArchiveCleanupOwner({
      store,
      runtime: runtimeFixture({
        archived: () => archived,
        events,
        dispatchPort,
        connectionEpoch: () => connectionEpoch,
        async onArchive() {
          archiveCalls += 1
          archived = true
          throw new Error('response_lost_after_archive')
        },
      }),
      getConnectionEpoch: () => connectionEpoch,
      now: () => `2026-08-12T01:00:0${archiveCalls + 1}.000Z`,
    })
    await owner.drain()
    assert.equal(store.readByThreadId('native-thread-1')?.state, 'result_unknown')
    await owner.drain()
    assert.deepEqual(events, ['read:native-thread-1', 'archive:native-thread-1'])
    connectionEpoch = 'connection-2'
    await owner.reconcileForBoot()
    assert.equal(archiveCalls, 1)
    assert.equal(store.readByThreadId('native-thread-1')?.acknowledgementKind, 'archived_readback')
    assert.deepEqual(events, [
      'read:native-thread-1',
      'archive:native-thread-1',
      'list:true:null',
      'read:native-thread-1',
    ])
  } finally {
    db.close()
  }
})

test('the same connection can settle result_unknown only from its exact archived notification', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable thread archive notification')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    installBaseSchema(db)
    insertRetiredBinding(db)
    const store = new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
    const port = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => '2026-08-12T01:00:01.000Z',
    })
    const activation = await port.activate({
      connectionEpoch: 'connection-1',
      rpcId: 41,
      codexThreadId: 'native-thread-1',
      requestDigest: 'd'.repeat(64),
    })
    await port.markWriteAttempted({
      connectionEpoch: 'connection-1',
      rpcId: 41,
      archiveIntentId: activation.archiveIntentId,
    })
    assert.equal(await port.reconcileArchivedNotification({
      connectionEpoch: 'wrong-connection',
      codexThreadId: 'native-thread-1',
      notificationDigest: 'f'.repeat(64),
    }), false)
    assert.equal(store.readByThreadId('native-thread-1')?.state, 'result_unknown')
    assert.equal(await port.reconcileArchivedNotification({
      connectionEpoch: 'connection-1',
      codexThreadId: 'native-thread-1',
      notificationDigest: 'f'.repeat(64),
    }), true)
    assert.equal(
      store.readByThreadId('native-thread-1')?.acknowledgementKind,
      'archived_notification',
    )
    await port.markChildWriteConfirmed({
      connectionEpoch: 'connection-1',
      rpcId: 41,
      archiveIntentId: activation.archiveIntentId,
      childWriteDigest: 'd'.repeat(64),
    })
    await port.reconcileResponse({
      connectionEpoch: 'connection-1',
      rpcId: 41,
      archiveIntentId: activation.archiveIntentId,
      responseKind: 'accepted',
      responseDigest: 'e'.repeat(64),
    })
    assert.equal(
      store.readByThreadId('native-thread-1')?.acknowledgementKind,
      'archived_notification',
    )
  } finally {
    db.close()
  }
})

test('archive dispatch accepts an exact unloaded terminal thread and never writes an active native thread', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable thread archive active preflight')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    installBaseSchema(db)
    insertRetiredBinding(db)
    const store = new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
    const dispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => '2026-08-12T01:00:01.000Z',
    })
    const events: string[] = []
    let readFailure = false
    let currentThread: CodexThread = {
      ...rootThread(),
      status: { type: 'active', activeFlags: [] },
      turns: [{ ...rootThread().turns[0], status: 'inProgress' }],
    }
    let archiveCalls = 0
    const owner = new CodexThreadArchiveCleanupOwner({
      store,
      runtime: runtimeFixture({
        archived: () => false,
        dispatchPort,
        connectionEpoch: () => 'connection-1',
        events,
        readThread() {
          if (readFailure) throw new Error('thread_read_failed')
          return currentThread
        },
        async onArchive() { archiveCalls += 1 },
      }),
      getConnectionEpoch: () => 'connection-1',
      now: () => '2026-08-12T01:00:01.000Z',
    })

    for (const blocked of [
      currentThread,
      { ...rootThread(), status: { type: 'systemError' as const } },
      { ...rootThread(), id: 'drifted-thread', sessionId: 'drifted-thread' },
      { ...rootThread(), turns: [{ ...rootThread().turns[0], status: 'inProgress' as const }] },
    ]) {
      currentThread = blocked
      assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 0, pending: 1 })
      const pending = store.readByThreadId('native-thread-1')
      assert.equal(pending?.state, 'pending')
      assert.equal(pending?.attemptCount, 0)
      assert.equal(archiveCalls, 0)
    }
    readFailure = true
    assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 0, pending: 1 })
    assert.equal(store.readByThreadId('native-thread-1')?.attemptCount, 0)
    assert.equal(archiveCalls, 0)

    readFailure = false
    currentThread = { ...rootThread(), status: { type: 'notLoaded' } }
    assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 1, pending: 0 })
    assert.equal(archiveCalls, 1)
    assert.equal(events.filter((event) => event === 'archive:native-thread-1').length, 1)
  } finally {
    db.close()
  }
})

test('a failed cleanup stays pending without blocking another alias or a second cleanup', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex durable thread archive alias isolation')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    installBaseSchema(db)
    insertRetiredBinding(db)
    insertRetiredBinding(db, {
      threadBindingId: 'binding-2',
      threadId: 'native-thread-2',
      aliasId: 'alias-2',
      aliasGeneration: 7,
      cwd: '/tmp/ready-archive-alias-2',
    })
    let otherAliasSent = false
    const store = new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
    const dispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => '2026-08-12T01:00:01.000Z',
    })
    let archiveCalls = 0
    const runtime = runtimeFixture({
      archived: () => false,
      dispatchPort,
      connectionEpoch: () => 'connection-1',
      readThread: (threadId) => threadId === 'native-thread-1'
        ? rootThread()
        : {
            ...rootThread(),
            id: 'native-thread-2',
            sessionId: 'native-thread-2',
            cwd: '/tmp/ready-archive-alias-2',
          },
      async onArchive(threadId) {
        archiveCalls += 1
        if (threadId === 'native-thread-1') throw new Error('first_alias_archive_failed')
      },
    })
    const owner = new CodexThreadArchiveCleanupOwner({
      store,
      runtime,
      getConnectionEpoch: () => 'connection-1',
      now: () => '2026-08-12T01:00:01.000Z',
    })
    const draining = owner.drain()
    await Promise.resolve().then(() => { otherAliasSent = true })
    const result = await draining
    assert.equal(otherAliasSent, true)
    assert.deepEqual(result, { processed: 2, acknowledged: 1, pending: 1 })
    assert.equal(store.readByThreadId('native-thread-1')?.state, 'result_unknown')
    assert.equal(store.readByThreadId('native-thread-2')?.state, 'acknowledged')
  } finally {
    db.close()
  }
})
