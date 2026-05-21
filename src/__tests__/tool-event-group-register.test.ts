// Stage V V2.1b — behavior test for `toolEventGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// V2.1b extracts two channels from claude-bridge's `setupAgentIPC`:
//
//   tools:logToolEvent              (fire-and-forget — `ipcMain.on`)
//   agent:completeToolActionRequest (renderer ack — `ipcMain.handle`)
//
// The V5 IPC contract gate proves the channel literals still exist on the
// renderer side, but it cannot prove:
//
//   1. `register` wires each channel via the CORRECT ipcMain method
//      (`on` for fire-and-forget, `handle` for invoke/Promise) — picking the
//      wrong one silently breaks the protocol because `ipcMain.on` and
//      `ipcMain.handle` have different listener slots.
//   2. The returned dispose handle releases BOTH the listener and the
//      handler slot via the matching tear-down call.
//
// Handler bodies are NOT exercised here — those are covered by the
// pre-existing renderer-tool-action integration tests + the V5 gate ensures
// the channel literal stays correct. The point of this file is the GROUP
// MECHANISM (register routing + dispose symmetry), not handler semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  toolEventGroup,
  _toolEventGroupHandleChannelsForTest,
  _toolEventGroupListenerChannelsForTest,
  type ToolEventGroupDeps,
} from '../main/modules/claude-bridge/ipc/tool-event-group'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type ListenerFn = (event: unknown, ...args: unknown[]) => void

interface MockIpc {
  ipc: IpcMain
  handleCalls: Array<{ channel: string; handler: HandlerFn }>
  onCalls: Array<{ channel: string; listener: ListenerFn }>
  removeHandlerCalls: string[]
  removeAllListenersCalls: string[]
}

function createMockIpc(): MockIpc {
  const handleCalls: Array<{ channel: string; handler: HandlerFn }> = []
  const onCalls: Array<{ channel: string; listener: ListenerFn }> = []
  const removeHandlerCalls: string[] = []
  const removeAllListenersCalls: string[] = []
  // Mock the four ipcMain methods the group touches; cast to IpcMain so the
  // group's call signatures still type-check. Anything else throws via the
  // Proxy fallback below, which is exactly the assertion we want — the test
  // fails loudly if the group grows a new ipc surface without updating this
  // mock.
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handleCalls.push({ channel, handler })
    },
    on(channel: string, listener: ListenerFn) {
      onCalls.push({ channel, listener })
    },
    removeHandler(channel: string) {
      removeHandlerCalls.push(channel)
    },
    removeAllListeners(channel: string) {
      removeAllListenersCalls.push(channel)
    },
  } as unknown as IpcMain
  return { ipc, handleCalls, onCalls, removeHandlerCalls, removeAllListenersCalls }
}

function createMockDeps(): ToolEventGroupDeps {
  // Behaviour test does not invoke handler bodies, so the Map can be empty
  // and the release closure can be a no-op. If the group's `register` itself
  // started calling these, the assertions below would surface it.
  return {
    pendingToolActionRequests: new Map(),
    releasePendingRequest: () => {
      /* no-op — handler bodies not exercised in this test */
    },
  }
}

test('toolEventGroup.register wires the 2 documented channels via the correct ipcMain method', () => {
  const { ipc, handleCalls, onCalls } = createMockIpc()
  toolEventGroup.register(ipc, createMockDeps())

  // `agent:completeToolActionRequest` is invoke/Promise — must register via
  // `ipcMain.handle`. `tools:logToolEvent` is fire-and-forget — must register
  // via `ipcMain.on`. Crossing the wires would silently break the protocol
  // because the renderer side picks `invoke` vs `send` based on the channel.
  const handled = handleCalls.map((entry) => entry.channel).sort()
  const listened = onCalls.map((entry) => entry.channel).sort()
  assert.deepEqual(handled, [..._toolEventGroupHandleChannelsForTest].sort(),
    'handle channels must be registered via ipcMain.handle')
  assert.deepEqual(listened, [..._toolEventGroupListenerChannelsForTest].sort(),
    'fire-and-forget channels must be registered via ipcMain.on')
  assert.equal(handleCalls.length, 1, 'agent:completeToolActionRequest registered exactly once')
  assert.equal(onCalls.length, 1, 'tools:logToolEvent registered exactly once')

  // Spot-check the exact channel literals per the plan (V2.1b, §3 V2.1) so an
  // accidental rename trips the test even if the counts happen to still match.
  assert.ok(handled.includes('agent:completeToolActionRequest'),
    'agent:completeToolActionRequest must be on the handle list')
  assert.ok(listened.includes('tools:logToolEvent'),
    'tools:logToolEvent must be on the listener list')
})

test('toolEventGroup namespace matches the documented label so dispose ordering can rely on it', () => {
  // Plan V2.0 documents namespace as a human label used for logs / dispose
  // ordering; renaming would silently break that ordering. Pin it.
  assert.equal(toolEventGroup.namespace, 'tools:logToolEvent+agent:completeToolActionRequest')
})

test('IpcDisposeHandle.dispose releases both the listener slot and the handler slot', () => {
  const { ipc, removeHandlerCalls, removeAllListenersCalls } = createMockIpc()
  const handle = toolEventGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // counts and diff after dispose. Using the matching tear-down for each
  // registration method is load-bearing — `removeAllListeners` is needed for
  // `on`-registered channels because `removeHandler` would no-op on them.
  const baselineHandle = removeHandlerCalls.length
  const baselineListener = removeAllListenersCalls.length

  handle.dispose()

  const removedHandlers = removeHandlerCalls.slice(baselineHandle).sort()
  const removedListeners = removeAllListenersCalls.slice(baselineListener).sort()
  assert.deepEqual(removedHandlers, [..._toolEventGroupHandleChannelsForTest].sort(),
    'dispose must call removeHandler for each handle-registered channel')
  assert.deepEqual(removedListeners, [..._toolEventGroupListenerChannelsForTest].sort(),
    'dispose must call removeAllListeners for each on-registered channel')
})

test('dispose is idempotent — calling twice does not throw', () => {
  const { ipc, removeHandlerCalls, removeAllListenersCalls } = createMockIpc()
  const handle = toolEventGroup.register(ipc, createMockDeps())

  handle.dispose()
  const handleCountAfterFirst = removeHandlerCalls.length
  const listenerCountAfterFirst = removeAllListenersCalls.length
  // Electron's `removeHandler` / `removeAllListeners` are themselves no-ops
  // on missing channels; the group's dispose loop wraps each call in
  // try/catch, so a second invocation must NOT throw. We allow the call to
  // re-issue removal — what we care about is no exception, no listener leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same removal pair; total counts grow by exactly
  // the channel counts, never more.
  assert.equal(
    removeHandlerCalls.length - handleCountAfterFirst,
    _toolEventGroupHandleChannelsForTest.length,
    'second dispose issues at most one removeHandler per handle channel',
  )
  assert.equal(
    removeAllListenersCalls.length - listenerCountAfterFirst,
    _toolEventGroupListenerChannelsForTest.length,
    'second dispose issues at most one removeAllListeners per listener channel',
  )
})
