/**
 * Phase 3 — agent:error IPC contract (source-level).
 *
 * We can't import the main-process modules directly (electron pulls through
 * ipc-handler / direct-chat), so these assertions scan the source for the
 * shape of the wiring. They lock in:
 *
 *   - direct-chat.ts's emitRuntimeError derives AgentErrorContract and spreads
 *     it onto the emit('error', ...) payload.
 *   - turn-engine.ts's catch skips the red "API 请求失败" transcript line when
 *     the error is recoverable (to avoid duplicating the capsule).
 *   - ipc-handler.ts's scopeRunEvent error payload carries errorKind /
 *     recoverable / toolName for the renderer state-machine replay.
 *   - runtimeDriver.ts routes aborted early-return, recoverable → softError-only,
 *     and the recoverable branch does NOT call addMessage /
 *     persistAssistantMessageForRun / set toolTraceStatus='error'.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('direct-chat.emitRuntimeError derives contract and spreads to emit', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  assert.match(source, /from ['"]\.\/error-contract['"]/)
  assert.match(source, /deriveAgentErrorContract/)
  // Widened signature + spread into emit.
  assert.match(source, /emitRuntimeError\s*=\s*\(error:\s*unknown,\s*options\?:/)
  assert.match(source, /const\s+contract\s*=\s*deriveAgentErrorContract\(error,\s*options\)/)
  assert.match(source, /this\.emit\(['"]error['"],\s*\{[\s\S]*\.\.\.contract/)
})

test('direct-chat outer catch suppresses red transcript line for recoverable', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  // Catch block computes contract and gates emitOutput('API 请求失败', 'error').
  assert.match(
    source,
    /const\s+contract\s*=\s*deriveAgentErrorContract\(error\)[\s\S]*if\s*\(!contract\.recoverable\)[\s\S]*API 请求失败/,
  )
  // Emits the raw Error to emitRuntimeError (not the stringified message).
  assert.match(source, /emitRuntimeError\(error\)/)
})

test('turn-engine catch gates emitOutput on recoverable and passes Error to transcript', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  assert.match(source, /from ['"]\.\.\/claude-bridge\/error-contract['"]/)
  assert.match(
    source,
    /const\s+contract\s*=\s*deriveAgentErrorContract\(error\)[\s\S]*if\s*\(!contract\.recoverable\)[\s\S]*API 请求失败/,
  )
  assert.match(source, /transcript\.emitRuntimeError\(error\)/)
})

test('ipc-handler agent:scopeRunEvent error payload carries errorKind/recoverable/toolName', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  // Inside orchestrator.on('error', ...) the scopeRunEvent payload now forwards
  // the three new fields from the orchestrator data.
  const onErrorBlock = source.match(/orchestrator\.on\(['"]error['"],[\s\S]*?mainWindow\.webContents\.send\(['"]agent:scopeRunEvent['"][^)]*\)/)
  assert.ok(onErrorBlock, 'expected to find orchestrator.on("error") → agent:scopeRunEvent block')
  const body = onErrorBlock![0]
  assert.match(body, /errorKind:\s*data\.errorKind/)
  assert.match(body, /recoverable:\s*data\.recoverable/)
  assert.match(body, /toolName:\s*data\.toolName/)
})

test('runtimeDriver onError early-returns for errorKind=aborted', () => {
  const source = readWorkspaceFile('src/renderer/modules/agent/runtimeDriver.ts')
  assert.match(source, /data\.errorKind\s*===\s*['"]aborted['"][\s\S]{0,80}return/)
})

test('runtimeDriver recoverable branch writes softError only, skips addMessage/persist/toolTraceStatus', () => {
  const source = readWorkspaceFile('src/renderer/modules/agent/runtimeDriver.ts')
  // Locate the recoverable branch. It must set softError and then return before
  // the terminal block runs.
  const recoverableBlock = source.match(/if\s*\(recoverable\)\s*\{[\s\S]*?return\s*\n\s*\}/)
  assert.ok(recoverableBlock, 'expected `if (recoverable) { ... return }` block')
  const body = recoverableBlock![0]

  assert.match(body, /softError:\s*\{/)
  assert.match(body, /errorKind:\s*data\.errorKind/)
  // Must NOT touch these inside the recoverable branch.
  assert.doesNotMatch(body, /state\.addMessage\(/)
  assert.doesNotMatch(body, /persistAssistantMessageForRun\(/)
  assert.doesNotMatch(body, /toolTraceStatus:\s*['"]error['"]/)
})

test('runtimeDriver terminal branch clears stale softError', () => {
  const source = readWorkspaceFile('src/renderer/modules/agent/runtimeDriver.ts')
  // Terminal branch must include softError: null in the upsert payload.
  // We scope to the section after `// Terminal path` comment to the next
  // top-level function / event listener end.
  const terminalIdx = source.indexOf('Terminal path')
  assert.ok(terminalIdx > 0, 'expected a "Terminal path" marker in the onError handler')
  const terminalBlock = source.slice(terminalIdx, terminalIdx + 4000)
  assert.match(terminalBlock, /softError:\s*null/)
})

test('scopeRunState reducer derives softError from recoverable event flag', () => {
  const source = readWorkspaceFile('src/renderer/modules/agent/scopeRunState.ts')
  assert.match(
    source,
    /event\.phase\s*===\s*['"]error['"]\s*&&\s*event\.recoverable\s*===\s*true[\s\S]*patch\.softError\s*=\s*\{/,
  )
  // And clears it for terminal / legacy events.
  assert.match(source, /patch\.softError\s*=\s*null/)
})

test('ChatPanel mounts SoftFailureCapsule gated by currentScopeRunState.softError', () => {
  const source = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  assert.match(source, /from ['"]\.\/SoftFailureCapsule['"]/)
  assert.match(source, /<SoftFailureCapsule/)
  assert.match(source, /dismissSoftError\(currentScopeId\)/)
})
