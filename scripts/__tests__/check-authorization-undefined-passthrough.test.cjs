const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT_PATH = resolve(
  __dirname,
  '../check-authorization-undefined-passthrough.cjs',
)

function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
  })
}

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-auth-passthrough-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(resolve(full, '..'), { recursive: true })
      writeFileSync(full, body)
    }
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('positive: current repo passes', () => {
  const result = run()
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
})

test('positive: legitimate helper-based fallback in execution-tool-config passes', () => {
  withFixture(
    {
      'src/main/modules/agent-control/execution-tool-config.ts': [
        "function resolvePolicyAuthorization(policy) {",
        "  return policy?.authorization ?? buildExplicitNoSkillAuthorization('no_skill_signal')",
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 0, result.stderr)
    },
  )
})

test('negative: authorization ?? null fails', () => {
  withFixture(
    {
      'src/main/modules/agent-control/tool-registry.ts': [
        'function f(authorization) {',
        '  return authorization ?? null',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /authorization \?\? null\|undefined/)
    },
  )
})

test('negative: authorization as any fails', () => {
  withFixture(
    {
      'src/main/modules/agent-control/tool-gateway.ts': [
        'function f(authorization) {',
        '  return doSomething(authorization as any)',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /as any/)
    },
  )
})

test('negative: policy?.authorization ?? null fails', () => {
  withFixture(
    {
      'src/main/modules/agent-control/execution-tool-config.ts': [
        'function f(policy) {',
        '  return policy?.authorization ?? null',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /\.authorization \?\? null\|undefined/)
    },
  )
})

test('negative: filterToolsByAuthorization(tools, null) fails', () => {
  withFixture(
    {
      'src/main/modules/tools/index.ts': [
        'function f(tools) {',
        '  return filterToolsByAuthorization(tools, null, getName)',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /filterToolsByAuthorization/)
    },
  )
})

test('negative: comment containing the bad shape does NOT fail (comments stripped)', () => {
  withFixture(
    {
      'src/main/modules/agent-control/tool-registry.ts': [
        '// historical: authorization ?? null was the W3a default',
        'export const x = 1',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 0, result.stderr)
    },
  )
})
