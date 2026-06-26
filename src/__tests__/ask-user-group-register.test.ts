// Stage V V2.1a — behavior test for `askUserGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// The plan's V2.0 + V2.1 sub-stages extract claude-bridge's 1900+ LOC
// `setupAgentIPC` into per-group files. AskUserGroup is the first extraction;
// this test pins the two pieces of the group contract that the V5 IPC contract
// gate cannot prove on its own:
//
//   1. `register` registers EXACTLY the 6 channel names the group owns (no
//      extras, no missing ones)
//   2. The returned dispose handle calls `removeHandler` for each of those
//      same 6 channels — so dev-reload re-registration and
//      `cleanupAgentRuntime` shutdown don't leak listeners.
//
// We don't exercise the handler bodies here (those are covered by existing
// askUser tests + the V5 gate confirms the channel literals still exist).
// The point of this file is the GROUP MECHANISM, not handler semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  askUserGroup,
  _askUserGroupChannelsForTest,
  type AskUserGroupDeps,
} from '../main/modules/claude-bridge/ipc/ask-user-group'
import { EphemeralExecutionStore } from '../main/modules/tools/skill-primitives/ephemeral-execution-store'
import { AskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface MockIpc {
  ipc: IpcMain
  handleCalls: Array<{ channel: string; handler: HandlerFn }>
  removeHandlerCalls: string[]
}

function createMockIpc(): MockIpc {
  const handleCalls: Array<{ channel: string; handler: HandlerFn }> = []
  const removeHandlerCalls: string[] = []
  // Mock just the two ipcMain methods the group touches; cast to IpcMain so the
  // group's call signatures still type-check. Anything else would throw, which
  // is exactly the assertion we want — the test fails loudly if the group
  // grows a new ipc surface without updating this mock.
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

function createMockDeps(): AskUserGroupDeps {
  // The behaviour test does not invoke any handler bodies, so the deps just
  // need to satisfy the type. Each method throws so an accidental call is
  // visible in test output rather than silently returning undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    getDatabase: fail('getDatabase') as AskUserGroupDeps['getDatabase'],
    getEphemeralExecutionStore: fail('getEphemeralExecutionStore') as AskUserGroupDeps['getEphemeralExecutionStore'],
    getAskUserQuestionsStore: fail('getAskUserQuestionsStore') as AskUserGroupDeps['getAskUserQuestionsStore'],
    logAgentMetric: () => {
      /* no-op */
    },
    refreshActiveRunProgress: fail('refreshActiveRunProgress') as AskUserGroupDeps['refreshActiveRunProgress'],
  }
}

function getHandler(mock: MockIpc, channel: string): HandlerFn {
  const found = mock.handleCalls.find((entry) => entry.channel === channel)
  assert.ok(found, `expected handler for ${channel}`)
  return found.handler
}

test('askUserGroup.register wires the 6 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  askUserGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._askUserGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 6 askUser channels',
  )
  assert.equal(handleCalls.length, 6, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.1a, §3 V2.1; EP1-I3-2
  // added agent:frozenCall:respond) so accidental renames trip this test even
  // if the channel count happens to stay constant. The V5 IPC contract gate
  // catches the renderer side; this pins the main-side literals.
  for (const required of [
    'skills:askUser:submit',
    'skills:askUser:pending',
    'agent:askUserQuestions:submit',
    'agent:askUserQuestions:cancel',
    'agent:askUserQuestions:listPending',
    'agent:frozenCall:respond',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('askUserGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.0 skeleton documents the namespace as a human label. We pin
  // it because the host (`ipc-handler.ts`) may later sort dispose calls or log
  // by namespace; renaming would silently break that ordering.
  assert.equal(askUserGroup.namespace, 'agent:askUser+skills:askUser')
})

test('IpcDisposeHandle.dispose removes the same 6 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = askUserGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear); the
  // test only cares about the dispose-time removals, so snapshot the count and
  // diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._askUserGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = askUserGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second invocation
  // must NOT throw. We allow the call to issue removeHandler again — what we
  // care about is no exception, no listener leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 5 removeHandler calls; total count grows by
  // exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _askUserGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})

test('skills:askUser:submit refreshes the active run after resolving the pending question', async () => {
  const mock = createMockIpc()
  const store = new EphemeralExecutionStore()
  const timeoutHandle = setTimeout(() => {}, 60_000)
  const refreshed: Array<{ agent: string; sessionId: string | undefined; requestId?: string }> = []
  const answerPromise = new Promise<string>((resolve, reject) => {
    store.register({
      executionId: 'eau-refresh',
      sessionId: 'scope-A',
      scopeId: 'scope-A',
      agent: 'butler',
      requestId: 'req-A',
      skillId: 'skill-a',
      question: 'Need input?',
      options: null,
      placeholder: null,
      askedAt: Date.now(),
      resolve,
      reject,
      timeoutHandle,
    })
  })
  const deps = {
    ...createMockDeps(),
    getEphemeralExecutionStore: () => store,
    getAskUserQuestionsStore: () => new AskUserQuestionsStore(),
    refreshActiveRunProgress: (agent: string, sessionId: string | undefined, requestId?: string) => {
      refreshed.push({ agent, sessionId, requestId })
      return true
    },
  } satisfies AskUserGroupDeps
  askUserGroup.register(mock.ipc, deps)

  const result = await getHandler(mock, 'skills:askUser:submit')({} as never, {
    executionId: 'eau-refresh',
    answer: '好的',
  })

  assert.deepEqual(result, { success: true })
  assert.equal(await answerPromise, '好的')
  assert.deepEqual(refreshed, [{ agent: 'butler', sessionId: 'scope-A', requestId: 'req-A' }])
  clearTimeout(timeoutHandle)
})
