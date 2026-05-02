const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  checkPlanPairing,
  resolveBaseRef,
} = require('../check-plan-pairing.cjs')

test('check-plan-pairing fails an enforced counter-plan without implementation when source changed', () => {
  const root = makeFixture()
  try {
    writePlan(root, '2026-04-30-demo-counterplan.md', '# Demo Counterplan\n')

    const result = checkPlanPairing({
      root,
      changedFiles: ['src/main/modules/agent-control/demo.ts'],
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /expected subject "demo"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-plan-pairing accepts a paired implementation plan', () => {
  const root = makeFixture()
  try {
    writePlan(root, '2026-04-30-demo-counterplan.md', '# Demo Counterplan\n')
    writePlan(root, '2026-04-30-demo-implementation.md', '# Demo Implementation\n')

    const result = checkPlanPairing({
      root,
      changedFiles: ['src/main/modules/agent-control/demo.ts'],
    })

    assert.equal(result.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-plan-pairing skips historical counter material with enforce false', () => {
  const root = makeFixture()
  try {
    writePlan(root, '2026-04-30-demo-arrangement.md', [
      '---',
      'enforce: false',
      '---',
      '',
      '# Demo Arrangement',
      '',
    ].join('\n'))

    const result = checkPlanPairing({
      root,
      changedFiles: ['src/main/modules/agent-control/demo.ts'],
    })

    assert.equal(result.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveBaseRef falls back to main merge-base when no upstream exists', () => {
  const root = makeFixture()
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'A0 Test'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'base\n')
    execFileSync('git', ['add', 'README.md'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' })
    const mainHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    execFileSync('git', ['checkout', '-b', 'feature/no-upstream'], { cwd: root, stdio: 'ignore' })

    assert.equal(resolveBaseRef(root), mainHead)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-a0-plan-'))
  mkdirSync(join(root, 'docs/superpowers/plans'), { recursive: true })
  mkdirSync(join(root, 'src/main/modules/agent-control'), { recursive: true })
  return root
}

function writePlan(root, name, content) {
  writeFileSync(join(root, 'docs/superpowers/plans', name), content)
}
