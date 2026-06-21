const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const script = join(process.cwd(), 'scripts/check-model-card-write-staged.cjs')

function withFixture(memoryTools, memorySchemas, fn) {
  const root = mkdtempSync(join(tmpdir(), 'ready-check-card-staged-'))
  try {
    const toolsDir = join(root, 'src/main/modules/tools')
    const schemasDir = join(toolsDir, 'schemas')
    mkdirSync(schemasDir, { recursive: true })
    writeFileSync(join(toolsDir, 'memory-tools.ts'), memoryTools, 'utf8')
    writeFileSync(join(schemasDir, 'memory-schemas.ts'), memorySchemas, 'utf8')
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function run(root) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, READY_CHECK_ROOT: root },
    encoding: 'utf8',
  })
}

test('accepts authorized status resolution without model confirmation field', () => {
  withFixture(
    [
      'function resolveCardWriteAuthorization() { return { ok: true, status: "staged" } }',
      'const authorization = resolveCardWriteAuthorization()',
      'const frontmatter = { status: authorization.status }',
    ].join('\n'),
    'export const MemoryWriteCardSchema = z.object({ status: z.enum(["staged", "active"]).optional() })',
    (root) => {
      const result = run(root)
      assert.equal(result.status, 0, result.stderr)
    },
  )
})

test('rejects direct status passthrough', () => {
  withFixture(
    [
      'function resolveCardWriteAuthorization() { return { ok: true, status: "staged" } }',
      'const authorization = resolveCardWriteAuthorization()',
      "const frontmatter = { status: status ?? 'staged' }",
    ].join('\n'),
    'export const MemoryWriteCardSchema = z.object({ status: z.enum(["staged", "active"]).optional() })',
    (root) => {
      const result = run(root)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /must not pass model supplied status/)
    },
  )
})

test('rejects missing authorization resolver', () => {
  withFixture(
    'const frontmatter = { status: authorization.status }',
    'export const MemoryWriteCardSchema = z.object({ status: z.enum(["staged", "active"]).optional() })',
    (root) => {
      const result = run(root)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /must call resolveCardWriteAuthorization/)
    },
  )
})

test('rejects model-facing confirmed_active schema', () => {
  withFixture(
    [
      'function resolveCardWriteAuthorization() { return { ok: true, status: "staged" } }',
      'const authorization = resolveCardWriteAuthorization()',
      'const frontmatter = { status: authorization.status }',
    ].join('\n'),
    'export const MemoryWriteCardSchema = z.object({ confirmed_active: z.boolean().optional() })',
    (root) => {
      const result = run(root)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /must not be exposed/)
    },
  )
})
