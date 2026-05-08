/**
 * Stage Q (Stage 11) — gate behavior tests for check-renderer-no-canresume-import.cjs.
 *
 * Verifies the gate (a) passes on the real repo, (b) fails when a
 * fixture renderer tree contains forbidden import / call shapes,
 * (c) does NOT false-positive on string-literal mentions of the
 * helper or commented-out code.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-renderer-no-canresume-import.cjs')

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
}

function makeFixtureRoot(contents) {
  const root = mkdtempSync(join(tmpdir(), 'ready-q2-gate-'))
  for (const [rel, body] of Object.entries(contents)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

test('positive: real repo passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
})

test('negative: static `from "...resume-handle"` import in renderer fails', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Foo.tsx': [
      "import { canResumeShape } from '../../main/modules/agent-control/resume-handle'",
      'export function Foo() { return null }',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /static import from 'resume-handle' module/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: cross-line dynamic `import(\\n"...resume-handle")` fails', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Bar.tsx': [
      'export async function Bar() {',
      '  const m = await import(',
      "    '../../main/modules/agent-control/resume-handle'",
      '  )',
      '  return m',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /dynamic import\('resume-handle'\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: cross-line `require(\\n"...resume-handle")` fails', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Baz.tsx': [
      'export function Baz() {',
      '  const m = require(',
      "    '../../main/modules/agent-control/resume-handle'",
      '  )',
      '  return m',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /require\('resume-handle'\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: direct `canResumeShape(...)` call in renderer fails', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Quux.tsx': [
      "// note: imported via barrel, but call still illegal",
      'export function Quux(handle: any) {',
      '  return canResumeShape(handle)',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /canResumeShape\(\) direct\/optional call/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: string literal containing the helper name does NOT fail', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Doc.tsx': [
      'const banner = \'canResumeShape(handle) — main side only\'',
      'export function Doc() { return banner }',
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

test('positive: comment mentioning resume-handle does NOT fail', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Note.tsx': [
      '// see ../../main/modules/agent-control/resume-handle for canResumeShape',
      '/* import canResumeWithFs from "resume-handle" — NOT actually imported */',
      'export function Note() { return null }',
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

// --------------------------------------------------------------------------
// Codex round 5 fixtures — additional evasion paths now covered.
// --------------------------------------------------------------------------

test("negative: backtick `import(\\`...resume-handle\\`)` fails", () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Bt1.tsx': [
      'export async function Bt1() {',
      '  const m = await import(`../../main/modules/agent-control/resume-handle`)',
      '  return m',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /dynamic import\('resume-handle'\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("negative: backtick `require(\\`...resume-handle\\`)` fails", () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Bt2.tsx': [
      'export function Bt2() {',
      '  const m = require(`../../main/modules/agent-control/resume-handle`)',
      '  return m',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /require\('resume-handle'\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: optional-chained `canResumeShape?.(handle)` fails', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Opt.tsx': [
      'export function Opt(handle: any, fn: any) {',
      '  return fn?.canResumeShape?.(handle)',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /canResumeShape\(\) direct\/optional call/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: `canResumeShape.call(null, handle)` fails', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Cb.tsx': [
      'export function Cb(handle: any, fn: any) {',
      '  return fn.canResumeShape.call(null, handle)',
      '}',
      '',
    ].join('\n'),
  })
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /canResumeShape\.call\/apply\/bind/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: full `import(\'...resume-handle\')` text inside a string literal does NOT fail', () => {
  const root = makeFixtureRoot({
    'src/renderer/components/Doc2.tsx': [
      "const docs = \"import('../../main/modules/agent-control/resume-handle')\"",
      "const tip = `require('../../main/modules/agent-control/resume-handle')`",
      'export function Doc2() { return docs + tip }',
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
