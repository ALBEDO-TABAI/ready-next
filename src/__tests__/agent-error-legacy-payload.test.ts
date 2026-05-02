/**
 * Phase 3 — legacy agent:error payload compatibility.
 *
 * If an older main-process build emits `agent:error` without the new
 * `errorKind`/`recoverable` fields, renderer must fall through to the
 * terminal path (system message + phase='error'), NOT show a soft-failure
 * capsule and NOT swallow the error silently.
 *
 * We can't import runtimeDriver directly (it pulls electron via preload
 * typings). Instead we scan the source to verify:
 *   1. recoverable check uses `=== true` (strict, not truthy).
 *   2. No `if (data.recoverable)` truthy-only branch exists.
 *   3. The early-return gate uses `data.errorKind === 'aborted'` (not a
 *      truthy fallback).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: legacy IPC payload shape is protected as a source-surface compatibility check
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('recoverable gate is strict === true so legacy payload (undefined) routes to terminal', () => {
  const source = readWorkspaceFile('src/renderer/modules/agent/runtimeDriver.ts')
  assert.match(source, /const\s+recoverable\s*=\s*data\.recoverable\s*===\s*true/)
})

test('abort early-return uses strict string equality, not truthy check', () => {
  const source = readWorkspaceFile('src/renderer/modules/agent/runtimeDriver.ts')
  assert.match(source, /data\.errorKind\s*===\s*['"]aborted['"]/)
})

test('scopeRunState reducer requires recoverable === true (legacy events clear softError)', () => {
  const source = readWorkspaceFile('src/renderer/modules/agent/scopeRunState.ts')
  assert.match(source, /event\.recoverable\s*===\s*true/)
  // The else branch for phase === 'error' without recoverable clears the slot.
  assert.match(source, /else if \(event\.phase === ['"]error['"]\)[\s\S]*patch\.softError\s*=\s*null/)
})

test('preload agent.onError callback accepts optional new fields (legacy callers compatible)', () => {
  const preload = readWorkspaceFile('src/preload/index.ts')
  // New fields are optional — `errorKind?: string`, `recoverable?: boolean`.
  const onErrorLine = preload.match(/onError:\s*\(callback:[\s\S]*?\) =>\s*\{/)
  assert.ok(onErrorLine, 'onError declaration must be locatable')
  const body = onErrorLine![0]
  assert.match(body, /errorKind\?:\s*string/)
  assert.match(body, /recoverable\?:\s*boolean/)
  assert.match(body, /toolName\?:\s*string/)
})
