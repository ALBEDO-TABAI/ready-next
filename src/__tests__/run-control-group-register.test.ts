// Stage V V2.1i — behavior test for `runControlGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// V2.1i extracts the 5 run-control channels from claude-bridge's
// `setupAgentIPC`:
//
//   agent:listActiveChildRuns    (snapshot of background child-runs)
//   agent:cancelChildRun         (cancel a background child-run by id)
//   agent:suspendRun             (pause a scope-run)
//   agent:resumeRun              (resume a paused scope-run via durable handle)
//   agent:respondToInteraction   (reply to an in-flight interaction request)
//
// The V5 IPC contract gate proves the channel literals still exist on the
// renderer side, but it cannot prove:
//
//   1. `register` wires EXACTLY the 5 channel names the group owns via
//      `ipcMain.handle` (no extras, no missing ones — all 5 are invoke /
//      async so they all live on the handle slot).
//   2. The returned dispose handle calls `removeHandler` for each of those
//      same 5 channels — so dev-reload re-registration and
//      `cleanupAgentRuntime` shutdown don't leak handler slots.
//
// Handler bodies are NOT exercised here — those are covered by pre-existing
// runtime tests and the V5 gate ensures the channel literal stays correct.
// The point of this file is the GROUP MECHANISM (register routing + dispose
// symmetry), not handler semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  runControlGroup,
  _runControlGroupChannelsForTest,
  type RunControlGroupDeps,
} from '../main/modules/claude-bridge/ipc/run-control-group'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface MockIpc {
  ipc: IpcMain
  handleCalls: Array<{ channel: string; handler: HandlerFn }>
  removeHandlerCalls: string[]
}

function createMockIpc(): MockIpc {
  const handleCalls: Array<{ channel: string; handler: HandlerFn }> = []
  const removeHandlerCalls: string[] = []
  // Mock just the two ipcMain methods the group touches; cast to IpcMain so
  // the group's call signatures still type-check. If the group grows a new
  // ipc surface (e.g. `ipcMain.on`) without updating this mock, the test
  // fails loudly via the missing-method TypeError — exactly the assertion
  // we want.
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handleCalls.push({ channel, handler })
    },
    removeHandler(channel: string) {
      removeHandlerCalls.push(channel)
    },
  } as unknown as IpcMain
  return { ipc, handleCalls, removeHandlerCalls }
}

function createMockDeps(): RunControlGroupDeps {
  // Behaviour test does not invoke handler bodies, so deps just need to
  // satisfy the type. Each function throws so an accidental call surfaces in
  // test output rather than silently returning undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    listActiveChildRuns: fail('listActiveChildRuns') as RunControlGroupDeps['listActiveChildRuns'],
    cancelChildRun: fail('cancelChildRun') as RunControlGroupDeps['cancelChildRun'],
    suspendRun: fail('suspendRun') as RunControlGroupDeps['suspendRun'],
    resumeRun: fail('resumeRun') as RunControlGroupDeps['resumeRun'],
    respondToInteraction: fail('respondToInteraction') as RunControlGroupDeps['respondToInteraction'],
  }
}

test('runControlGroup.register wires the 5 documented channels exactly once each via ipcMain.handle', () => {
  const { ipc, handleCalls } = createMockIpc()
  runControlGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._runControlGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 5 run-control channels',
  )
  assert.equal(handleCalls.length, 5, 'each channel must be registered exactly once')

  // Spot-check the exact channel literals per the plan (V2.1i, §3 V2.1) so
  // accidental renames trip this test even if the channel count happens to
  // still be 5. The V5 IPC contract gate catches the renderer side; this
  // pins the main-side literals.
  for (const required of [
    'agent:listActiveChildRuns',
    'agent:cancelChildRun',
    'agent:suspendRun',
    'agent:resumeRun',
    'agent:respondToInteraction',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('runControlGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.0 skeleton documents the namespace as a human label. We pin
  // it because the host (`ipc-handler.ts`) may later sort dispose calls or
  // log by namespace; renaming would silently break that ordering.
  assert.equal(runControlGroup.namespace, 'agent:runControl')
})

test('IpcDisposeHandle.dispose removes the same 5 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = runControlGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._runControlGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and stays bounded', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = runControlGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no handler-slot leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 5 removeHandler calls; total count grows by
  // exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _runControlGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
