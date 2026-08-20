import { statSync } from 'node:fs'

import type { CodexThread } from './codex-native-runtime'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import {
  CodexThreadArchiveIntentStore,
  type CodexThreadArchiveIntentRead,
} from './codex-thread-archive-cleanup'

export type CodexThreadArchiveListParams = {
  limit: number
  cwd: string
  sourceKinds: ['vscode']
  archived: boolean
  cursor: string | null
  useStateDbOnly: true
}

export interface CodexThreadArchiveCleanupRuntime {
  threadList(params: CodexThreadArchiveListParams): Promise<{
    data: CodexThread[]
    nextCursor: string | null
  }>
  threadRead(params: { threadId: string; includeTurns: true }): Promise<{ thread: CodexThread }>
  threadArchive(params: { threadId: string }): Promise<Record<string, never>>
}

type ListReadback = {
  pages: Array<{
    cursor: string | null
    data: CodexThread[]
    nextCursor: string | null
  }>
  threads: CodexThread[]
}

function sameThreadDirectory(left: string, right: string): boolean {
  if (left === right) return true
  if (process.platform !== 'darwin') return false
  try {
    const leftStat = statSync(left)
    const rightStat = statSync(right)
    return leftStat.isDirectory()
      && rightStat.isDirectory()
      && leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino
  } catch {
    return false
  }
}

function exactArchivedThread(intent: CodexThreadArchiveIntentRead, thread: CodexThread): boolean {
  return thread.id === intent.codexThreadId
    && thread.sessionId === intent.codexSessionId
    && sameThreadDirectory(thread.cwd, intent.isolatedThreadCwd)
    && thread.parentThreadId === null
    && thread.forkedFromId === null
    && thread.source === 'vscode'
    && thread.threadSource === null
    && thread.modelProvider === 'ready_gateway'
}

function archivableThread(thread: CodexThread): boolean {
  return (thread.status.type === 'idle' || thread.status.type === 'notLoaded')
    && !thread.turns.some((turn) => turn.status === 'inProgress')
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 160)
  return normalized || 'thread_archive_failed'
}

export class CodexThreadArchiveCleanupOwner {
  private inFlight: Promise<{ processed: number; acknowledged: number; pending: number }> | null = null
  private reconciliationInFlight: Promise<{
    processed: number
    acknowledged: number
    retryable: number
    unknown: number
  }> | null = null

  constructor(private readonly deps: {
    store: CodexThreadArchiveIntentStore
    runtime: CodexThreadArchiveCleanupRuntime
    getConnectionEpoch: () => string
    now: () => string
  }) {}

  drain(): Promise<{ processed: number; acknowledged: number; pending: number }> {
    if (this.inFlight) return this.inFlight
    const work = this.drainOnce().finally(() => {
      if (this.inFlight === work) this.inFlight = null
    })
    this.inFlight = work
    return work
  }

  reconcileForBoot(): Promise<{
    processed: number
    acknowledged: number
    retryable: number
    unknown: number
  }> {
    if (this.reconciliationInFlight) return this.reconciliationInFlight
    const work = this.reconcileForBootOnce().finally(() => {
      if (this.reconciliationInFlight === work) this.reconciliationInFlight = null
    })
    this.reconciliationInFlight = work
    return work
  }

  private async reconcileForBootOnce(): Promise<{
    processed: number
    acknowledged: number
    retryable: number
    unknown: number
  }> {
    const intents = this.deps.store.readOutstanding().filter(
      (intent) => intent.state === 'result_unknown',
    )
    let acknowledged = 0
    let retryable = 0
    let unknown = 0
    for (const intent of intents) {
      try {
        const result = await this.reconcileResultUnknown(intent)
        if (result === 'acknowledged') acknowledged += 1
        else if (result === 'retry') retryable += 1
        else unknown += 1
      } catch {
        unknown += 1
      }
    }
    return { processed: intents.length, acknowledged, retryable, unknown }
  }

  private async drainOnce(): Promise<{ processed: number; acknowledged: number; pending: number }> {
    const intents = this.deps.store.readOutstanding()
    let acknowledged = 0
    for (const intent of intents) {
      try {
        await this.processIntent(intent)
      } catch (error) {
        const current = this.deps.store.readByThreadId(intent.codexThreadId)
        if (current?.state === 'result_unknown') {
          try {
            this.deps.store.recordAttemptFailure({
              archiveIntentId: current.archiveIntentId,
              attemptCount: current.attemptCount,
              errorCode: errorCode(error),
              failedAt: this.deps.now(),
            })
          } catch {
            // The durable result_unknown row remains the recovery authority.
          }
        }
      }
      if (this.deps.store.readByThreadId(intent.codexThreadId)?.state === 'acknowledged') {
        acknowledged += 1
      }
    }
    return {
      processed: intents.length,
      acknowledged,
      pending: intents.length - acknowledged,
    }
  }

  private async processIntent(initial: CodexThreadArchiveIntentRead): Promise<void> {
    const current = this.deps.store.readByThreadId(initial.codexThreadId)
    if (!current || current.state === 'acknowledged') return
    if (current.state !== 'pending') return
    let readback: { thread: CodexThread }
    try {
      readback = await this.deps.runtime.threadRead({
        threadId: current.codexThreadId,
        includeTurns: true,
      })
    } catch {
      return
    }
    if (!exactArchivedThread(current, readback.thread) || !archivableThread(readback.thread)) {
      return
    }
    try {
      await this.deps.runtime.threadArchive({ threadId: current.codexThreadId })
    } catch (error) {
      const attempted = this.deps.store.readByThreadId(current.codexThreadId)
      if (attempted?.state === 'result_unknown') {
        this.deps.store.recordAttemptFailure({
          archiveIntentId: attempted.archiveIntentId,
          attemptCount: attempted.attemptCount,
          errorCode: errorCode(error),
          failedAt: this.deps.now(),
        })
      }
    }
  }

  private async reconcileResultUnknown(
    intent: CodexThreadArchiveIntentRead,
  ): Promise<'acknowledged' | 'retry' | 'unknown'> {
    const reconciliationConnectionEpoch = this.deps.getConnectionEpoch()
    if (intent.lastAttemptConnectionEpoch === reconciliationConnectionEpoch) return 'unknown'
    const archived = await this.listAll(intent, true)
    const archivedMatches = archived.threads.filter((thread) => thread.id === intent.codexThreadId)
    if (archivedMatches.length > 0) {
      if (archivedMatches.length !== 1 || !exactArchivedThread(intent, archivedMatches[0])) {
        return 'unknown'
      }
      const readback = await this.deps.runtime.threadRead({
        threadId: intent.codexThreadId,
        includeTurns: true,
      })
      if (!exactArchivedThread(intent, readback.thread) || !archivableThread(readback.thread)) {
        return 'unknown'
      }
      this.deps.store.acknowledge({
        archiveIntentId: intent.archiveIntentId,
        attemptCount: intent.attemptCount,
        kind: 'archived_readback',
        evidenceDigest: digestCanonicalJson({
          contract: 'codex_thread_archive_readback_ack_v1',
          archiveIntentDigest: intent.intentDigest,
          attemptCount: intent.attemptCount,
          reconciliationConnectionEpoch,
          archived,
          thread: readback.thread,
        }),
        acknowledgedAt: this.deps.now(),
      })
      return 'acknowledged'
    }

    const unarchived = await this.listAll(intent, false)
    const unarchivedMatches = unarchived.threads.filter(
      (thread) => thread.id === intent.codexThreadId,
    )
    if (unarchivedMatches.length !== 1 || !exactArchivedThread(intent, unarchivedMatches[0])) {
      return 'unknown'
    }
    const readback = await this.deps.runtime.threadRead({
      threadId: intent.codexThreadId,
      includeTurns: true,
    })
    if (!exactArchivedThread(intent, readback.thread) || !archivableThread(readback.thread)) {
      return 'unknown'
    }
    this.deps.store.recordUnarchivedReadback({
      archiveIntentId: intent.archiveIntentId,
      attemptCount: intent.attemptCount,
      reconciliationConnectionEpoch,
      evidenceDigest: digestCanonicalJson({
        contract: 'codex_thread_archive_absence_readback_v1',
        archiveIntentDigest: intent.intentDigest,
        attemptCount: intent.attemptCount,
        reconciliationConnectionEpoch,
        archived,
        unarchived,
        thread: readback.thread,
      }),
      reconciledAt: this.deps.now(),
    })
    return 'retry'
  }

  private async listAll(
    intent: CodexThreadArchiveIntentRead,
    archived: boolean,
  ): Promise<ListReadback> {
    const pages: ListReadback['pages'] = []
    const threads: CodexThread[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 32; page += 1) {
      const listed = await this.deps.runtime.threadList({
        limit: 100,
        cwd: intent.isolatedThreadCwd,
        sourceKinds: ['vscode'],
        archived,
        cursor,
        useStateDbOnly: true,
      })
      pages.push({ cursor, data: listed.data, nextCursor: listed.nextCursor })
      threads.push(...listed.data)
      if (listed.nextCursor === null) return { pages, threads }
      if (seenCursors.has(listed.nextCursor)) {
        throw new Error('codex_thread_archive_list_cursor_repeated')
      }
      seenCursors.add(listed.nextCursor)
      cursor = listed.nextCursor
    }
    throw new Error('codex_thread_archive_list_page_limit')
  }
}
