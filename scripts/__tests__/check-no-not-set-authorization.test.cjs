const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const SCRIPT_PATH = resolve(__dirname, '../check-no-not-set-authorization.cjs')

function run(args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
  })
}

test('positive: current repo passes the gate', () => {
  const result = run()
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  assert.match(result.stdout, /OK/)
})

test("negative: a temp file containing 'not_set' fails the gate", () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-not-set-gate-'))
  try {
    const dir = join(root, 'src/main/modules/agent-control')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'fake.ts'),
      ['// transitional comment', "const x: string = 'not_set'", ''].join('\n'),
    )
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /FAIL/)
    assert.match(result.stderr, /'not_set' literal/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('negative: SKILL_TOOL_AUTHORIZATION_NOT_SET identifier fails the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-not-set-gate-id-'))
  try {
    const dir = join(root, 'src/main/modules/tools')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'fake.ts'),
      ['import { SKILL_TOOL_AUTHORIZATION_NOT_SET } from "./auth"', ''].join('\n'),
    )
    const result = run(['--root', root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /SKILL_TOOL_AUTHORIZATION_NOT_SET/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("negative: === 'not_set' in skill-tool-authorization.ts fails the gate", () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-not-set-gate-eq-'))
  try {
    const dir = join(root, 'src/main/modules/agent-control')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'skill-tool-authorization.ts'),
      ["if (auth.reason === 'not_set') return true", ''].join('\n'),
    )
    const result = run(['--root', root])
    assert.equal(result.status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
