/**
 * EP2-K6 — truth-source boundary landing (approved sub-contract
 * docs/superpowers/plans/2026-06-12-EP2-K6-truth-source-boundary-implementation.md).
 *
 * file → DB, one direction only. Three sync points: write-time upsert (K2,
 * existing), the watcher here (user hand-edits), and the startup full sync
 * (K2 handover, wired here). The rollback switch stops injection, card-tool
 * exposure, and the watcher — files are NEVER touched (lossless rollback).
 */

import { watch, type FSWatcher } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { logAgentMetric } from '../metrics'
import { BeliefCardStore } from './belief-card-store'
import {
  hashCardContent,
  upsertBeliefCardMirror,
  getBeliefCardMirrorByRelPath,
  syncBeliefCards,
  type MirrorDb,
} from './belief-card-mirror'

export const KNOWLEDGE_SYSTEM_SETTING_KEY = 'agent.knowledgeSystemEnabled'

/** Single read entry for the rollback switch (sub-contract §3.4). Default ON;
 *  a missing repository (host-node tests, early boot) is also ON. */
export function isKnowledgeSystemEnabled(
  repository?: { getSetting(key: string): string | null | undefined } | null,
): boolean {
  if (!repository) return true
  try {
    return repository.getSetting(KNOWLEDGE_SYSTEM_SETTING_KEY) !== 'false'
  } catch {
    return true
  }
}


export type FileSyncResult = 'synced' | 'invalid' | 'recovered' | 'skipped'

/**
 * Incremental single-file sync (watcher path). content_hash short-circuit:
 * an unchanged card produces ZERO DB writes (A2). Broken frontmatter marks
 * the mirror row invalid — file kept, row kept (A3); a repaired file flips
 * it back with an audit row.
 */
export function syncBeliefCardFile(db: MirrorDb, store: BeliefCardStore, relPath: string): FileSyncResult {
  const abs = join(store.rootPath, relPath)
  if (!existsSync(abs)) return 'skipped' // deleted file: orphan rows belong to C1 marking, never deleted here
  const existing = getBeliefCardMirrorByRelPath(db, relPath)
  const card = store.readCard(relPath, { includeStaged: true })
  if (!card) {
    if (existing?.status === 'invalid') return 'skipped'
    upsertBeliefCardMirror(db, {
      relPath, title: relPath, summary: null, confidence: null, status: 'invalid', contentHash: null,
    })
    logAgentMetric('belief_card_invalid', { relPath, reason: 'frontmatter_parse_failed' })
    return 'invalid'
  }
  const contentHash = hashCardContent(card.frontmatter.title, card.frontmatter.description, card.body)
  if (existing && existing.content_hash === contentHash && existing.status === card.frontmatter.status) {
    return 'skipped'
  }
  upsertBeliefCardMirror(db, {
    relPath,
    title: card.frontmatter.title,
    summary: card.frontmatter.description,
    confidence: card.frontmatter.confidence,
    status: card.frontmatter.status,
    contentHash,
  })
  if (existing?.status === 'invalid') {
    logAgentMetric('belief_card_recovered', { relPath, status: card.frontmatter.status })
    return 'recovered'
  }
  return 'synced'
}

/**
 * Watcher over the knowledge dirs — additive listener pattern (watch-group
 * paradigm): fs.watch callbacks only enqueue; a debounced flush syncs the
 * pending set. Debounce is injectable so tests run at 0ms.
 */
export class KnowledgeWatcher {
  private watchers: FSWatcher[] = []
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: {
    db: MirrorDb
    store: BeliefCardStore
    debounceMs?: number
    onFlush?: (results: FileSyncResult[]) => void
  }) {}

  start(): void {
    if (this.watchers.length > 0) return
    for (const dir of ['knowledge', 'knowledge/sites']) {
      const abs = join(this.deps.store.rootPath, dir)
      if (!existsSync(abs)) continue
      try {
        const watcher = watch(abs, { persistent: false }, (_event, filename) => {
          if (!filename || !String(filename).endsWith('.md')) return
          this.enqueue(`${dir}/${String(filename)}`)
        })
        watcher.on('error', () => { /* watcher death degrades to startup/maintenance sync */ })
        this.watchers.push(watcher)
      } catch { /* missing dir / EPERM — startup sync still covers */ }
    }
  }

  /** Exposed for tests — same path the fs.watch callback takes. */
  enqueue(relPath: string): void {
    this.pending.add(relPath)
    if (this.timer) return
    this.timer = setTimeout(() => { this.flush() }, this.deps.debounceMs ?? 140)
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const batch = [...this.pending]
    this.pending.clear()
    const results = batch.map((relPath) => {
      try {
        return syncBeliefCardFile(this.deps.db, this.deps.store, relPath)
      } catch {
        return 'skipped' as FileSyncResult
      }
    })
    this.deps.onFlush?.(results)
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const watcher of this.watchers) {
      try { watcher.close() } catch { /* already closed */ }
    }
    this.watchers = []
  }
}

/**
 * Startup full sync (K2 handover). upsert/invalid only — never deletes
 * mirror rows (A6); failures are loud but never block boot.
 */
export function runStartupBeliefSync(
  db: MirrorDb,
  store: BeliefCardStore,
  enabled: boolean,
): { synced: number; invalid: number } | null {
  if (!enabled) return null
  try {
    const result = syncBeliefCards(db, store)
    logAgentMetric('belief_startup_sync', result)
    return result
  } catch (error) {
    console.error('[knowledge-truth-source] startup sync failed:', error)
    return null
  }
}
