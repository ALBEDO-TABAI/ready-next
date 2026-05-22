'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-child-run-transition-validator.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-transition-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

const VALID_STATE_MACHINE = `
export class SkillChildRunTransitionError extends Error {}
export function validateSkillChildRunTransition(): void {}
`

const VALID_REPOSITORY = `
import { validateSkillChildRunTransition } from '../agent-control/skills/skill-child-state-machine'
class Repo {
  updateChildRun(childRunId: string, patch: any): void {
    if (patch.status !== undefined) {
      validateSkillChildRunTransition(currentChild.status, patch.status)
      updatePatch.status = mapChildStatusToRowStatus(patch.status)
    }
    this.updateRowInternal(childRunId, updatePatch, { allowStatus: true })
  }
}
`

function writeValidHarness(root) {
  writeFile(root, 'src/main/modules/agent-control/skills/skill-child-state-machine.ts', VALID_STATE_MACHINE)
  writeFile(root, 'src/main/modules/repositories/skill-task-run-repository.ts', VALID_REPOSITORY)
}

test('gate passes when repository validates before mirroring child status', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHarness(root)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /check-child-run-transition-validator: ok/)
})

test('gate fails when validator export is missing', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-child-state-machine.ts', `
export class SkillChildRunTransitionError extends Error {}
`)
  writeFile(root, 'src/main/modules/repositories/skill-task-run-repository.ts', VALID_REPOSITORY)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /validator_missing/)
})

test('gate fails when updateChildRun omits transition validation', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-child-state-machine.ts', VALID_STATE_MACHINE)
  writeFile(root, 'src/main/modules/repositories/skill-task-run-repository.ts', `
class Repo {
  updateChildRun(childRunId: string, patch: any): void {
    if (patch.status !== undefined) {
      updatePatch.status = mapChildStatusToRowStatus(patch.status)
    }
    this.updateRowInternal(childRunId, updatePatch, { allowStatus: true })
  }
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /repository_validator_missing|validator_not_called/)
})

test('gate fails when validation happens after row status mirroring', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-child-state-machine.ts', VALID_STATE_MACHINE)
  writeFile(root, 'src/main/modules/repositories/skill-task-run-repository.ts', `
class Repo {
  updateChildRun(childRunId: string, patch: any): void {
    if (patch.status !== undefined) {
      updatePatch.status = mapChildStatusToRowStatus(patch.status)
      validateSkillChildRunTransition(currentChild.status, patch.status)
    }
    this.updateRowInternal(childRunId, updatePatch, { allowStatus: true })
  }
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /validator_after_write/)
})
