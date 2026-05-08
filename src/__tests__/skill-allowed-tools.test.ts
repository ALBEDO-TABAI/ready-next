/**
 * Stage S PR-S12 W11.1 — manifest `allowed_tools` validation.
 *
 * Behaviour we lock in:
 *   1. Absent / null `allowed_tools` → `def.allowedTools === undefined`.
 *   2. Empty array → normalised to `[]`.
 *   3. Valid string array → trimmed + deduped + preserved.
 *   4. Non-array / non-string entries → ManifestValidationError.
 *
 * We compile against a tmp skill folder rather than mocking the file
 * read so that the validator's real wire-through to compileSkillDefinition
 * is exercised end-to-end.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compileSkillDefinition,
  validateAllowedTools,
  ManifestValidationError,
} from '../main/modules/skills-runtime/skill-compiler'

function makeSkillFolder(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ready-skill-allowed-tools-'))
  writeFileSync(
    join(dir, 'ready-skill.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
  // Minimum viable skill: needs an action so compile doesn't fail.
  writeFileSync(
    join(dir, 'run.py'),
    "print('hi')\n",
    'utf8',
  )
  return dir
}

function withCleanup<T>(dir: string, fn: () => T): T {
  try {
    return fn()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('validateAllowedTools: undefined / null → undefined', () => {
  assert.equal(validateAllowedTools('s', undefined), undefined)
  assert.equal(validateAllowedTools('s', null), undefined)
})

test('validateAllowedTools: empty array → []', () => {
  assert.deepEqual(validateAllowedTools('s', []), [])
})

test('validateAllowedTools: trims, dedupes, preserves order', () => {
  const out = validateAllowedTools('s', ['  foo  ', 'bar', 'foo', '', 'baz'])
  assert.deepEqual(out, ['foo', 'bar', 'baz'])
})

test('validateAllowedTools: non-array → ManifestValidationError', () => {
  assert.throws(() => validateAllowedTools('s', 'not-an-array'), (err: unknown) => {
    assert.ok(err instanceof ManifestValidationError, 'expected ManifestValidationError')
    return true
  })
  assert.throws(() => validateAllowedTools('s', { foo: 'bar' }), ManifestValidationError)
  assert.throws(() => validateAllowedTools('s', 42), ManifestValidationError)
})

test('validateAllowedTools: non-string entries → ManifestValidationError', () => {
  assert.throws(() => validateAllowedTools('s', ['ok', 42, 'also-ok']), ManifestValidationError)
  assert.throws(() => validateAllowedTools('s', [null]), ManifestValidationError)
  assert.throws(() => validateAllowedTools('s', [{}]), ManifestValidationError)
})

test('compileSkillDefinition: omits allowedTools when manifest has no field', () => {
  const dir = makeSkillFolder({
    id: 'my-skill',
    name: 'My Skill',
    version: '1.0.0',
    actions: { run: { entry: 'run.py', description: 'run' } },
    runtime: 'python',
  })
  withCleanup(dir, () => {
    const def = compileSkillDefinition({ folderPath: dir, source: 'custom' })
    assert.equal(def.allowedTools, undefined, 'allowedTools should be undefined when manifest absent')
  })
})

test('compileSkillDefinition: accepts and normalises allowed_tools (snake_case)', () => {
  const dir = makeSkillFolder({
    id: 'my-skill',
    name: 'My Skill',
    version: '1.0.0',
    runtime: 'python',
    actions: { run: { entry: 'run.py', description: 'run' } },
    allowed_tools: ['skill_run_shell', '  skill_read_artifact  ', 'skill_run_shell'],
  })
  withCleanup(dir, () => {
    const def = compileSkillDefinition({ folderPath: dir, source: 'custom' })
    assert.deepEqual(
      def.allowedTools,
      ['skill_run_shell', 'skill_read_artifact'],
      'duplicates removed, whitespace trimmed, order preserved',
    )
  })
})

test('compileSkillDefinition: also accepts camelCase allowedTools', () => {
  const dir = makeSkillFolder({
    id: 'my-skill',
    name: 'My Skill',
    version: '1.0.0',
    runtime: 'python',
    actions: { run: { entry: 'run.py', description: 'run' } },
    allowedTools: ['a', 'b'],
  })
  withCleanup(dir, () => {
    const def = compileSkillDefinition({ folderPath: dir, source: 'custom' })
    assert.deepEqual(def.allowedTools, ['a', 'b'])
  })
})

test('compileSkillDefinition: rejects non-array allowed_tools', () => {
  const dir = makeSkillFolder({
    id: 'my-skill',
    name: 'My Skill',
    version: '1.0.0',
    runtime: 'python',
    actions: { run: { entry: 'run.py', description: 'run' } },
    allowed_tools: 'this-is-a-string-not-an-array',
  })
  withCleanup(dir, () => {
    assert.throws(
      () => compileSkillDefinition({ folderPath: dir, source: 'custom' }),
      ManifestValidationError,
    )
  })
})

test('compileSkillDefinition: rejects array with non-string entry', () => {
  const dir = makeSkillFolder({
    id: 'my-skill',
    name: 'My Skill',
    version: '1.0.0',
    runtime: 'python',
    actions: { run: { entry: 'run.py', description: 'run' } },
    allowed_tools: ['ok', 42],
  })
  withCleanup(dir, () => {
    assert.throws(
      () => compileSkillDefinition({ folderPath: dir, source: 'custom' }),
      ManifestValidationError,
    )
  })
})

// Avoid leaving residual tmp dirs around if the process is killed mid-test.
test.after?.(() => {
  // node:test has no global afterAll across files; per-test withCleanup
  // already handles the happy path.
})
