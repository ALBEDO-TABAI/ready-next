// Stage V V2.3d — behavior test for `workspaceGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirrors `document-file-mutation-group-register.test.ts` (V2.3c). Each
// document-engine channel cluster becomes an `IpcChannelGroup<Deps>` with
// its own per-group deps; this file pins the two pieces of the group
// contract that the V5 IPC contract gate cannot prove on its own:
//
//   1. `register` registers EXACTLY the 3 channel names the group owns
//      (no extras, no missing ones)
//   2. The returned dispose handle calls `removeHandler` for each of those
//      same 3 channels — so dev-reload re-registration does not leak
//      listeners.
//
// Handler bodies are NOT exercised here (the V5 gate confirms the channel
// literals still exist on both sides of the IPC boundary, and the inline
// behavior is fs/promises + dialog facades). The point of this file is the
// GROUP MECHANISM, not handler semantics.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  workspaceGroup,
  _workspaceGroupChannelsForTest,
  type WorkspaceGroupDeps,
} from '../main/modules/document-engine/ipc/workspace-group'

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
  // the group's call signatures still type-check. Anything else would throw,
  // which is exactly the assertion we want — the test fails loudly if the
  // group grows a new ipc surface without updating this mock.
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

function createMockDeps(): WorkspaceGroupDeps {
  // The 3 handler bodies touch resolveDialogWindow, the BrowserWindow
  // lookup, the two dialog facades, and the home-directory probe. The
  // mocks below are no-ops because this file only exercises the GROUP
  // MECHANISM (channel registration + dispose); accidental handler
  // invocation would surface as an assertion failure elsewhere.
  return {
    resolveDialogWindow: () => null,
    getBrowserWindowFromWebContents: (_sender: WebContents) => null,
    showSaveWorkspaceDialog: async (_win: BrowserWindow, _options) => ({ canceled: true }),
    showOpenWorkspaceFileDialog: async (_win: BrowserWindow, _options) => ({ canceled: true, filePaths: [] }),
    getHomeDirectory: () => '/tmp/ready-test-home',
  }
}

test('workspaceGroup.register wires the 3 documented channels exactly once each', () => {
  const { ipc, handleCalls } = createMockIpc()
  workspaceGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._workspaceGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 3 document workspace channels',
  )
  assert.equal(handleCalls.length, 3, 'each channel must be registered exactly once')

  // Spot-check the exact channel names per the plan (V2.3d, §3 V2.3) so
  // accidental renames trip this test even if the channel count happens
  // to still be 3. The V5 IPC contract gate catches the renderer side;
  // this pins the main-side literals.
  for (const required of [
    'document:exportWorkspace',
    'document:importWorkspace',
    'document:getHome',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('workspaceGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.3 skeleton documents the namespace as a human label. We
  // pin it because the host (`ipc-handler.ts`) may later sort dispose calls
  // or log by namespace; renaming would silently break that ordering.
  assert.equal(workspaceGroup.namespace, 'document:workspace')
})

test('IpcDisposeHandle.dispose removes the same 3 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = workspaceGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._workspaceGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and removes nothing the second time beyond electron no-op', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = workspaceGroup.register(ipc, createMockDeps())

  handle.dispose()
  const afterFirst = removeHandlerCalls.length
  // Electron's `removeHandler` is itself a no-op on missing channels; the
  // group's dispose loop wraps each call in try/catch, so a second
  // invocation must NOT throw. We allow the call to issue removeHandler
  // again — what we care about is no exception, no listener leak.
  assert.doesNotThrow(() => handle.dispose())
  // Second dispose runs the same 3 removeHandler calls; total count grows
  // by exactly the channel count, never more.
  assert.equal(
    removeHandlerCalls.length - afterFirst,
    _workspaceGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})
