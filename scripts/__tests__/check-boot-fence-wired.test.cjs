/**
 * Stage Q (Stage 11) — gate behavior tests for check-boot-fence-wired.cjs.
 *
 * Pin that the gate (a) passes on the real repo, (b) fails when the
 * boot-fence wrapper is missing or the helper is invoked outside the
 * wrapper, (c) fails when constructor doesn't call the wrapper.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-boot-fence-wired.cjs')
const REL = 'src/main/modules/agent-control/runtime.ts'

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
}

function makeFixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'ready-q-bootfence-gate-'))
  const dir = join(root, 'src/main/modules/agent-control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runtime.ts'), body)
  return root
}

test('positive: real repo passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
})

test('positive: well-formed fixture (helper inside wrapper, wrapper called from ctor) passes', () => {
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from './skill-task-tracker'",
    'export class AgentControlRuntime {',
    '  constructor() {',
    '    this.maybeAssertSkillTaskRunInvariant()',
    '  }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    const result = assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    "    if (result === 'incompatible') throw new Error('boot fence')",
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: helper invoked OUTSIDE the wrapper method fails', () => {
  // The helper is called somewhere — but NOT inside maybeAssertSkillTaskRunInvariant.
  // This is the evasion path Codex round 1 ⚠️#4 flagged.
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from './skill-task-tracker'",
    'export class AgentControlRuntime {',
    '  constructor() {',
    '    this.maybeAssertSkillTaskRunInvariant()',
    '  }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    // body forgot to call the helper',
    '  }',
    '  private somewhereElse(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /maybeAssertSkillTaskRunInvariant body does not invoke assertSkillTaskRunInvariantConsistency/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("negative: constructor doesn't call the wrapper fails", () => {
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from './skill-task-tracker'",
    'export class AgentControlRuntime {',
    '  constructor() {',
    '    // forgot to call this.maybeAssertSkillTaskRunInvariant()',
    '  }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /constructor body does not call this\.maybeAssertSkillTaskRunInvariant/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: import missing fails', () => {
  const body = [
    'export class AgentControlRuntime {',
    '  constructor() {',
    '    this.maybeAssertSkillTaskRunInvariant()',
    '  }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    /* nothing */',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: locally-defined stub (no real import) fails — Codex round 2 ❌#2', () => {
  // The helper is referenced and "called" inside the wrapper, but the
  // file defines its own local stub instead of importing the real one.
  // Earlier draft of the gate (string-presence check) would pass this
  // — the tightened import-statement check must catch it.
  const body = [
    "// no import here — fake local stub:",
    'function assertSkillTaskRunInvariantConsistency(args: any) { return "ok" }',
    'export class AgentControlRuntime {',
    '  constructor() {',
    '    this.maybeAssertSkillTaskRunInvariant()',
    '  }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: string literal impersonating an import statement is rejected — Codex round 3 ⚠️#2 (a)', () => {
  // The file has a STRING that LOOKS like an import statement, plus a
  // local stub. The two-pass import check (path-string preserved + an
  // inside-string mask check on the keyword `import`) must reject this.
  const body = [
    'const fakeMarker = "import { assertSkillTaskRunInvariantConsistency } from \'./skill-task-tracker\'"',
    'function assertSkillTaskRunInvariantConsistency(_: any) { return "ok" }',
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
    'void fakeMarker',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: import from a fake source path is rejected — Codex round 3 ⚠️#2 (b)', () => {
  // Real import statement, but `from './fake-source'` instead of
  // `skill-task-tracker`. With a local re-export shim of the same
  // identifier, this could route around the contract. Gate must
  // require the source to contain `skill-task-tracker`.
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from './fake-source'",
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: type-only inline specifier `import { type X }` is rejected — Codex round 4 ❌#1', () => {
  // `import { type assertSkillTaskRunInvariantConsistency } from '...'`
  // imports only the TYPE; the value would have to come from a local
  // stub. The gate must reject this even when the path is correct.
  const body = [
    "import { type assertSkillTaskRunInvariantConsistency } from './skill-task-tracker'",
    'function assertSkillTaskRunInvariantConsistency(_: any) { return "ok" }',
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: spoof path `./fake-skill-task-tracker-shim` is rejected — Codex round 4 ⚠️#2', () => {
  // Substring `skill-task-tracker` IS present in this spoof path, but
  // it is not a path SEGMENT — the basename is `fake-skill-task-tracker-shim`.
  // The gate must require the path to end with `/skill-task-tracker`
  // (optional file extension allowed).
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from './fake-skill-task-tracker-shim'",
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('positive: path with extension `./skill-task-tracker.ts` accepted', () => {
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from './skill-task-tracker.ts'",
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: non-sibling path `../../agent-control/skill-task-tracker` rejected — Codex round 5 #2', () => {
  // Round 5 tightening: runtime.ts and skill-task-tracker.ts MUST live
  // in the same `agent-control/` directory; the import must be exactly
  // `./skill-task-tracker(.ext)?`. A deep path could be a shim module
  // routing to a different file.
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from '../../agent-control/skill-task-tracker'",
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: spoof directory path `./shim/skill-task-tracker` rejected — Codex round 5 #2', () => {
  // Path basename is right but it's in a `shim/` subdir; this could be
  // a different module proxying the real one. Sibling-only enforcement
  // catches it.
  const body = [
    "import { assertSkillTaskRunInvariantConsistency } from './shim/skill-task-tracker'",
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: `as alias` rebinding rejected — Codex round 5 #1', () => {
  // The import binds the value to a different name, then a local stub
  // with the original name is what the wrapper actually calls. Gate
  // must reject the alias form so the imported value MUST be bound to
  // the original name in this module.
  const body = [
    "import { assertSkillTaskRunInvariantConsistency as realAssert } from './skill-task-tracker'",
    'function assertSkillTaskRunInvariantConsistency(_: any) { return "ok" }',
    'export class AgentControlRuntime {',
    '  constructor() { this.maybeAssertSkillTaskRunInvariant() }',
    '  private maybeAssertSkillTaskRunInvariant(): void {',
    '    assertSkillTaskRunInvariantConsistency({ getCheckEnforcedSql: () => null, invariantEnforced: true })',
    '  }',
    '}',
    '',
    'void realAssert',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: comments mentioning the helper do NOT count', () => {
  // Comments are stripped before the gate scan, so a doc-only mention
  // does not satisfy the import check.
  const body = [
    '// We will eventually call assertSkillTaskRunInvariantConsistency from this.maybeAssertSkillTaskRunInvariant',
    'export class AgentControlRuntime {',
    '  constructor() {}',
    '}',
    '',
  ].join('\n')
  const root = makeFixture(body)
  try {
    const r = run(root)
    assert.equal(r.status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
