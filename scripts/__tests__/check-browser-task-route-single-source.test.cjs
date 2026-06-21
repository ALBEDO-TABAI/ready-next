'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-browser-task-route-single-source.cjs')

const CAPABILITY_TYPES_REL = 'src/main/modules/browser-engine/capability-types.ts'
const TASK_EVENT_BRIDGE_REL = 'src/main/modules/browser-engine/task-event-bridge.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-task-route-single-source-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writePassingHarness(root) {
  write(root, CAPABILITY_TYPES_REL, `
export const BROWSER_CAPABILITY_TASK_KINDS = [
  'download_urls',
  'scroll_collect',
  'research',
  'visible_collect',
  'note_collect',
  'card_loop',
] as const

export type BrowserCapabilityTaskKind = typeof BROWSER_CAPABILITY_TASK_KINDS[number]
export interface BrowserCapabilityTaskHandle {
  taskId: string
  kind: BrowserCapabilityTaskKind
}
`)
  write(root, TASK_EVENT_BRIDGE_REL, `
import {
  BROWSER_CAPABILITY_TASK_KINDS,
  type BrowserCapabilityTaskHandle,
  type BrowserCapabilityTaskKind,
} from './capability-types'

class TaskEventBridge {
  private readonly registeredRoutes = new Set<string>(BROWSER_CAPABILITY_TASK_KINDS)

  scheduleTask(taskId: string, routeKey: string): void {
    if (this.registeredRoutes.has(routeKey)) return
    throw new Error(taskId)
  }
}
`)
}

test('gate passes when browser task routes are a runtime single source', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate ignores route names mentioned in comments', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_EVENT_BRIDGE_REL, `
import { BROWSER_CAPABILITY_TASK_KINDS } from './capability-types'

/*
const DEFAULT_TASK_ROUTES = ['download_urls', 'research']
*/
class TaskEventBridge {
  private readonly registeredRoutes = new Set(BROWSER_CAPABILITY_TASK_KINDS)
}
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when capability types omit the route constant', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, CAPABILITY_TYPES_REL, `
export type BrowserCapabilityTaskKind = 'download_urls' | 'scroll_collect'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('missing_route_const')))
  assert.ok(result.errors.some((error) => error.includes('task_kind_type_not_derived')))
})

test('gate fails when BrowserCapabilityTaskKind is not derived from the route constant', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, CAPABILITY_TYPES_REL, `
export const BROWSER_CAPABILITY_TASK_KINDS = [
  'download_urls',
  'scroll_collect',
  'research',
  'visible_collect',
  'note_collect',
  'card_loop',
] as const

export type BrowserCapabilityTaskKind = 'download_urls' | 'scroll_collect' | 'research' | 'visible_collect' | 'note_collect' | 'card_loop'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('task_kind_type_not_derived')))
})

test('gate fails when the bridge keeps a copied route array', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_EVENT_BRIDGE_REL, `
import { BROWSER_CAPABILITY_TASK_KINDS } from './capability-types'

const DEFAULT_TASK_ROUTES = [
  'download_urls',
  'scroll_collect',
  'research',
]

class TaskEventBridge {
  private readonly registeredRoutes = new Set<string>(BROWSER_CAPABILITY_TASK_KINDS)
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('bridge_has_copied_route_list')))
})

test('gate fails when the bridge does not import the route constant', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TASK_EVENT_BRIDGE_REL, `
class TaskEventBridge {
  private readonly registeredRoutes = new Set<string>([])
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('bridge_missing_route_const_import')))
  assert.ok(result.errors.some((error) => error.includes('bridge_not_initialized_from_route_const')))
})

test('gate fails when a required route is missing from the constant', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, CAPABILITY_TYPES_REL, `
export const BROWSER_CAPABILITY_TASK_KINDS = [
  'download_urls',
  'scroll_collect',
  'research',
  'visible_collect',
  'note_collect',
] as const

export type BrowserCapabilityTaskKind = typeof BROWSER_CAPABILITY_TASK_KINDS[number]
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('route_const_missing:card_loop')))
})

test('gate fails when the route constant gains an unreviewed extra route', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, CAPABILITY_TYPES_REL, `
export const BROWSER_CAPABILITY_TASK_KINDS = [
  'download_urls',
  'scroll_collect',
  'research',
  'visible_collect',
  'note_collect',
  'card_loop',
  'unreviewed_route',
] as const

export type BrowserCapabilityTaskKind = typeof BROWSER_CAPABILITY_TASK_KINDS[number]
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('route_const_extra:unreviewed_route')))
})
