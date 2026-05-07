const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT_PATH = resolve(
  __dirname,
  '../check-turn-engine-authorization-rearm-order.cjs',
)

function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
  })
}

function withFixture(body, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-rearm-order-'))
  try {
    const dir = join(root, 'src/main/modules/agent-control')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'turn-engine.ts'), body)
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('positive: current repo passes', () => {
  const result = run()
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
})

test('positive: minimal valid shape passes', () => {
  const body = [
    'let __authorization: SkillToolAuthorization | null = null',
    'const buildHostToolContext = (allowed) => {',
    '  if (!__authorization) {',
    '    throw new Error("invariant")',
    '  }',
    '  return { allowed, authorization: __authorization }',
    '}',
    '__authorization = buildAuthorizationFromIdentity(identity, opts)',
    'const ctx = buildHostToolContext(["x"])',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 0, result.stderr)
  })
})

test('negative: missing declaration fails', () => {
  const body = [
    'let __authorization = null',
    'const buildHostToolContext = (a) => {',
    '  if (!__authorization) { throw new Error("x") }',
    '  return a',
    '}',
    '__authorization = buildAuthorizationFromIdentity(i)',
    'buildHostToolContext([])',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing.*declaration/)
  })
})

test('negative: missing null-check fails', () => {
  const body = [
    'let __authorization: SkillToolAuthorization | null = null',
    'const buildHostToolContext = (a) => {',
    '  return { authorization: __authorization }',
    '}',
    '__authorization = buildAuthorizationFromIdentity(i)',
    'buildHostToolContext([])',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /invariant check/)
  })
})

test('negative: rearm AFTER first call fails', () => {
  const body = [
    'let __authorization: SkillToolAuthorization | null = null',
    'const buildHostToolContext = (a) => {',
    '  if (!__authorization) { throw new Error("x") }',
    '  return a',
    '}',
    'buildHostToolContext([])',
    '__authorization = buildAuthorizationFromIdentity(i)',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /precedes or equals/)
  })
})

test('negative: null-check + throw OUTSIDE buildHostToolContext closure fails (Stage 10 tightening)', () => {
  // Stage 10 final-review tightening: the null-check must live INSIDE
  // the closure body. A pre-call null-check sitting at the module level
  // does not enforce the invariant per call (the closure can still be
  // invoked later when __authorization happens to be null).
  const body = [
    'let __authorization: SkillToolAuthorization | null = null',
    '// pre-call null-check OUTSIDE the closure — this should NOT count',
    'if (!__authorization) { throw new Error("module-level guard") }',
    'const buildHostToolContext = (a) => {',
    '  return { authorization: __authorization }',
    '}',
    '__authorization = buildAuthorizationFromIdentity(i)',
    'buildHostToolContext([])',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /INSIDE buildHostToolContext closure/)
  })
})

test('negative: null-check INSIDE the closure but throw is OUTSIDE the closure fails', () => {
  // Edge case: the null-check sits inside the closure body but the
  // matching throw escapes the closure (e.g. after a stray `}`). The
  // gate must catch the missing throw within the closure body.
  const body = [
    'let __authorization: SkillToolAuthorization | null = null',
    'const buildHostToolContext = (a) => {',
    '  if (!__authorization) {',
    '    return null',
    '  }',
    '  return { authorization: __authorization }',
    '}',
    'throw new Error("escaped")',
    '__authorization = buildAuthorizationFromIdentity(i)',
    'buildHostToolContext([])',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /not followed by `throw new Error`/)
  })
})
