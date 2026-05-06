'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-close-event-factory.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeHelper(rootDir, body) {
  const helperPath = path.join(
    rootDir, 'src/main/modules/agent-control/skill-child-close-event-freeze.ts',
  )
  fs.mkdirSync(path.dirname(helperPath), { recursive: true })
  fs.writeFileSync(helperPath, body)
}

const VALID_HELPER = `
export class InvalidCloseEventError extends Error {}
export function validateSkillChildCloseInvariant(): void {}
export function freezeSkillChildCloseEvent(close: any) {
  validateSkillChildCloseInvariant()
  return close
}
`

test('L2 gate passes when helper is well-formed and no production literal bypass exists', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /check-close-event-factory: ok/)
})

test('L2 gate fails when validateSkillChildCloseInvariant is not called', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, `
export class InvalidCloseEventError extends Error {}
export function validateSkillChildCloseInvariant(): void {}
export function freezeSkillChildCloseEvent(close: any) { return close }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /validator_not_called/)
})

test('L2 gate fails when InvalidCloseEventError is not exported', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, `
export function validateSkillChildCloseInvariant(): void {}
export function freezeSkillChildCloseEvent(close: any) {
  validateSkillChildCloseInvariant()
  return close
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /InvalidCloseEventError not exported/)
})

test('L2 gate flags production literal assigned to SkillChildCloseEvent type', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  const offender = path.join(root, 'src/main/modules/agent-control/some-runner.ts')
  fs.mkdirSync(path.dirname(offender), { recursive: true })
  fs.writeFileSync(offender, `
import type { SkillChildCloseEvent } from './skill-child-run-types'
export function bad(): SkillChildCloseEvent {
  const event: SkillChildCloseEvent = {
    childRunId: 'x',
    skillId: 'y',
    status: 'completed',
    terminalReason: 'completed',
  } as any
  return event
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /literal_assignment_to_close_event/)
})

test('L2 gate ignores test files', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  const testFile = path.join(root, 'src/main/modules/agent-control/__tests__/foo.test.ts')
  fs.mkdirSync(path.dirname(testFile), { recursive: true })
  fs.writeFileSync(testFile, `const event: SkillChildCloseEvent = {}\n`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L2 gate accepts the sanctioned freezeSkillChildCloseEvent({...} as MutableSkillChildCloseEvent) shape', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  const caller = path.join(root, 'src/main/modules/agent-control/runner.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
import { freezeSkillChildCloseEvent } from './skill-child-close-event-freeze'
export function good() {
  return freezeSkillChildCloseEvent({
    childRunId: 'x',
    skillId: 'y',
    status: 'completed',
    terminalReason: 'completed',
  } as MutableSkillChildCloseEvent)
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
