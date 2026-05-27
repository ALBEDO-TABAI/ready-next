import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('legacy-tool-execute-bridge-removed declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'legacy-tool-execute-bridge-removed transitive sqlite guard')
})

/**
 * Stage U0.1 — behavior contract for the legacy `tool_execute` bridge
 * retirement.
 *
 * Background: `src/main/modules/claude-bridge/ipc-handler.ts` previously
 * contained an `agentManager.on('tool_execute', ...)` block whose
 * `calendar.createEvent` arm called `ipcMain.emit(...) || { success: true }`.
 * `ipcMain.emit` returns a boolean (listener-fired flag), not a handler
 * return value, so the calendar arm always claimed success even when the
 * event was never written. The bridge is now gone — every tool execution
 * flows through the Agent SDK runtime.
 *
 * What this test pins (real-entry behavior)
 * -----------------------------------------
 *   1. `AgentManager` (the real class, freshly constructed in mock mode) is
 *      never wired to a `tool_execute` listener and exposes a zero
 *      `listenerCount` for that channel — the legacy IPC bridge is gone at
 *      the source.
 *   2. The retired `feedToolResult` method is no longer on the instance.
 *   3. Driving `handleToolUse` indirectly (by feeding a synthetic
 *      `tool_use` block through `parseToolCalls`) produces only the
 *      renderer-facing `output` trace and emits zero `tool_execute`
 *      events. This is the real entry the deleted bridge sat behind.
 *
 * Structural regression (no source-grep here): the
 * `check-no-ipcmain-emit-truthy.cjs` gate (Stage U0.1) protects the file
 * shape against re-introduction of the calendar-style fake-success call.
 */

test('AgentManager never emits "tool_execute" on construction', async () => {
  const { AgentManager } = await import('../main/modules/claude-bridge/agent-manager')
  const manager = new AgentManager(true /* useMock */, 1000 /* short timeout */)
  try {
    const names = manager.eventNames()
    assert.ok(
      !names.includes('tool_execute'),
      `AgentManager should not bind any "tool_execute" listeners; found: ${JSON.stringify(names)}`,
    )
    // Defensive: emitting the legacy event must have no observable side
    // effect through the manager's public surface either.
    const listenerCount = manager.listenerCount('tool_execute')
    assert.equal(listenerCount, 0, 'no listeners should be attached to the retired channel')
  } finally {
    manager.cleanup()
  }
})

test('AgentManager no longer exposes feedToolResult', async () => {
  const mod = await import('../main/modules/claude-bridge/agent-manager')
  const manager = new mod.AgentManager(true, 1000)
  try {
    const desc = (manager as unknown as { feedToolResult?: unknown }).feedToolResult
    assert.equal(desc, undefined, 'feedToolResult must be retired alongside the tool_execute bridge')
  } finally {
    manager.cleanup()
  }
})

test('parsing a tool_use block from agent output emits only renderer-facing output', async () => {
  const { AgentManager } = await import('../main/modules/claude-bridge/agent-manager')
  const manager = new AgentManager(true, 1000)
  try {
    const events: Array<{ name: string; payload: unknown }> = []
    manager.on('tool_execute', (payload: unknown) => events.push({ name: 'tool_execute', payload }))
    manager.on('output', (payload: unknown) => events.push({ name: 'output', payload }))

    // The real entry: a tool_use block surfaced by Claude Code's stream-JSON
    // output. Pre-U0.1, this would have synthesised a `tool_execute` event
    // that the IPC handler converted into a fake success via `ipcMain.emit`.
    const TOOL_USE_TEXT = ':::tool_call\n{"tool":"calendar.createEvent","args":{"title":"x"}}\n:::'
    ;(manager as unknown as { parseToolCalls: (n: string, t: string) => void })
      .parseToolCalls('test-agent', TOOL_USE_TEXT)

    const toolExecuteEvents = events.filter((e) => e.name === 'tool_execute')
    assert.equal(
      toolExecuteEvents.length,
      0,
      `legacy "tool_execute" event must not fire; observed: ${JSON.stringify(toolExecuteEvents)}`,
    )
    const outputEvents = events.filter((e) => e.name === 'output')
    assert.ok(
      outputEvents.some((e) => {
        const p = e.payload as { type?: string } | null
        return p?.type === 'tool_use'
      }),
      `renderer-facing tool_use trace must still fire so the UI can show the call`,
    )
  } finally {
    manager.cleanup()
  }
})
