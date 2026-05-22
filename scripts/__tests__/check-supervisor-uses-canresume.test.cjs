/**
 * Stage Q (Stage 11) — gate behavior tests for
 * check-supervisor-uses-canresume.cjs.
 *
 * Verifies the gate (a) passes on the real repo,
 * (b) fails on fixtures that omit canResumeShape,
 * (c) passes on fixtures with canResumeShape inside both judgment functions,
 * (d) does NOT false-positive on string-literal mentions.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-supervisor-uses-canresume.cjs')

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
}

function makeFixtureRoot(supervisorBody) {
  const root = mkdtempSync(join(tmpdir(), 'ready-q-sup-gate-'))
  // skill-task-supervisor.ts lives under skills/ after the Stage U module
  // reshuffle; mirror the production layout so the gate finds the fixture.
  const dir = join(root, 'src/main/modules/agent-control/skills')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skill-task-supervisor.ts'), supervisorBody)
  return root
}

test('positive: real repo passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
})

test('positive: fixture with both functions calling canResumeShape passes', () => {
  const body = [
    "import { canResumeShape } from './resume-handle'",
    'function snapshotHasDurableHandle(snapshot: any): boolean {',
    '  return canResumeShape({ outputDir: snapshot.outputDir, runStatePath: snapshot.runStatePath })',
    '}',
    'function inspectSkillTask() {',
    '  const hasDurableResumeHandle = canResumeShape({ detachedTaskId: null, outputDir: null, runStatePath: null })',
    '  return hasDurableResumeHandle',
    '}',
    '',
  ].join('\n')
  const root = makeFixtureRoot(body)
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: snapshotHasDurableHandle without canResumeShape fails', () => {
  const body = [
    'function snapshotHasDurableHandle(snapshot: any): boolean {',
    '  return Boolean(snapshot.runStatePath || snapshot.outputDir || snapshot.taskRunId)',
    '}',
    'function inspectSkillTask() {',
    "  const hasDurableResumeHandle = canResumeShape({ outputDir: null, runStatePath: null })",
    '  return hasDurableResumeHandle',
    '}',
    '',
  ].join('\n')
  const root = makeFixtureRoot(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /snapshotHasDurableHandle does not call canResumeShape/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: hasDurableResumeHandle RHS without canResumeShape fails', () => {
  const body = [
    "import { canResumeShape } from './resume-handle'",
    'function snapshotHasDurableHandle(snapshot: any): boolean {',
    '  return canResumeShape({ outputDir: snapshot.outputDir, runStatePath: snapshot.runStatePath })',
    '}',
    'function inspectSkillTask() {',
    '  const hasDurableResumeHandle = Boolean(123)',
    '  return hasDurableResumeHandle',
    '}',
    '',
  ].join('\n')
  const root = makeFixtureRoot(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /hasDurableResumeHandle RHS does not call canResumeShape/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: comments/strings mentioning canResumeShape do NOT count as a real call', () => {
  // The gate checks for `canResumeShape\s*\(` inside FUNCTION BODY of
  // the comment/string-stripped projection. Strings that mention the
  // helper name should not count, but the gate's primary purpose is to
  // ensure the SECOND function (`hasDurableResumeHandle`) routes through
  // canResumeShape too — so a fixture where the first function is OK
  // but the second uses only a string mention should FAIL.
  const body = [
    "import { canResumeShape } from './resume-handle'",
    'function snapshotHasDurableHandle(snapshot: any): boolean {',
    '  return canResumeShape({ outputDir: snapshot.outputDir, runStatePath: snapshot.runStatePath })',
    '}',
    'function inspectSkillTask() {',
    "  const docs = 'see canResumeShape() docs'",
    '  const hasDurableResumeHandle = Boolean(docs)',
    '  return hasDurableResumeHandle',
    '}',
    '',
  ].join('\n')
  const root = makeFixtureRoot(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /hasDurableResumeHandle RHS does not call canResumeShape/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: multi-line RHS with brace-balanced expression still recognized', () => {
  const body = [
    "import { canResumeShape } from './resume-handle'",
    'function snapshotHasDurableHandle(snapshot: any): boolean {',
    '  return canResumeShape({ outputDir: snapshot.outputDir, runStatePath: snapshot.runStatePath })',
    '}',
    'function inspectSkillTask() {',
    '  const hasDurableResumeHandle = canResumeShape({',
    '    childRunId: null,',
    '    detachedTaskId: null,',
    '    outputDir: "/tmp",',
    '    runStatePath: "/tmp/run_state.json",',
    '  })',
    '  return hasDurableResumeHandle',
    '}',
    '',
  ].join('\n')
  const root = makeFixtureRoot(body)
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
