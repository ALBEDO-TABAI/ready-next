/**
 * Stage Q (Stage 11) — `canResumeShape` / `canResumeWithFs` contract tests.
 *
 * Covers Stage Q audit §2 (5 layers must consume one helper) and the
 * Stage Q implementation plan §3.1 contract that this helper is the
 * single source of "is this run resumable?"
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canResumeAsUserPoint,
  canResumeShape,
  canResumeWithFs,
  type FsExistenceProbe,
  type ResumeHandle,
} from '../main/modules/agent-control/contracts/resume-handle'

// ---------------------------------------------------------------------------
// canResumeShape — 6 truth quadrants
// ---------------------------------------------------------------------------

test('canResumeShape: null/undefined handle returns false', () => {
  assert.equal(canResumeShape(null), false)
  assert.equal(canResumeShape(undefined), false)
})

test('canResumeShape: empty handle returns false', () => {
  assert.equal(canResumeShape({}), false)
})

test('canResumeShape: childRunId alone qualifies', () => {
  assert.equal(canResumeShape({ childRunId: 'cr-abc123' }), true)
})

test('canResumeShape: detachedTaskId alone qualifies', () => {
  assert.equal(canResumeShape({ detachedTaskId: 'dt-xyz789' }), true)
})

test('canResumeShape: outputDir alone does NOT qualify (need runStatePath too)', () => {
  assert.equal(canResumeShape({ outputDir: '/tmp/run-1' }), false)
})

test('canResumeShape: runStatePath alone does NOT qualify (need outputDir too)', () => {
  assert.equal(canResumeShape({ runStatePath: '/tmp/run-1/run_state.json' }), false)
})

test('canResumeShape: both outputDir AND runStatePath qualifies', () => {
  assert.equal(canResumeShape({
    outputDir: '/tmp/run-1',
    runStatePath: '/tmp/run-1/run_state.json',
  }), true)
})

test('canResumeShape: taskRunId / skillId / taskId — NOT in ResumeHandle, ignored', () => {
  // Arbitrary extra fields not on ResumeHandle interface are simply not
  // checked. The audit's "lifecycle handle too wide" bug is closed by
  // the helper *not* accepting these.
  const wide = {
    taskRunId: 'tr-history-only',
    skillId: 'humanizer-zh',
    taskId: 'projection:abc',
  } as unknown as ResumeHandle
  assert.equal(canResumeShape(wide), false)
})

test('canResumeShape: empty/whitespace strings rejected', () => {
  assert.equal(canResumeShape({ childRunId: '' }), false)
  assert.equal(canResumeShape({ childRunId: '   ' }), false)
  assert.equal(canResumeShape({ outputDir: '/x', runStatePath: '' }), false)
  assert.equal(canResumeShape({ outputDir: '', runStatePath: '/x/r.json' }), false)
})

test('canResumeShape: explicit null fields rejected', () => {
  // ResumeHandle interface allows `string | null | undefined` per Stage Q
  // contract. Pin that nulls behave identically to absent fields.
  assert.equal(canResumeShape({
    childRunId: null,
    detachedTaskId: null,
    outputDir: null,
    runStatePath: null,
  }), false)
  assert.equal(canResumeShape({
    childRunId: null,
    detachedTaskId: 'dt-non-null',
  }), true)
  assert.equal(canResumeShape({
    outputDir: '/x',
    runStatePath: null,
  }), false)
})

// ---------------------------------------------------------------------------
// canResumeWithFs — fs-probe boundaries
// ---------------------------------------------------------------------------

function fakeProbe(map: Record<string, 'file' | 'dir' | 'absent'>): FsExistenceProbe {
  return {
    isFile(path: string): boolean {
      return map[path] === 'file'
    },
    isDirectory(path: string): boolean {
      return map[path] === 'dir'
    },
  }
}

test('canResumeWithFs: shape false short-circuits without fs probe', () => {
  let probedFile = false
  let probedDir = false
  const probe: FsExistenceProbe = {
    isFile() { probedFile = true; return false },
    isDirectory() { probedDir = true; return false },
  }
  assert.equal(canResumeWithFs(null, probe), false)
  assert.equal(canResumeWithFs({}, probe), false)
  assert.equal(canResumeWithFs({ outputDir: '/x' }, probe), false) // shape fails
  assert.equal(probedFile, false)
  assert.equal(probedDir, false)
})

test('canResumeWithFs: childRunId branch skips fs probe', () => {
  let probed = false
  const probe: FsExistenceProbe = {
    isFile() { probed = true; return false },
    isDirectory() { probed = true; return false },
  }
  assert.equal(canResumeWithFs({ childRunId: 'cr-abc' }, probe), true)
  assert.equal(probed, false)
})

test('canResumeWithFs: detachedTaskId branch skips fs probe', () => {
  let probed = false
  const probe: FsExistenceProbe = {
    isFile() { probed = true; return false },
    isDirectory() { probed = true; return false },
  }
  assert.equal(canResumeWithFs({ detachedTaskId: 'dt-xyz' }, probe), true)
  assert.equal(probed, false)
})

test('canResumeWithFs: path branch — both must resolve correctly', () => {
  const probe = fakeProbe({
    '/tmp/run-1': 'dir',
    '/tmp/run-1/run_state.json': 'file',
  })
  assert.equal(canResumeWithFs({
    outputDir: '/tmp/run-1',
    runStatePath: '/tmp/run-1/run_state.json',
  }, probe), true)
})

test('canResumeWithFs: path branch — outputDir is a file (not directory) returns false', () => {
  const probe = fakeProbe({
    '/tmp/run-1': 'file', // wrong type
    '/tmp/run-1/run_state.json': 'file',
  })
  assert.equal(canResumeWithFs({
    outputDir: '/tmp/run-1',
    runStatePath: '/tmp/run-1/run_state.json',
  }, probe), false)
})

test('canResumeWithFs: path branch — runStatePath is a directory (not file) returns false', () => {
  const probe = fakeProbe({
    '/tmp/run-1': 'dir',
    '/tmp/run-1/run_state.json': 'dir', // wrong type
  })
  assert.equal(canResumeWithFs({
    outputDir: '/tmp/run-1',
    runStatePath: '/tmp/run-1/run_state.json',
  }, probe), false)
})

test('canResumeWithFs: path branch — outputDir absent returns false', () => {
  const probe = fakeProbe({
    '/tmp/run-1/run_state.json': 'file',
  })
  assert.equal(canResumeWithFs({
    outputDir: '/tmp/run-1',
    runStatePath: '/tmp/run-1/run_state.json',
  }, probe), false)
})

test('canResumeWithFs: path branch — runStatePath absent returns false', () => {
  const probe = fakeProbe({
    '/tmp/run-1': 'dir',
  })
  assert.equal(canResumeWithFs({
    outputDir: '/tmp/run-1',
    runStatePath: '/tmp/run-1/run_state.json',
  }, probe), false)
})

test('canResumeWithFs: default probe uses node:fs.statSync (smoke)', () => {
  // No assertion on real fs — just ensure no crash with default probe
  // and a clearly-absent path.
  assert.equal(canResumeWithFs({
    outputDir: '/definitely/does/not/exist/q-stage',
    runStatePath: '/definitely/does/not/exist/q-stage/run_state.json',
  }), false)
})

test('canResumeAsUserPoint: path-pair requires paused resumeKind and fs proof', () => {
  const probe = fakeProbe({
    '/tmp/run-paused': 'dir',
    '/tmp/run-paused/run_state.json': 'file',
  })
  assert.equal(canResumeAsUserPoint({
    outputDir: '/tmp/run-paused',
    runStatePath: '/tmp/run-paused/run_state.json',
    resumeKind: 'paused',
  }, probe), true)
  assert.equal(canResumeAsUserPoint({
    outputDir: '/tmp/run-paused',
    runStatePath: '/tmp/run-paused/run_state.json',
    resumeKind: 'snapshot',
  }, probe), false)
  assert.equal(canResumeAsUserPoint({
    outputDir: '/tmp/run-paused',
    runStatePath: '/tmp/run-paused/run_state.json',
  }, probe), false)
})

test('canResumeAsUserPoint: path-pair paused still fails when run_state file vanished', () => {
  const probe = fakeProbe({
    '/tmp/run-paused': 'dir',
  })
  assert.equal(canResumeAsUserPoint({
    outputDir: '/tmp/run-paused',
    runStatePath: '/tmp/run-paused/run_state.json',
    resumeKind: 'paused',
  }, probe), false)
})

test('canResumeAsUserPoint: child and detached handles preserve existing lifecycle contract', () => {
  const probe: FsExistenceProbe = {
    isFile() { throw new Error('child/detached branch must not probe fs') },
    isDirectory() { throw new Error('child/detached branch must not probe fs') },
  }
  assert.equal(canResumeAsUserPoint({ childRunId: 'child-1' }, probe), true)
  assert.equal(canResumeAsUserPoint({ detachedTaskId: 'detached-1' }, probe), true)
  assert.equal(canResumeAsUserPoint({ childRunId: 'child-1', resumeKind: 'paused' }, probe), true)
  assert.equal(canResumeAsUserPoint({ childRunId: 'child-1', resumeKind: 'snapshot' }, probe), false)
})
