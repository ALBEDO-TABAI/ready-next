// Stage V V2.3g — behavior test for `widgetGroup.register` /
// `IpcDisposeHandle.dispose()`.
//
// Mirrors `document-watch-group-register.test.ts` (V2.3f), but the widget
// group's surface is `ipcMain.on` / `ipcMain.removeAllListeners` (the
// listener variant for fire-and-forget renderer → main pushes), not
// `ipcMain.handle` / `ipcMain.removeHandler`. The pattern reference for
// `.on` groups is `claude-bridge/ipc/tool-event-group.ts` (V2.1b).
//
// This file pins the two pieces of the group contract that the V5 IPC
// contract gate cannot prove on its own:
//
//   1. `register` subscribes to EXACTLY the 1 listener channel name the
//      group owns (no extras, no missing ones).
//   2. The returned dispose handle calls `removeAllListeners` for the
//      same channel — so dev-reload re-registration does not leak
//      listeners.
//   3. The handler invokes `deps.recordCommit(…)` with a normalized
//      payload (tabId / widgetId / committedAt / optional requestId)
//      when a valid payload arrives, and short-circuits on missing /
//      malformed payloads — pinning the verbatim move from
//      `ipc-handler.ts`.
//   4. The handler defaults `committedAt` to `Date.now()` when the
//      renderer omits it — same fallback the inline handler shipped
//      pre-extraction.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain } from 'electron'

import {
  widgetGroup,
  _widgetGroupListenerChannelsForTest,
  type WidgetGroupDeps,
} from '../main/modules/document-engine/ipc/widget-group'
import type { DocumentWidgetCommitEvent } from '../main/modules/document-engine/document-commit-registry'

type ListenerFn = (event: unknown, ...args: unknown[]) => void

interface MockIpc {
  ipc: IpcMain
  onCalls: Array<{ channel: string; listener: ListenerFn }>
  removeAllCalls: string[]
}

function createMockIpc(): MockIpc {
  const onCalls: Array<{ channel: string; listener: ListenerFn }> = []
  const removeAllCalls: string[] = []
  // Mock just the two ipcMain methods the group touches; cast to IpcMain so
  // the group's call signatures still type-check. Anything else (e.g. an
  // accidental `.handle`) would throw, which is exactly the assertion we
  // want — the test fails loudly if the group grows a new ipc surface
  // without updating this mock.
  const ipc = {
    on(channel: string, listener: ListenerFn) {
      onCalls.push({ channel, listener })
    },
    removeAllListeners(channel: string) {
      removeAllCalls.push(channel)
    },
  } as unknown as IpcMain
  return { ipc, onCalls, removeAllCalls }
}

function createCapturingDeps(): {
  deps: WidgetGroupDeps
  records: DocumentWidgetCommitEvent[]
} {
  const records: DocumentWidgetCommitEvent[] = []
  const deps: WidgetGroupDeps = {
    recordCommit(event) {
      records.push(event)
    },
  }
  return { deps, records }
}

test('widgetGroup.register subscribes to the 1 documented listener channel exactly once', () => {
  const { ipc, onCalls } = createMockIpc()
  const { deps } = createCapturingDeps()
  widgetGroup.register(ipc, deps)

  const registered = onCalls.map((entry) => entry.channel).sort()
  const expected = [..._widgetGroupListenerChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 1 document widget listener channel',
  )
  assert.equal(onCalls.length, 1, 'the listener channel must be registered exactly once')

  // Spot-check the exact channel name per the plan (V2.3g, §3 V2.3) so
  // accidental renames trip this test even if the channel count happens
  // to still be 1. The V5 IPC contract gate catches the renderer side
  // (preload `ipcRenderer.send('document:widgetCommitted', …)`); this
  // pins the main-side listener literal.
  assert.ok(
    registered.includes('document:widgetCommitted'),
    'expected channel "document:widgetCommitted" to be registered',
  )

  // Pin namespace alongside the channel assertion (folded into the
  // first test to keep the file at 4 tests per the deliverable spec).
  assert.equal(widgetGroup.namespace, 'document:widget')
})

test('IpcDisposeHandle.dispose removes the same listener channel that register added', () => {
  const { ipc, removeAllCalls } = createMockIpc()
  const { deps } = createCapturingDeps()
  const handle = widgetGroup.register(ipc, deps)

  // register clears prior listeners FIRST (defensive dev-reload
  // pre-clear); the test only cares about the dispose-time removals,
  // so snapshot the count and diff after dispose.
  const baselineRemoveCount = removeAllCalls.length

  handle.dispose()

  const removedDuringDispose = removeAllCalls.slice(baselineRemoveCount).sort()
  const expected = [..._widgetGroupListenerChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeAllListeners for every channel the group registered',
  )
})

test('handler invokes recordCommit with a normalized payload for valid renderer pushes', () => {
  const { ipc, onCalls } = createMockIpc()
  const { deps, records } = createCapturingDeps()
  widgetGroup.register(ipc, deps)

  const handler = onCalls.find((entry) => entry.channel === 'document:widgetCommitted')?.listener
  assert.ok(handler, 'register must wire a listener for document:widgetCommitted')

  // Valid push — all fields present.
  handler({} as unknown, {
    tabId: 'tab-1',
    widgetId: 'widget-7',
    requestId: 'req-42',
    committedAt: 1700000000000,
  })

  // Valid push — `requestId` omitted (it is optional in the payload
  // contract; the handler must forward `undefined` rather than fabricate
  // a value).
  handler({} as unknown, {
    tabId: 'tab-2',
    widgetId: 'widget-8',
    committedAt: 1700000001000,
  })

  assert.equal(records.length, 2, 'recordCommit must fire once per valid payload')
  assert.deepEqual(records[0], {
    tabId: 'tab-1',
    widgetId: 'widget-7',
    requestId: 'req-42',
    committedAt: 1700000000000,
  })
  assert.deepEqual(records[1], {
    tabId: 'tab-2',
    widgetId: 'widget-8',
    requestId: undefined,
    committedAt: 1700000001000,
  })
})

test('handler short-circuits on malformed payloads and defaults committedAt when missing', () => {
  const { ipc, onCalls } = createMockIpc()
  const { deps, records } = createCapturingDeps()
  widgetGroup.register(ipc, deps)

  const handler = onCalls.find((entry) => entry.channel === 'document:widgetCommitted')?.listener
  assert.ok(handler, 'register must wire a listener for document:widgetCommitted')

  // Malformed: null payload, non-object, missing tabId, missing widgetId.
  handler({} as unknown, null)
  handler({} as unknown, 'not-an-object')
  handler({} as unknown, { widgetId: 'widget-only' })
  handler({} as unknown, { tabId: 'tab-only' })
  handler({} as unknown, { tabId: '', widgetId: 'w' })

  assert.equal(records.length, 0, 'recordCommit must not fire for malformed payloads')

  // Valid payload with NO committedAt — handler must default to
  // Date.now() (the pre-extraction inline handler did exactly this; the
  // pipeline executor's commit-wait relies on a numeric timestamp).
  const before = Date.now()
  handler({} as unknown, { tabId: 'tab-x', widgetId: 'widget-y' })
  const after = Date.now()

  assert.equal(records.length, 1, 'a valid payload (even without committedAt) must record')
  const entry = records[0]
  assert.equal(entry.tabId, 'tab-x')
  assert.equal(entry.widgetId, 'widget-y')
  assert.equal(entry.requestId, undefined)
  assert.ok(
    typeof entry.committedAt === 'number'
      && entry.committedAt >= before
      && entry.committedAt <= after,
    'committedAt must default to Date.now() when the renderer omits it',
  )
})
