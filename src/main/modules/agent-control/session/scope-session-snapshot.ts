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
import { readScopeContextEpoch } from './scope-context-epoch'

export interface ScopeSessionSnapshot {
  version: 2
  scope: string
  messageVisibilityEpoch: number
  items: unknown[]
  updatedAt: string
}

export type ScopeSessionSnapshotLoad =
  | { ok: true; items: unknown[]; updatedAt: string }
  | {
      ok: false
      reason:
        | 'missing'
        | 'corrupt'
        | 'context_epoch_mismatch'
        | 'legacy_context_epoch_missing'
    }

function safeScopeDirName(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'scope'
}

function publicScopeId(scope: string): string {
  const separator = scope.indexOf('::')
  return separator >= 0 ? scope.slice(separator + 2) : scope
}

export function scopeSessionSnapshotPath(scope: string, rootOverride?: string): string {
  const root = rootOverride || join(tmpdir(), 'ready-agent-continuations', 'scope-sessions')
  return join(root, safeScopeDirName(scope), 'session_snapshot.json')
}

export function writeScopeSessionSnapshot(
  scope: string,
  items: unknown[],
  messageVisibilityEpoch: number,
  rootOverride?: string,
): { ok: boolean; path: string; error?: string } {
  const path = scopeSessionSnapshotPath(scope, rootOverride)
  try {
    if (!Number.isSafeInteger(messageVisibilityEpoch) || messageVisibilityEpoch < 0) {
      throw new Error('scope_session_snapshot_message_visibility_epoch_invalid')
    }
    const durable = readScopeContextEpoch(publicScopeId(scope))
    if (
      durable.kind === 'closed'
      || durable.kind === 'unavailable'
      || (
        durable.kind === 'open'
        && durable.messageVisibilityEpoch !== messageVisibilityEpoch
      )
    ) {
      throw new Error('scope_session_snapshot_context_stale')
    }
    mkdirSync(join(path, '..'), { recursive: true })
    const snapshot: ScopeSessionSnapshot = {
      version: 2,
      scope,
      messageVisibilityEpoch,
      items,
      updatedAt: new Date().toISOString(),
    }
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8')
    renameSync(tmpPath, path)
    return { ok: true, path }
  } catch (error) {
    // silent-catch: write failure returns a structured {ok:false} with the message
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) }
  }
}

export function loadScopeSessionSnapshot(
  scope: string,
  expectedMessageVisibilityEpoch: number,
  rootOverride?: string,
): ScopeSessionSnapshotLoad {
  const path = scopeSessionSnapshotPath(scope, rootOverride)
  if (!Number.isSafeInteger(expectedMessageVisibilityEpoch) || expectedMessageVisibilityEpoch < 0) {
    clearScopeSessionSnapshot(scope, rootOverride)
    return { ok: false, reason: 'corrupt' }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // silent-catch: unreadable snapshot returns the structured 'missing' result
    return { ok: false, reason: 'missing' }
  }
  try {
    const parsed = JSON.parse(raw) as {
      version?: number
      scope?: string
      messageVisibilityEpoch?: number
      items?: unknown[]
      updatedAt?: string
    }
    if (parsed?.version === 1) {
      clearScopeSessionSnapshot(scope, rootOverride)
      return { ok: false, reason: 'legacy_context_epoch_missing' }
    }
    if (
      parsed?.version !== 2
      || parsed.scope !== scope
      || !Number.isSafeInteger(parsed.messageVisibilityEpoch)
      || Number(parsed.messageVisibilityEpoch) < 0
      || !Array.isArray(parsed.items)
    ) {
      clearScopeSessionSnapshot(scope, rootOverride)
      return { ok: false, reason: 'corrupt' }
    }
    if (parsed.messageVisibilityEpoch !== expectedMessageVisibilityEpoch) {
      clearScopeSessionSnapshot(scope, rootOverride)
      return { ok: false, reason: 'context_epoch_mismatch' }
    }
    return { ok: true, items: parsed.items, updatedAt: String(parsed.updatedAt || '') }
  } catch {
    // silent-catch: corrupt snapshot is cleared and returned as the structured 'corrupt' result
    clearScopeSessionSnapshot(scope, rootOverride)
    return { ok: false, reason: 'corrupt' }
  }
}

export function clearScopeSessionSnapshot(scope: string, rootOverride?: string): void {
  try {
    rmSync(join(scopeSessionSnapshotPath(scope, rootOverride), '..'), { recursive: true, force: true })
  } catch {
    // silent-catch: best-effort cleanup; the loader treats unreadable as missing
  }
}
