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
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { logAgentMetric } from '../metrics'
import { BeliefCardStore, isSafeAgentScopeId } from './belief-card-store'
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
    // silent-catch: unreadable setting keeps the documented default-ON rollback semantics
    return true
  }
}


export type FileSyncResult = 'synced' | 'invalid' | 'recovered' | 'skipped'

export function scopeIdForBeliefCardPath(relPath: string): string {
  const match = relPath.replace(/\\/g, '/').match(/^agents\/([^/]+)\/knowledge(?:\/|$)/)
  return match && isSafeAgentScopeId(match[1]) ? `agent:${match[1]}` : 'global'
}

export function listKnowledgeWatchDirs(store: BeliefCardStore): string[] {
  const dirs: string[] = []
  const add = (relPath: string): void => {
    const abs = join(store.rootPath, relPath)
    if (existsSync(abs)) {
      try {
        if (statSync(abs).isDirectory()) dirs.push(relPath)
      } catch { /* silent-catch: race-deleted */ }
    }
  }
  add('knowledge')
  add('knowledge/sites')
  add('agents')
  const agentsAbs = join(store.rootPath, 'agents')
  if (!existsSync(agentsAbs)) return dirs
  for (const name of readdirSync(agentsAbs)) {
    if (!isSafeAgentScopeId(name)) continue
    const agentAbs = join(agentsAbs, name)
    let isDir = false
    try { isDir = statSync(agentAbs).isDirectory() } catch { /* silent-catch: race-deleted */ }
    if (!isDir) continue
    add(`agents/${name}`)
    add(`agents/${name}/knowledge`)
    add(`agents/${name}/knowledge/sites`)
  }
  return dirs
}

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
      relPath,
      scopeId: scopeIdForBeliefCardPath(relPath),
      title: relPath,
      summary: null,
      confidence: null,
      status: 'invalid',
      contentHash: null,
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
    scopeId: scopeIdForBeliefCardPath(relPath),
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
  private watchers = new Map<string, FSWatcher>()
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: {
    db: MirrorDb
    store: BeliefCardStore
    debounceMs?: number
    onFlush?: (results: FileSyncResult[]) => void
  }) {}

  start(): void {
    this.refreshWatchDirs()
  }

  refreshWatchDirs(): void {
    for (const dir of listKnowledgeWatchDirs(this.deps.store)) {
      if (this.watchers.has(dir)) continue
      const abs = join(this.deps.store.rootPath, dir)
      try {
        const watcher = watch(abs, { persistent: false }, (_event, filename) => {
          if (!filename) return
          const name = String(filename)
          if (name.endsWith('.md')) {
            this.enqueue(`${dir}/${name}`)
            return
          }
          this.refreshWatchDirs()
        })
        watcher.on('error', () => { /* watcher death degrades to startup/maintenance sync */ })
        this.watchers.set(dir, watcher)
      } catch { /* silent-catch: missing dir / EPERM — startup sync still covers */ }
    }
  }

  watchedDirsForTest(): string[] {
    return [...this.watchers.keys()].sort()
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
        // silent-catch: per-file sync failure is counted as 'skipped' in the onFlush results
        return 'skipped' as FileSyncResult
      }
    })
    this.deps.onFlush?.(results)
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const watcher of this.watchers.values()) {
      try { watcher.close() } catch { /* silent-catch: already closed */ }
    }
    this.watchers.clear()
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
