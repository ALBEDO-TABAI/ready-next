import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import {
  clearScopeSessionSnapshot,
  loadScopeSessionSnapshot,
  scopeSessionSnapshotPath,
  writeScopeSessionSnapshot,
} from '../main/modules/agent-control/session/scope-session-snapshot'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

beforeEach(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})

afterEach(() => {
  __setScopeContextEpochDatabaseForTests(null)
})

test('session-snapshot-lazy-restore declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'session-snapshot-lazy-restore transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

test('snapshot round trip, corrupt handling, and clearing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-scope-snap-'))
  try {
    const scope = 'butler::scope-rt'
    const written = writeScopeSessionSnapshot(scope, [{ role: 'user', content: 'hello' }], 0)
    // default root differs; use override for the deterministic part
    const writtenOverride = writeScopeSessionSnapshot(scope, [{ role: 'user', content: 'hello' }], 0, root)
    assert.equal(written.ok, true)
    assert.equal(writtenOverride.ok, true)

    const loaded = loadScopeSessionSnapshot(scope, 0, root)
    assert.equal(loaded.ok, true)
    if (loaded.ok) assert.equal(loaded.items.length, 1)

    writeFileSync(scopeSessionSnapshotPath(scope, root), '{ not json', 'utf8')
    const corrupt = loadScopeSessionSnapshot(scope, 0, root)
    assert.deepEqual(corrupt, { ok: false, reason: 'corrupt' })
    // corrupt load deletes the file → next load is missing
    assert.deepEqual(loadScopeSessionSnapshot(scope, 0, root), { ok: false, reason: 'missing' })

    clearScopeSessionSnapshot(scope)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scope snapshot restores only the exact message context epoch and rejects legacy v1', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-scope-snap-epoch-'))
  const scope = 'butler::scope-snapshot-epoch'
  try {
    const written = writeScopeSessionSnapshot(
      scope,
      [{ role: 'user', content: 'old-context-marker' }],
      0,
      root,
    )
    assert.equal(written.ok, true)
    const sameEpoch = loadScopeSessionSnapshot(scope, 0, root)
    assert.equal(sameEpoch.ok, true, 'stop keeps the same epoch restorable')

    assert.deepEqual(
      loadScopeSessionSnapshot(scope, 1, root),
      { ok: false, reason: 'context_epoch_mismatch' },
    )
    assert.deepEqual(loadScopeSessionSnapshot(scope, 1, root), { ok: false, reason: 'missing' })

    writeScopeSessionSnapshot(scope, [], 1, root)
    const path = scopeSessionSnapshotPath(scope, root)
    writeFileSync(path, JSON.stringify({
      version: 1,
      scope,
      items: [{ role: 'user', content: 'legacy-marker' }],
      updatedAt: new Date().toISOString(),
    }), 'utf8')
    assert.deepEqual(
      loadScopeSessionSnapshot(scope, 1, root),
      { ok: false, reason: 'legacy_context_epoch_missing' },
    )
    assert.deepEqual(loadScopeSessionSnapshot(scope, 1, root), { ok: false, reason: 'missing' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-main session memory resets on epoch advance but survives same-epoch stop rollover', async () => {
  const scope = `butler::scope-memory-epoch-${process.pid}`
  clearScopeSessionSnapshot(scope)
  const seen: string[] = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent: async ({ session }) => {
      seen.push(JSON.stringify(await (session as { getItems: () => Promise<unknown[]> }).getItems()))
      return { finalText: 'ok', toolTrace: [] }
    },
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)

  await runtime.sendMessage(scope, 'old-context-marker', 'run-memory-epoch-0a', {
    messageVisibilityEpoch: 0,
  })
  await ((runtime as any).sessionManager.get(scope).sdkSession as {
    addItems: (items: unknown[]) => Promise<void>
  }).addItems([{ role: 'user', content: 'old-context-marker' }])
  await runtime.sendMessage(scope, 'same-epoch-followup', 'run-memory-epoch-0b', {
    messageVisibilityEpoch: 0,
  })
  await runtime.sendMessage(scope, 'new-context-first-turn', 'run-memory-epoch-1', {
    messageVisibilityEpoch: 1,
  })

  assert.ok(seen[1]?.includes('old-context-marker'), 'same-epoch stop rollover keeps prior memory')
  assert.ok(!seen[2]?.includes('old-context-marker'), 'reset epoch cannot reuse old in-memory session')
  assert.ok(!seen[2]?.includes('same-epoch-followup'), 'reset epoch starts with no old session items')
  clearScopeSessionSnapshot(scope)
})

test('restart restore seeds the session and notifies the model', async () => {
  const scope = `butler::scope-restore-${process.pid}`
  clearScopeSessionSnapshot(scope)
  writeScopeSessionSnapshot(scope, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '之前我们在采集Henry的笔记' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成3/6篇' }] },
  ], 0)

  const inputs: string[] = []
  const sessionItemCounts: number[] = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent: async ({ input, session }) => {
      inputs.push(typeof input === 'string' ? input : JSON.stringify(input))
      const items = await (session as { getItems: () => Promise<unknown[]> }).getItems()
      sessionItemCounts.push(items.length)
      return { finalText: '继续中。', toolTrace: [] }
    },
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)

  // fresh runtime instance == restarted process: no in-memory session exists
  await runtime.sendMessage(scope, '继续', 'run-restore-1', {})

  assert.equal(inputs.length, 1)
  assert.ok(inputs[0].includes('已恢复上次会话上下文'), `expected restore notice, got: ${inputs[0].slice(0, 160)}`)
  assert.ok(sessionItemCounts[0] >= 2, `expected seeded session items, got ${sessionItemCounts[0]}`)
  clearScopeSessionSnapshot(scope)
})

test('restart restore normalizes snapshot seed without dropping latest user request', async () => {
  const scope = `butler::scope-restore-normalized-${process.pid}`
  const latestRequest = 'RESTORE_LATEST_USER_REQUEST'
  clearScopeSessionSnapshot(scope)
  writeScopeSessionSnapshot(scope, [
    { type: 'function_call', callId: 'orphan-call', name: 'lookup', arguments: '{}' },
    { type: 'function_call', callId: 'complete-call', name: 'lookup', arguments: '{}' },
    { type: 'function_call_result', callId: 'complete-call', name: 'lookup', status: 'completed', output: 'ok' },
    { role: 'user', content: latestRequest },
  ], 0)

  let seededItemsText = ''
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent: async ({ session }) => {
      const items = await (session as { getItems: () => Promise<unknown[]> }).getItems()
      seededItemsText = JSON.stringify(items)
      return { finalText: '继续中。', toolTrace: [] }
    },
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)

  await runtime.sendMessage(scope, '继续', 'run-restore-normalized-1', {})

  assert.ok(seededItemsText.includes(latestRequest))
  assert.ok(!seededItemsText.includes('orphan-call'))
  assert.ok(seededItemsText.includes('complete-call'))
  clearScopeSessionSnapshot(scope)
})

test('corrupt snapshot resets with an explicit notice', async () => {
  const scope = `butler::scope-corrupt-${process.pid}`
  clearScopeSessionSnapshot(scope)
  const written = writeScopeSessionSnapshot(scope, [], 0)
  assert.equal(written.ok, true)
  writeFileSync(scopeSessionSnapshotPath(scope), 'broken{{{', 'utf8')

  const inputs: string[] = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent: async ({ input }) => {
      inputs.push(typeof input === 'string' ? input : JSON.stringify(input))
      return { finalText: '好的。', toolTrace: [] }
    },
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)

  await runtime.sendMessage(scope, '你好', 'run-corrupt-1', {})
  assert.equal(inputs.length, 1)
  assert.ok(inputs[0].includes('会话已重置'), `expected reset notice, got: ${inputs[0].slice(0, 160)}`)
  clearScopeSessionSnapshot(scope)
})
