// Behavior tests for structured scheduled-task IPC registration, disposal,
// and malformed-payload rejection. Runtime behavior is covered separately by
// the schedule coordinator, repository, queue, and execution suites.

import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  scheduleGroup,
  _scheduleGroupChannelsForTest,
  type ScheduleGroupDeps,
} from '../main/modules/claude-bridge/ipc/schedule-group'

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

function createMockDeps(): ScheduleGroupDeps {
  // Behaviour test does not invoke handler bodies, so deps just need to
  // satisfy the type. Each function throws so an accidental call surfaces in
  // test output rather than silently returning undefined.
  const fail = (label: string) => () => {
    throw new Error(`mock dep ${label} should not be called from registration test`)
  }
  return {
    list: fail('list') as ScheduleGroupDeps['list'],
    get: fail('get') as ScheduleGroupDeps['get'],
    preview: fail('preview') as ScheduleGroupDeps['preview'],
    create: fail('create') as ScheduleGroupDeps['create'],
    update: fail('update') as ScheduleGroupDeps['update'],
    runNow: fail('runNow') as ScheduleGroupDeps['runNow'],
    pause: fail('pause') as ScheduleGroupDeps['pause'],
    resume: fail('resume') as ScheduleGroupDeps['resume'],
    delete: fail('delete') as ScheduleGroupDeps['delete'],
    listOccurrences: fail('listOccurrences') as ScheduleGroupDeps['listOccurrences'],
    emitChanged: fail('emitChanged') as ScheduleGroupDeps['emitChanged'],
  }
}

test('scheduleGroup.register wires the 10 structured channels exactly once each via ipcMain.handle', () => {
  const { ipc, handleCalls } = createMockIpc()
  scheduleGroup.register(ipc, createMockDeps())

  const registered = handleCalls.map((entry) => entry.channel).sort()
  const expected = [..._scheduleGroupChannelsForTest].sort()
  assert.deepEqual(
    registered,
    expected,
    'register must subscribe to exactly the 10 schedule channels',
  )
  assert.equal(handleCalls.length, 10, 'each channel must be registered exactly once')

  // Spot-check the exact channel literals from the scheduled-task plan so
  // accidental renames trip this test even if the channel count happens to
  // stays unchanged. The IPC contract gate catches the renderer side; this
  // pins the main-side literals.
  for (const required of [
    'scheduledTasks:list',
    'scheduledTasks:get',
    'scheduledTasks:preview',
    'scheduledTasks:create',
    'scheduledTasks:update',
    'scheduledTasks:pause',
    'scheduledTasks:resume',
    'scheduledTasks:delete',
    'scheduledTasks:runNow',
    'scheduledTasks:listOccurrences',
  ]) {
    assert.ok(
      registered.includes(required),
      `expected channel "${required}" to be registered`,
    )
  }
})

test('scheduleGroup namespace is the documented label so dispose ordering can rely on it', () => {
  // The plan's V2.0 skeleton documents the namespace as a human label. We pin
  // it because the host (`ipc-handler.ts`) may later sort dispose calls or
  // log by namespace; renaming would silently break that ordering.
  assert.equal(scheduleGroup.namespace, 'scheduledTasks')
})

test('IpcDisposeHandle.dispose removes the same 10 channels that register added', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = scheduleGroup.register(ipc, createMockDeps())

  // register clears prior handlers FIRST (defensive dev-reload pre-clear);
  // the test only cares about the dispose-time removals, so snapshot the
  // count and diff after dispose.
  const baselineRemoveCount = removeHandlerCalls.length

  handle.dispose()

  const removedDuringDispose = removeHandlerCalls.slice(baselineRemoveCount).sort()
  const expected = [..._scheduleGroupChannelsForTest].sort()
  assert.deepEqual(
    removedDuringDispose,
    expected,
    'dispose must call removeHandler for every channel the group registered',
  )
})

test('dispose is idempotent — calling twice does not throw and stays bounded', () => {
  const { ipc, removeHandlerCalls } = createMockIpc()
  const handle = scheduleGroup.register(ipc, createMockDeps())

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
    _scheduleGroupChannelsForTest.length,
    'second dispose issues at most one removeHandler per channel',
  )
})

test('handlers reject malformed payloads with typed errors before calling runtime deps', async () => {
  const { ipc, handleCalls } = createMockIpc()
  scheduleGroup.register(ipc, createMockDeps())
  const preview = handleCalls.find((entry) => entry.channel === 'scheduledTasks:preview')!.handler
  const create = handleCalls.find((entry) => entry.channel === 'scheduledTasks:create')!.handler
  const event = {} as IpcMainInvokeEvent

  assert.deepEqual(await preview(event, null), {
    success: false,
    error: { kind: 'invalid_request', message: 'Schedule preview request is required' },
  })
  assert.deepEqual(await create(event, { name: 'missing fields' }), {
    success: false,
    error: { kind: 'invalid_request', message: 'Schedule request is invalid' },
  })
  const otherwiseValid = {
    name: 'Task', instruction: 'Do it',
    scheduleSpec: { kind: 'calendar', frequency: 'daily', localTime: '09:00' },
    timezone: 'UTC', agentId: 'butler', workspaceRoots: [], enabled: true,
    missedPolicy: 'coalesce_latest', scopeMode: 'dedicated',
  }
  assert.deepEqual(await create(event, { ...otherwiseValid, missedPolicy: 'run_everything' }), {
    success: false,
    error: { kind: 'invalid_request', message: 'Schedule request is invalid' },
  })
  assert.deepEqual(await create(event, { ...otherwiseValid, workspaceRoots: [42] }), {
    success: false,
    error: { kind: 'invalid_request', message: 'Schedule request is invalid' },
  })
})
