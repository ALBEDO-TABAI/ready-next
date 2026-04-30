const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const SCRIPT = join(__dirname, '../check-a1-boundary.cjs')

test('check-a1-boundary accepts committed and uncommitted changes outside protected files', () => {
  const root = initRepo()
  try {
    const base = commitBase(root)
    writeFile(root, 'src/main/modules/agent-control/runtime.ts', 'export const runtime = 2\n')
    git(root, ['add', 'src/main/modules/agent-control/runtime.ts'])
    git(root, ['commit', '-m', 'runtime change'])
    writeFile(root, 'src/main/modules/agent-control/session-manager.ts', 'export const session = 2\n')

    const result = runBoundary(root, base)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /a1 boundary: ok/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-a1-boundary rejects committed protected-file changes from base', () => {
  const root = initRepo()
  try {
    const base = commitBase(root)
    writeFile(root, 'src/main/modules/agent-control/skill-child-runner.ts', 'export const runner = 2\n')
    git(root, ['add', 'src/main/modules/agent-control/skill-child-runner.ts'])
    git(root, ['commit', '-m', 'protected change'])

    const result = runBoundary(root, base)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /committed A1 boundary changes/)
    assert.match(result.stderr, /skill-child-runner\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-a1-boundary rejects uncommitted protected-file changes', () => {
  const root = initRepo()
  try {
    const base = commitBase(root)
    writeFile(root, 'src/main/modules/agent-control/turn-engine.ts', 'export const turnEngine = 2\n')
    writeFile(root, 'src/main/modules/agent-control/skill-child-new.ts', 'export const newRunner = 1\n')

    const result = runBoundary(root, base)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /uncommitted A1 boundary changes/)
    assert.match(result.stderr, /turn-engine\.ts/)
    assert.match(result.stderr, /skill-child-new\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ready-a1-boundary-'))
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'A1 Boundary Test'])
  return root
}

function commitBase(root) {
  writeFile(root, 'src/main/modules/agent-control/skill-child-runner.ts', 'export const runner = 1\n')
  writeFile(root, 'src/main/modules/agent-control/skill-child-error-mapping.ts', 'export const mapping = 1\n')
  writeFile(root, 'src/main/modules/agent-control/turn-engine.ts', 'export const turnEngine = 1\n')
  writeFile(root, 'src/main/modules/agent-control/runtime.ts', 'export const runtime = 1\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'base'])
  return git(root, ['rev-parse', 'HEAD']).trim()
}

function writeFile(root, file, content) {
  const abs = join(root, file)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function runBoundary(root, base) {
  return spawnSync('node', [SCRIPT, '--root', root, '--base', base], { encoding: 'utf8' })
}
