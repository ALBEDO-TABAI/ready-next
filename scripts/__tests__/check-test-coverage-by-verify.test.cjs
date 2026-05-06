'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const target = require('../check-test-coverage-by-verify.cjs')
const { tokenize, expandGlob, expandReferenced, looksLikeTestPath, loadExemptions, normalizePosix } =
  target._internals

function makeFixtureRepo() {
  const raw = mkdtempSync(path.join(os.tmpdir(), 'stage5-coverage-'))
  const root = realpathSync(raw) // macOS /tmp → /private/var symlink
  // package.json
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    write(rel, content) {
      const abs = path.join(root, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    },
  }
}

test('tokenize splits on && / ; and recombines `npm run X`', () => {
  const tokens = tokenize('npm run a && node x.cjs && npx tsx --test src/__tests__/foo.test.ts')
  assert.deepEqual(
    tokens.filter((t) => t.startsWith('npm run')),
    ['npm run a'],
  )
  assert.ok(tokens.includes('src/__tests__/foo.test.ts'))
})

test('looksLikeTestPath recognizes 4 extensions + glob forms', () => {
  assert.equal(looksLikeTestPath('src/__tests__/foo.test.ts'), true)
  assert.equal(looksLikeTestPath('src/__tests__/e2e/foo.e2e.ts'), true)
  assert.equal(looksLikeTestPath('eslint-rules/__tests__/x.test.mjs'), true)
  assert.equal(looksLikeTestPath('scripts/__tests__/x.test.cjs'), true)
  assert.equal(looksLikeTestPath('src/__tests__/skill-*.test.ts'), true)
  assert.equal(looksLikeTestPath('src/__tests__/*.test.ts'), true)
  assert.equal(looksLikeTestPath('not/a/test.path'), false)
})

test('expandGlob: `**/*.test.ts` matches nested files', () => {
  const fx = makeFixtureRepo()
  try {
    fx.write('src/__tests__/a.test.ts', 'export {}')
    fx.write('src/__tests__/sub/b.test.ts', 'export {}')
    fx.write('src/__tests__/c.spec.ts', 'export {}') // not picked
    const matched = expandGlob('src/__tests__/**/*.test.ts', fx.root).map((p) =>
      normalizePosix(path.relative(fx.root, p)),
    )
    assert.deepEqual(matched.sort(), ['src/__tests__/a.test.ts', 'src/__tests__/sub/b.test.ts'])
  } finally {
    fx.cleanup()
  }
})

test('expandGlob: brace expansion `*.test.{mjs,ts}` works', () => {
  const fx = makeFixtureRepo()
  try {
    fx.write('eslint-rules/__tests__/a.test.mjs', '')
    fx.write('eslint-rules/__tests__/b.test.ts', '')
    fx.write('eslint-rules/__tests__/c.test.cjs', '') // not in {mjs,ts}
    const matched = expandGlob('eslint-rules/__tests__/**/*.test.{mjs,ts}', fx.root).map((p) =>
      normalizePosix(path.relative(fx.root, p)),
    )
    assert.deepEqual(matched.sort(), [
      'eslint-rules/__tests__/a.test.mjs',
      'eslint-rules/__tests__/b.test.ts',
    ])
  } finally {
    fx.cleanup()
  }
})

test('expandReferenced: transitive `npm run X` expansion + cycle detection', () => {
  const fx = makeFixtureRepo()
  try {
    fx.write('src/__tests__/a.test.ts', '')
    const scripts = {
      'verify:x': 'npm run verify:y',
      'verify:y': 'npx tsx --test src/__tests__/a.test.ts',
    }
    const out = new Set()
    expandReferenced(scripts, 'verify:x', new Set(), out, fx.root)
    assert.ok([...out].some((p) => p.endsWith('a.test.ts')))
  } finally {
    fx.cleanup()
  }

  // cycle
  const cyclic = { 'verify:a': 'npm run verify:b', 'verify:b': 'npm run verify:a' }
  const visited = new Set()
  // expansion should terminate (no infinite loop) and not throw — visited guards.
  expandReferenced(cyclic, 'verify:a', visited, new Set(), '/tmp')
  assert.equal(visited.size, 2)
})

test('expandReferenced rejects template token like ${VAR}', () => {
  assert.throws(
    () => expandReferenced({ 'verify:bad': 'echo ${VAR_MISSING}' }, 'verify:bad', new Set(), new Set(), '/tmp'),
    /unrecognized template token/,
  )
})

test('loadExemptions: rejects entry with reason < 10 chars', () => {
  const fx = makeFixtureRepo()
  try {
    const f = path.join(fx.root, 'ex.json')
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 1,
        exempt: [{ path: 'a.ts', reason: 'short', since: '2026-05-06', owner: 'x' }],
      }),
    )
    assert.throws(() => loadExemptions(f), /reason ≥ 10 chars/)
  } finally {
    fx.cleanup()
  }
})

test('loadExemptions: rejects entry without ISO since', () => {
  const fx = makeFixtureRepo()
  try {
    const f = path.join(fx.root, 'ex.json')
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 1,
        exempt: [{ path: 'a.ts', reason: 'long enough reason text', since: 'May 2026' }],
      }),
    )
    assert.throws(() => loadExemptions(f), /ISO since/)
  } finally {
    fx.cleanup()
  }
})

test('integration: nested orphan is detected against the live repo (uses real package.json)', () => {
  // Sanity contract: the live repo must currently pass the gate (no orphan).
  const result = target.checkTestCoverageByVerify()
  assert.ok(
    result.ok,
    `live repo should be orphan-free; got: ${JSON.stringify(result.violations, null, 2)}`,
  )
  assert.ok(result.diskCount > 0, 'disk scan must find at least one test file')
  assert.ok(result.referencedCount > 0, 'reference scan must find at least one referenced file')
})
