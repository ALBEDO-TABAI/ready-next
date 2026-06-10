/**
 * S5-1 — durable per-scope session snapshot (C5.1).
 *
 * MemorySession is process-memory only: every main-process restart used to
 * erase all conversation context silently. This module persists a normalized
 * snapshot per scope at run close and lazily restores it on the first message
 * after a restart — with an explicit notice either way (restored vs reset),
 * never silent amnesia.
 *
 * Storage rides the same tmpdir state-directory family the budget
 * checkpoints use (`ready-agent-continuations/`), one directory per scope.
 * Snapshots are advisory cache, not ledger truth: corrupt files are deleted
 * and reported, not repaired.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ScopeSessionSnapshot {
  version: 1
  scope: string
  items: unknown[]
  updatedAt: string
}

export type ScopeSessionSnapshotLoad =
  | { ok: true; items: unknown[]; updatedAt: string }
  | { ok: false; reason: 'missing' | 'corrupt' }

function safeScopeDirName(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'scope'
}

export function scopeSessionSnapshotPath(scope: string, rootOverride?: string): string {
  const root = rootOverride || join(tmpdir(), 'ready-agent-continuations', 'scope-sessions')
  return join(root, safeScopeDirName(scope), 'session_snapshot.json')
}

export function writeScopeSessionSnapshot(
  scope: string,
  items: unknown[],
  rootOverride?: string,
): { ok: boolean; path: string; error?: string } {
  const path = scopeSessionSnapshotPath(scope, rootOverride)
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const snapshot: ScopeSessionSnapshot = {
      version: 1,
      scope,
      items,
      updatedAt: new Date().toISOString(),
    }
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8')
    renameSync(tmpPath, path)
    return { ok: true, path }
  } catch (error) {
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) }
  }
}

export function loadScopeSessionSnapshot(scope: string, rootOverride?: string): ScopeSessionSnapshotLoad {
  const path = scopeSessionSnapshotPath(scope, rootOverride)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ScopeSessionSnapshot>
    if (parsed?.version !== 1 || parsed.scope !== scope || !Array.isArray(parsed.items)) {
      clearScopeSessionSnapshot(scope, rootOverride)
      return { ok: false, reason: 'corrupt' }
    }
    return { ok: true, items: parsed.items, updatedAt: String(parsed.updatedAt || '') }
  } catch {
    clearScopeSessionSnapshot(scope, rootOverride)
    return { ok: false, reason: 'corrupt' }
  }
}

export function clearScopeSessionSnapshot(scope: string, rootOverride?: string): void {
  try {
    rmSync(join(scopeSessionSnapshotPath(scope, rootOverride), '..'), { recursive: true, force: true })
  } catch {
    // best-effort cleanup; the loader treats unreadable as missing
  }
}
