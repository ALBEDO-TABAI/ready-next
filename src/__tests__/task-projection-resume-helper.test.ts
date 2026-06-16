import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deriveTaskProjectionCanResume } from '../main/modules/agent-control/task-projection/task-projection-resume'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

const NOW = '2026-06-16T00:00:00.000Z'

function record(overrides: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: 'task-resume',
    scopeId: 'scope-resume',
    runId: 'run-resume',
    taskType: 'research',
    module: 'agent',
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'none',
    resumableActions: ['continue', 'cancel'],
    steps: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as TaskProjectionRecord
}

test('deriveTaskProjectionCanResume requires paused path-pair proof plus existing run_state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-projection-paused-'))
  const runStatePath = join(dir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify({ resumeKind: 'paused' }), 'utf8')
  try {
    const paused = deriveTaskProjectionCanResume(record({
      continuationRef: {
        taskId: 'task-resume',
        resumeKind: 'paused',
        outputDir: dir,
        runStatePath,
      },
    }))
    assert.equal(paused.canResume, true)

    const snapshot = deriveTaskProjectionCanResume(record({
      continuationRef: {
        taskId: 'task-resume',
        resumeKind: 'snapshot',
        outputDir: dir,
        runStatePath,
      },
    }))
    assert.equal(snapshot.canResume, false)

    const legacyPathPair = deriveTaskProjectionCanResume(record({
      continuationRef: {
        taskId: 'task-resume',
        outputDir: dir,
        runStatePath,
      },
    }))
    assert.equal(legacyPathPair.canResume, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deriveTaskProjectionCanResume does not require resumeKind for child and detached handles', () => {
  const child = deriveTaskProjectionCanResume(record({
    continuationRef: {
      taskId: 'task-resume',
      childRunId: 'child-1',
    },
  }))
  assert.equal(child.canResume, true)

  const detached = deriveTaskProjectionCanResume(record({
    continuationRef: {
      taskId: 'task-resume',
      detachedTaskId: 'detached-1',
    },
  }))
  assert.equal(detached.canResume, true)
})

test('deriveTaskProjectionCanResume trusts browser module canResume proof only', () => {
  const browserReady = deriveTaskProjectionCanResume(record({
    module: 'browser',
    canResume: true,
  }))
  assert.equal(browserReady.canResume, true)

  const browserNoProof = deriveTaskProjectionCanResume(record({
    module: 'browser',
    canResume: false,
  }))
  assert.equal(browserNoProof.canResume, false)
})
