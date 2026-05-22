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
      'src/main/modules/agent-control/tool-policy/execution-tool-config.ts': [
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
      'src/main/modules/agent-control/tools-runtime/tool-registry.ts': [
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
      'src/main/modules/agent-control/tools-runtime/tool-gateway.ts': [
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
      'src/main/modules/agent-control/tool-policy/execution-tool-config.ts': [
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
      'src/main/modules/agent-control/tools-runtime/tool-registry.ts': [
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

// ---------------------------------------------------------------------------
// Stage 10 final-review extension: `as unknown as Skill*` cast and multiline
// `filterToolsByAuthorization` are also rejected; the legitimate helper-based
// fallback `?? buildExplicitNoSkillAuthorization(...)` is allowed.
// ---------------------------------------------------------------------------

test('negative: authorization as unknown as SkillToolAuthorization fails', () => {
  withFixture(
    {
      'src/main/modules/agent-control/tools-runtime/tool-runtime.ts': [
        'function f(authorization) {',
        '  return doSomething(authorization as unknown as SkillToolAuthorization)',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /as unknown as Skill\*/)
    },
  )
})

test('negative: multiline filterToolsByAuthorization with undefined fails', () => {
  withFixture(
    {
      'src/main/modules/tools/index.ts': [
        'function f(tools, getName) {',
        '  return filterToolsByAuthorization(',
        '    tools,',
        '    undefined,',
        '    getName,',
        '  )',
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

test('positive: ?? buildExplicitNoSkillAuthorization(...) helper fallback is allowed', () => {
  withFixture(
    {
      'src/main/modules/agent-control/tools-runtime/tool-runtime.ts': [
        "function f(context) {",
        "  return context?.authorization ?? buildExplicitNoSkillAuthorization('no_skill_signal')",
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

test('negative: extended scope — `as any` in tool-executor.ts fails', () => {
  withFixture(
    {
      'src/main/modules/tools/tool-executor.ts': [
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

test('negative: extended scope — `as any` in execution-loop-orchestrator.ts fails', () => {
  withFixture(
    {
      'src/main/modules/agent-control/runtime-core/execution-loop-orchestrator.ts': [
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

test('negative: skill filter helper optional authorization parameter fails', () => {
  withFixture(
    {
      'src/main/modules/agent-control/tool-policy/execution-tool-skill-filters.ts': [
        'function f(',
        '  authorization?: SkillToolAuthorization | null,',
        ') {',
        '  return authorization',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /optional authorization parameter/)
    },
  )
})

test('negative: skill filter helper missing authorization passthrough fails', () => {
  withFixture(
    {
      'src/main/modules/agent-control/tool-policy/execution-tool-skill-filters.ts': [
        'function f(authorization: SkillToolAuthorization) {',
        '  if (!authorization) return true',
        '  return false',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = run(['--root', root])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /missing authorization passthrough/)
    },
  )
})
