'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-browser-task-supervision-status-single-source.cjs')

const SHARED_REL = 'src/shared/browser-task-status.ts'
const IPC_REL = 'src/main/modules/browser-engine/ipc-supervision.ts'
const PERSISTENCE_REL = 'src/main/modules/browser-engine/task-persistence-service.ts'
const BROWSER_MODE_REL = 'src/renderer/pages/modes/BrowserMode.tsx'
const PANEL_REL = 'src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-task-supervision-status-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function shared(statuses = `
  'queued',
  'running',
  'paused',
  'waiting_human',
`) {
  return `
export const BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES = [
${statuses}
] as const

export function isBrowserSupervisionVisibleTaskStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES.includes(status as never)
}

export function browserTaskStatusLabel(status: string): string {
  if (status === 'waiting_human') return '等待确认'
  return '运行中'
}
`
}

function helperConsumer(extra = '') {
  return `
import { isBrowserSupervisionVisibleTaskStatus } from '../../../shared/browser-task-status'

export function visible(tasks: Array<{ status: string }>): Array<{ status: string }> {
  ${extra}
  return tasks.filter((task) => isBrowserSupervisionVisibleTaskStatus(task.status))
}
`
}

function persistence(statuses = "'queued', 'running', 'paused'") {
  return `
export class BrowserTaskPersistenceService {
  listPendingTasks() {
    return this.repository.listTasks([${statuses}])
  }
}
`
}

function writePassingHarness(root) {
  write(root, SHARED_REL, shared())
  write(root, IPC_REL, helperConsumer())
  write(root, BROWSER_MODE_REL, helperConsumer())
  write(root, PANEL_REL, helperConsumer())
  write(root, PERSISTENCE_REL, persistence())
}

test('gate passes for the real tree', () => {
  const result = check()
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate passes for a minimal valid fixture', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when waiting_human is removed from the shared visible set', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, SHARED_REL, shared(`
  'queued',
  'running',
  'paused',
`))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('supervision_visible_statuses_changed')))
})

test('gate fails when a supervision surface uses a hand-written active status list', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, BROWSER_MODE_REL, helperConsumer(`
  const bad = tasks.filter((task) => task.status === 'running' || task.status === 'queued' || task.status === 'paused')
  void bad
`))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes(`handwritten_supervision_visibility_rule:${BROWSER_MODE_REL}`)))
})

test('gate fails when main supervision IPC stops using the shared helper', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, IPC_REL, `
export function visible(tasks) {
  return tasks
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes(`supervision_visibility_helper_not_used:${IPC_REL}`)))
})

test('gate fails when startup pending tasks include waiting_human', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, PERSISTENCE_REL, persistence("'queued', 'running', 'paused', 'waiting_human'"))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('list_pending_tasks_must_not_auto_resume_waiting_human')))
})
