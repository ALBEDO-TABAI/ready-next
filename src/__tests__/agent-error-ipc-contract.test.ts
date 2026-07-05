/**
 * Phase 3 — agent:error IPC contract (source-level).
 *
 * We can't import the main-process modules directly (electron pulls through
 * ipc-handler), so these assertions scan the source for the
 * shape of the wiring. They lock in:
 *
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
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: cross-process error IPC surface lacks a stable electron-free behavior harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

// 该合同随引擎退役（P6f dormant 边界 + Phase C C4，2026-07-05）：direct-chat.ts 已
// 删除，emitRuntimeError / outer-catch 两条引擎错误合同随之摘除（两条在本分支
// HEAD 即为既有红，随退役关账）。renderer 可见错误语义由下方 ipc-handler /
// runtimeDriver / scopeRunState / ChatPanel 断言继续钉住。

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
  // top-level function / event listener end. Window grown to 6000 in
  // Stage X2.4 after the always-fire (scope-keyed) unwind got an
  // explanatory comment block + the message-add branch was hoisted into
  // a separate conditional.
  const terminalIdx = source.indexOf('Terminal path')
  assert.ok(terminalIdx > 0, 'expected a "Terminal path" marker in the onError handler')
  const terminalBlock = source.slice(terminalIdx, terminalIdx + 6000)
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
  const source = readWorkspaceFile('src/renderer/components/agent/chat-panel/ChatPanelBody.tsx')
  assert.match(source, /from ['"]\.\.\/SoftFailureCapsule['"]/)
  assert.match(source, /<SoftFailureCapsule/)
  assert.match(source, /dismissSoftError\(currentScopeId\)/)
})
