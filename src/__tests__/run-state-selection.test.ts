import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { selectRunStateCandidate } from '../main/modules/agent-control/run-state-selection'

test('run_state selection does not treat a blank legacy task id as expected task match', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-selection-'))
  try {
    const path = join(root, 'run_state.json')
    writeFileSync(path, JSON.stringify({ status: 'running' }), 'utf8')

    const selected = selectRunStateCandidate({
      rootDir: root,
      expectedTaskId: 'dst-expected',
    })

    assert.equal(selected.path, null)
    assert.equal(selected.ambiguous, false)
    assert.equal(selected.candidates.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run_state selection verifies explicit paths unless they are marked trusted', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-explicit-'))
  try {
    const path = join(root, 'run_state.json')
    writeFileSync(path, JSON.stringify({ task_id: 'other-task', status: 'running' }), 'utf8')

    const untrusted = selectRunStateCandidate({
      rootDir: root,
      explicitRunStatePath: path,
      expectedTaskId: 'dst-expected',
    })
    assert.equal(untrusted.path, null)

    const trusted = selectRunStateCandidate({
      rootDir: root,
      explicitRunStatePath: path,
      expectedTaskId: 'dst-expected',
      trustExplicitRunStatePath: true,
    } as Parameters<typeof selectRunStateCandidate>[0] & { trustExplicitRunStatePath: true })
    assert.equal(trusted.path, path)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
