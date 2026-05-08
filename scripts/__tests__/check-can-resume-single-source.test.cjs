/**
 * Stage Q (Stage 11) — gate behavior tests for check-can-resume-single-source.cjs.
 *
 * Verifies the gate (a) passes on the real repo, (b) fails when fed
 * fixture trees containing duplicate exports / no exports / strings
 * that look like exports.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-can-resume-single-source.cjs')

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
}

function makeFixtureRoot(contents) {
  const root = mkdtempSync(join(tmpdir(), 'ready-q1-gate-'))
  for (const [rel, body] of Object.entries(contents)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

test('positive: real repo passes (export exactly once)', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
})

test('negative: no export anywhere fails', () => {
  const root = makeFixtureRoot({
    'src/main/modules/agent-control/foo.ts': 'export function unrelated() {}\n',
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /No export for canResumeShape/)
    assert.match(r.stderr, /No export for canResumeWithFs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: duplicate export of canResumeShape fails', () => {
  const root = makeFixtureRoot({
    'src/main/modules/agent-control/resume-handle.ts': [
      'export function canResumeShape() { return true }',
      'export function canResumeWithFs() { return true }',
      '',
    ].join('\n'),
    'src/main/modules/agent-control/copycat.ts': 'export function canResumeShape() { return false }\n',
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Multiple exports of canResumeShape/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("negative: 'export var canResumeShape' detected", () => {
  const root = makeFixtureRoot({
    'src/main/modules/agent-control/resume-handle.ts': [
      'export var canResumeShape = () => true',
      'export const canResumeWithFs = () => true',
      '',
    ].join('\n'),
    'src/main/modules/agent-control/sneaky.ts': 'export var canResumeShape = () => false\n',
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Multiple exports of canResumeShape/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("negative: multi-line 'export { ... }' detected", () => {
  const root = makeFixtureRoot({
    'src/main/modules/agent-control/resume-handle.ts': [
      'export function canResumeShape() { return true }',
      'export function canResumeWithFs() { return true }',
      '',
    ].join('\n'),
    'src/main/modules/agent-control/barrel.ts': [
      'function canResumeShape() { return false }',
      'export {',
      '  canResumeShape,',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Multiple exports of canResumeShape/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: a string literal containing "export function canResumeShape" is NOT a duplicate', () => {
  const root = makeFixtureRoot({
    'src/main/modules/agent-control/resume-handle.ts': [
      'export function canResumeShape() { return true }',
      'export function canResumeWithFs() { return true }',
      '',
    ].join('\n'),
    'src/main/modules/agent-control/quoted.ts': [
      'const banner = \'export function canResumeShape\'',
      'export function unrelated() { return banner }',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: comments mentioning canResumeShape are NOT a duplicate', () => {
  const root = makeFixtureRoot({
    'src/main/modules/agent-control/resume-handle.ts': [
      'export function canResumeShape() { return true }',
      'export function canResumeWithFs() { return true }',
      '',
    ].join('\n'),
    'src/main/modules/agent-control/commented.ts': [
      '// the helper exports canResumeShape and canResumeWithFs',
      '/* see export function canResumeShape */',
      'export function unrelated() {}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
