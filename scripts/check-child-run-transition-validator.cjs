#!/usr/bin/env node
/**
 * Stage 6 deferred gate. Child-run status writes must pass through the
 * explicit transition validator before the coarse skill_task_runs row status
 * is mirrored.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const STATE_MACHINE_REL = 'src/main/modules/agent-control/skills/skill-child-state-machine.ts'
const REPOSITORY_REL = 'src/main/modules/repositories/skill-task-run-repository.ts'

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function fail(kind, detail) {
  console.error(`check-child-run-transition-validator: ${kind}: ${detail}`)
  process.exit(1)
}

function main() {
  if (!fs.existsSync(path.join(ROOT, STATE_MACHINE_REL))) {
    fail('state_machine_missing', `${STATE_MACHINE_REL} does not exist`)
  }
  if (!fs.existsSync(path.join(ROOT, REPOSITORY_REL))) {
    fail('repository_missing', `${REPOSITORY_REL} does not exist`)
  }

  const stateMachine = read(STATE_MACHINE_REL)
  if (!/export\s+class\s+SkillChildRunTransitionError\b/.test(stateMachine)) {
    fail('transition_error_missing', 'SkillChildRunTransitionError is not exported')
  }
  if (!/export\s+function\s+validateSkillChildRunTransition\s*\(/.test(stateMachine)) {
    fail('validator_missing', 'validateSkillChildRunTransition is not exported')
  }

  const repository = read(REPOSITORY_REL)
  if (!/validateSkillChildRunTransition/.test(repository)) {
    fail('repository_validator_missing', 'repository does not reference validateSkillChildRunTransition')
  }
  const updateStart = repository.indexOf('updateChildRun(childRunId: string')
  if (updateStart < 0) fail('update_child_run_missing', 'updateChildRun method not found')
  const updateBody = repository.slice(updateStart, repository.indexOf('this.updateRowInternal', updateStart))
  const validateIndex = updateBody.indexOf('validateSkillChildRunTransition(')
  const mapIndex = updateBody.indexOf('mapChildStatusToRowStatus(patch.status)')
  if (validateIndex < 0) {
    fail('validator_not_called', 'updateChildRun does not call validateSkillChildRunTransition')
  }
  if (mapIndex < 0) {
    fail('status_mirror_missing', 'updateChildRun no longer mirrors patch.status into row status')
  }
  if (validateIndex > mapIndex) {
    fail('validator_after_write', 'transition validator must run before row status mirroring')
  }

  console.log('check-child-run-transition-validator: ok')
}

main()
