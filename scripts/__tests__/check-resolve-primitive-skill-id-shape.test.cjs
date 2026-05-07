const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT_PATH = resolve(
  __dirname,
  '../check-resolve-primitive-skill-id-shape.cjs',
)

function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
  })
}

function withFixture(body, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-resolve-prim-shape-'))
  try {
    const dir = join(root, 'src/main/modules/tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skills-tools.ts'), body)
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('positive: current repo passes', () => {
  const result = run()
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  assert.match(result.stdout, /OK/)
})

test('positive: clean function body passes', () => {
  const body = [
    'function resolvePrimitiveSkillId(_sessionId, runtimeContext) {',
    '  if (!runtimeContext?.authorization) return null',
    "  if (runtimeContext.authorization.mode === 'selected') return runtimeContext.authorization.skillId",
    '  return null',
    '}',
    '',
    'function unrelated() { return resolveActiveSkillContext() }',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 0, result.stderr)
  })
})

test('negative: legacy resolveActiveSkillContext call inside body fails', () => {
  const body = [
    'function resolvePrimitiveSkillId(_sessionId, runtimeContext) {',
    '  const ctx = resolveActiveSkillContext()',
    '  return ctx?.skillId ?? null',
    '}',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /resolveActiveSkillContext/)
  })
})

test('negative: legacy chooser comment inside body fails', () => {
  const body = [
    'function resolvePrimitiveSkillId(_sessionId, runtimeContext) {',
    '  // fallback: choosePrimitiveSkillId(...)',
    '  return null',
    '}',
    '',
  ].join('\n')
  withFixture(body, (root) => {
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /choosePrimitiveSkillId/)
  })
})
