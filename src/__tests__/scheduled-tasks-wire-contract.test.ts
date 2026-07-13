import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ScheduleCreateRequest,
  SchedulePreviewRequest,
  ScheduleUpdateRequest,
  ScheduledTasksResponse,
} from '../shared/scheduled-tasks'

const root = process.cwd()

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8')
}

test('scheduled task mutations make the scope choice explicit', () => {
  const dedicated: ScheduleCreateRequest = {
    name: 'Daily brief',
    instruction: 'Prepare the daily brief',
    scheduleSpec: { kind: 'calendar', frequency: 'daily', localTime: '09:00' },
    timezone: 'Asia/Singapore',
    agentId: 'general',
    workspaceRoots: ['/workspace'],
    enabled: true,
    missedPolicy: 'coalesce_latest',
    scopeMode: 'dedicated',
  }
  const existing: ScheduleUpdateRequest = {
    ...dedicated,
    id: 'schedule-1',
    scopeMode: 'existing',
    scopeId: 'scope-1',
  }
  assert.equal(dedicated.scopeMode, 'dedicated')
  assert.equal(existing.scopeId, 'scope-1')
})

test('preview is independent of an execution scope and errors are typed', () => {
  const preview: SchedulePreviewRequest = {
    scheduleSpec: { kind: 'once', localDate: '2026-07-14', localTime: '09:00' },
    timezone: 'Asia/Singapore',
  }
  const response: ScheduledTasksResponse<never> = {
    success: false,
    error: { kind: 'invalid_time', message: 'The selected time is in the past' },
  }
  assert.equal('scopeId' in preview, false)
  assert.equal(response.error.kind, 'invalid_time')
})

test('preload exposes the complete readback API and invalidation-only event', () => {
  const preload = read('src/preload/index.ts')
  const channels = [
    'list',
    'get',
    'preview',
    'create',
    'update',
    'pause',
    'resume',
    'delete',
    'runNow',
    'listOccurrences',
  ]
  for (const channel of channels) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('scheduledTasks:${channel}'`))
  }
  assert.match(preload, /ipcRenderer\.on\('scheduledTasks:changed', handler\)/)
  assert.match(preload, /callback\(typeof scheduleId === 'string' \? scheduleId : undefined\)/)
})

test('legacy agent schedule bridge is no longer renderer-accessible', () => {
  const preload = read('src/preload/index.ts')
  const rendererTypes = read('src/renderer/types/electron.d.ts')
  const agentTypes = rendererTypes.slice(
    rendererTypes.indexOf('interface ElectronAgentAPI'),
    rendererTypes.indexOf('interface ElectronBrowserAPI'),
  )
  for (const method of [
    'listSchedules',
    'upsertSchedule',
    'runScheduleNow',
    'pauseSchedule',
    'resumeSchedule',
  ]) {
    assert.doesNotMatch(preload, new RegExp(`agent:${method}`))
    assert.doesNotMatch(agentTypes, new RegExp(`\\b${method}:`))
  }
  assert.doesNotMatch(preload, /agent:deleteSchedule/)
  assert.doesNotMatch(agentTypes, /\bdeleteSchedule:/)
  assert.doesNotMatch(rendererTypes, /interface AgentCronTaskData/)
})
