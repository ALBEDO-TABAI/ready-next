'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-browser-task-status-publish-single-source.cjs')

const CAPABILITY_TYPES_REL = 'src/main/modules/browser-engine/capability-types.ts'
const TASK_EVENT_BRIDGE_REL = 'src/main/modules/browser-engine/task-event-bridge.ts'
const TASK_PERSISTENCE_REL = 'src/main/modules/browser-engine/task-persistence-service.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-task-status-publish-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function capabilityTypes(extra = '') {
  return `
export type BrowserCapabilityTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_human'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
${extra}

export interface BrowserCapabilityTaskHandle {
  taskId: string
  status: BrowserCapabilityTaskStatus
}
`
}

function taskEventBridge(mapBody = `
  queued: null,
  running: null,
  waiting_human: 'waiting_human',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: null,
`) {
  return `
import type { BrowserCapabilityTaskStatus } from './capability-types'

export type TaskEventBridgeStatus =
  | 'completed'
  | 'failed'
  | 'paused'
  | 'needs_attention'
  | 'waiting_human'

const BROWSER_TASK_BRIDGE_PUBLISH: Record<BrowserCapabilityTaskStatus, TaskEventBridgeStatus | null> = {
${mapBody}
}

export function toBridgeStatus(status: BrowserCapabilityTaskStatus): TaskEventBridgeStatus | null {
  return BROWSER_TASK_BRIDGE_PUBLISH[status]
}

export const taskEventBridge = {
  publish(_payload: { status: TaskEventBridgeStatus }): void {}
}
`
}

function persistenceSource(extra = '') {
  return `
import { taskEventBridge, toBridgeStatus } from './task-event-bridge'

export function updateProgress(status?: import('./capability-types').BrowserCapabilityTaskStatus): void {
  const bridgeStatus = status ? toBridgeStatus(status) : null
  ${extra}
  if (bridgeStatus) taskEventBridge.publish({ status: bridgeStatus })
}
`
}

function writePassingHarness(root) {
  write(root, CAPABILITY_TYPES_REL, capabilityTypes())
  write(root, TASK_EVENT_BRIDGE_REL, taskEventBridge())
  write(root, TASK_PERSISTENCE_REL, persistenceSource())
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

test('gate fails when a persisted status is missing from the publish map', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_EVENT_BRIDGE_REL, taskEventBridge(`
  queued: null,
  running: null,
  waiting_human: 'waiting_human',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
`))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('publish_map_missing_status:cancelled')))
})

test('gate fails when the publish map has an extra key', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_EVENT_BRIDGE_REL, taskEventBridge(`
  queued: null,
  running: null,
  waiting_human: 'waiting_human',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: null,
  stray: 'failed',
`))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('publish_map_extra_status:stray')))
})

test('gate fails when cancelled becomes a bridge publisher', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_EVENT_BRIDGE_REL, taskEventBridge(`
  queued: null,
  running: null,
  waiting_human: 'waiting_human',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
`))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('publish_map_unexpected_publisher:cancelled')))
})

test('gate fails when running becomes a bridge publisher', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_EVENT_BRIDGE_REL, taskEventBridge(`
  queued: null,
  running: 'paused',
  waiting_human: 'waiting_human',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: null,
`))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('publish_map_unexpected_publisher:running')))
})

test('gate fails when needs_attention leaks into persisted status', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, CAPABILITY_TYPES_REL, capabilityTypes("  | 'needs_attention'"))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('needs_attention_leaked_to_persisted')))
})

test('gate fails when a publish site bypasses toBridgeStatus', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_PERSISTENCE_REL, `
import { taskEventBridge } from './task-event-bridge'

export function updateProgress(status: 'completed'): void {
  taskEventBridge.publish({ status })
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('publish_site_missing_to_bridge_status')))
})
