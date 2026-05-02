import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decodeStoredSkillChildCloseEvent,
} from '../main/modules/agent-control/skill-child-state-machine'
import {
  mapSubAgentCloseToChildClose,
  SKILL_CHILD_CLOSE_EVENT_METADATA_KEY,
} from '../main/modules/agent-control/skill-child-sub-agent-close-mapping'
import type { SkillChildCloseEvent } from '../main/modules/agent-control/skill-child-run-types'

function makeCloseEvent(overrides: Partial<SkillChildCloseEvent> = {}): SkillChildCloseEvent {
  return {
    childRunId: 'child-1',
    skillId: 'skill-1',
    status: 'failed',
    terminalReason: 'failed_skill',
    outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json',
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      stage: 'inspect',
      totalUnits: 4,
      completedUnits: 2,
      coverageRatio: 0.5,
      fingerprint: 'abc123',
    },
    framePatch: {
      currentGoal: 'check immutability',
    },
    projectionPatch: {
      child: {
        status: 'failed',
      },
    },
    error: {
      kind: 'failed_skill',
      message: 'skill failed',
    },
    ...overrides,
  }
}

test('decoded close events are deeply frozen', () => {
  const close = decodeStoredSkillChildCloseEvent(makeCloseEvent())

  assert.equal(Object.isFrozen(close), true)
  assert.equal(Object.isFrozen(close.progress), true)
  assert.equal(Object.isFrozen(close.error), true)
  assert.equal(Object.isFrozen(close.framePatch), true)
  assert.equal(Object.isFrozen(close.projectionPatch), true)

  assert.throws(() => {
    close.progress.stage = 'mutated'
  }, TypeError)

  assert.equal(close.progress.stage, 'inspect')
})

test('mapped close events freeze nested runtime payloads', () => {
  const close = mapSubAgentCloseToChildClose({
    state: 'failed',
    terminalReason: 'failed_subagent',
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      stage: 'map',
      totalUnits: 3,
      completedUnits: 1,
      coverageRatio: 0.33,
      fingerprint: 'mapped',
    },
    framePatch: {
      currentGoal: 'map close',
    },
    projectionPatch: {
      nested: {
        value: 1,
      },
    },
    error: {
      kind: 'DriverInternalError',
      message: 'driver failed',
    },
    metadata: undefined,
  }, {
    childRunId: 'child-2',
    skillId: 'skill-2',
    outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json',
  })

  assert.equal(Object.isFrozen(close), true)
  assert.equal(Object.isFrozen(close.progress), true)
  assert.equal(Object.isFrozen(close.error), true)
  assert.equal(Object.isFrozen(close.framePatch), true)
  assert.equal(Object.isFrozen(close.projectionPatch), true)

  assert.throws(() => {
    ;(close.projectionPatch as { nested: { value: number } }).nested.value = 2
  }, TypeError)

  assert.deepEqual(close.projectionPatch, { nested: { value: 1 } })
})

test('preserved metadata close events are returned frozen', () => {
  const preserved = makeCloseEvent({
    childRunId: 'old-child',
    skillId: 'old-skill',
    status: 'completed',
    terminalReason: 'completed',
    error: null,
  })

  const close = mapSubAgentCloseToChildClose({
    state: 'completed',
    terminalReason: 'completed',
    outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json',
    progress: null,
    framePatch: null,
    projectionPatch: null,
    error: null,
    metadata: {
      [SKILL_CHILD_CLOSE_EVENT_METADATA_KEY]: preserved,
    },
  }, {
    childRunId: 'new-child',
    skillId: 'new-skill',
    outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json',
  })

  assert.equal(close.childRunId, 'new-child')
  assert.equal(close.skillId, 'new-skill')
  assert.equal(Object.isFrozen(close), true)
  assert.equal(Object.isFrozen(close.progress), true)
})

function assertCloseEventIsReadonly(close: SkillChildCloseEvent): void {
  // @ts-expect-error SkillChildCloseEvent is externally deep readonly.
  close.progress.stage = 'mutated'
}

void assertCloseEventIsReadonly
