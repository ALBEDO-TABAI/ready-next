const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  checkTestingConventionsDoc,
} = require('../check-testing-conventions-doc.cjs')

test('check-testing-conventions-doc accepts complete documentation wiring', () => {
  const root = makeFixture()
  try {
    writeCompleteFixture(root)

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, true, result.errors.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-testing-conventions-doc rejects a missing testing conventions doc', () => {
  const root = makeFixture()
  try {
    writeSyncedAgentDocs(root)

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /docs\/superpowers\/testing-conventions\.md is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-testing-conventions-doc rejects a missing required anchor', () => {
  const root = makeFixture()
  try {
    writeCompleteFixture(root, { omitAnchor: '## e2e 测试边界' })

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /missing required anchor: ## e2e 测试边界/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-testing-conventions-doc rejects missing CLAUDE or AGENTS references', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    writeFileSync(join(root, 'CLAUDE.md'), '### 6.17 测试规约\n缺少链接\n')
    writeFileSync(join(root, 'AGENTS.md'), '### 6.17 测试规约\n详见 `docs/superpowers/testing-conventions.md`。\n')

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /CLAUDE\.md must reference testing-conventions\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-testing-conventions-doc rejects a missing AGENTS reference', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    writeFileSync(join(root, 'CLAUDE.md'), '### 6.17 测试规约\n详见 `docs/superpowers/testing-conventions.md`。\n')
    writeFileSync(join(root, 'AGENTS.md'), '### 6.17 测试规约\n缺少链接\n')

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /AGENTS\.md must reference testing-conventions\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-testing-conventions-check-'))
  mkdirSync(join(root, 'docs/superpowers'), { recursive: true })
  return root
}

function writeCompleteFixture(root, options = {}) {
  writeTestingConventionsDoc(root, options)
  writeSyncedAgentDocs(root)
}

function writeTestingConventionsDoc(root, options = {}) {
  const anchors = [
    '## 行为测试 vs 结构测试',
    '## __breaksInvariants 协议',
    '## e2e 测试边界',
    '## fixture 提交规约',
    '## 测试运行模式表',
  ].filter((anchor) => anchor !== options.omitAnchor)
  writeFileSync(
    join(root, 'docs/superpowers/testing-conventions.md'),
    ['# 测试规约', '', ...anchors.map((anchor) => `${anchor}\n内容。`), ''].join('\n'),
  )
}

function writeSyncedAgentDocs(root) {
  const content = [
    '### 6.17 测试规约',
    '- 测试规约见 `docs/superpowers/testing-conventions.md`。',
    '',
  ].join('\n')
  writeFileSync(join(root, 'CLAUDE.md'), content)
  writeFileSync(join(root, 'AGENTS.md'), content)
}
