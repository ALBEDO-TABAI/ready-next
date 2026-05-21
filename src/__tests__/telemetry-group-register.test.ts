// Stage V V2.1j — behavior test for `telemetryGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// V2.1j extracts the single telemetry channel from claude-bridge's
// `setupAgentIPC`:
//
//   agent:emitRendererMetric (whitelisted renderer metric event)
//
// The V5 IPC contract gate proves the channel literal still exists on the
// renderer side, but it cannot prove:
//
//   1. `register` wires EXACTLY the 1 channel name the group owns via
//      `ipcMain.handle` (no extras, no missing ones — the handler is invoke
//      so it lives on the handle slot).
//   2. The returned dispose handle calls `removeHandler` for that same
//      channel — so dev-reload re-registration and `cleanupAgentRuntime`
//      shutdown don't leak a handler slot.
//
// The handler body is NOT exercised here — the inline pre-extraction logic
// (`isRendererAgentMetricName` + `logAgentMetric`) is already covered by the
// agent-metrics test surface, and the V5 gate ensures the channel literal
// stays correct. The point of this file is the GROUP MECHANISM (register
// routing + dispose symmetry), not handler semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  telemetryGroup,
  _telemetryGroupChannelsForTest,
  type TelemetryGroupDeps,
} from '../main/modules/claude-bridge/ipc/telemetry-group'
import type { RendererAgentMetricName } from '../../shared/renderer-agent-metrics'

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

function createMockDeps(): TelemetryGroupDeps {
  // Behaviour test does not invoke handler bodies, so deps just need to
  // satisfy the type. Each function throws so an accidental call surfaces in
  // test output rather than silently returning undefined.
  return {
    isRendererAgentMetricName: ((_value: unknown): _value is RendererAgentMetricName => {
      throw new Error('mock dep isRendererAgentMetricName should not be called from registration test')
    }) as TelemetryGroupDeps['isRendererAgentMetricName'],
    logAgentMetric: ((_name: RendererAgentMetricName, _payload: Record<string, unknown>): void => {
      throw new Error('mock dep logAgentMetric should not be called from registration test')
    }) as TelemetryGroupDeps['logAgentMetric'],
  }
}

test('telemetryGroup.register wires the 1 documented channel exactly once via ipcMain.handle', () => {
  const { ipc, handleCalls } = createMockIpc()
  telemetryGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._telemetryGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 1 telemetry channel',
  )
  assert.equal(handleCalls.length, 1, 'the channel must be registered exactly once')

  // Spot-check the exact channel literal per the plan (V2.1j, §3 V2.1) so
  // an accidental rename trips this test even if the channel count happens
  // to still be 1. The V5 IPC contract gate catches the renderer side; this
  // pins the main-side literal.
  assert.ok(
    registered.includes('agent:emitRendererMetric'),
    'expected channel "agent:emitRendererMetric" to be registered',
  )
})

test('telemetryGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.0 skeleton documents the namespace as a human label. We pin
  // it because the host (`ipc-handler.ts`) may later sort dispose calls or
  // log by namespace; renaming would silently break that ordering.
  assert.equal(telemetryGroup.namespace, 'agent:telemetry')
})

test('IpcDisposeHandle.dispose removes the same 1 channel that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = telemetryGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._telemetryGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and stays bounded', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = telemetryGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no handler-slot leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same removeHandler calls; total count grows by
  // exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _telemetryGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
