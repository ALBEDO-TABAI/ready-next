const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  checkTestingConventionsDoc,
  TESTING_SECTION_HEADER,
} = require('../check-testing-conventions-doc.cjs')

// Case (i) — green: both files contain §6 with the three invariants and
// matching substance.
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
    assert.match(
      result.errors.join('\n'),
      /docs\/superpowers\/testing-conventions\.md is missing/,
    )
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
    const stub = [
      '## 6. 测试与验证',
      '- 不得用 source-grep 冒充行为验证，不得用 skip 当通过。',
      '- SQLite-backed 验收先跑 `npm run verify:native`。',
      '',
      '## 7. 其它',
      '',
    ].join('\n')
    writeFileSync(join(root, 'CLAUDE.md'), stub)
    writeFileSync(join(root, 'AGENTS.md'), stub)

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      /CLAUDE\.md must reference testing-conventions\.md/,
    )
    assert.match(
      result.errors.join('\n'),
      /AGENTS\.md must reference testing-conventions\.md/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Case (ii) — missing §6 header.
test('check-testing-conventions-doc rejects when CLAUDE.md is missing §6 header', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    writeFileSync(
      join(root, 'CLAUDE.md'),
      [
        '## 5. 别的章节',
        '- 仅 mentions `docs/superpowers/testing-conventions.md`',
        '',
      ].join('\n'),
    )
    writeFileSync(join(root, 'AGENTS.md'), buildSyncedSection())

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      new RegExp(`CLAUDE\\.md must include ${escapeRegex(TESTING_SECTION_HEADER)}`),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Case (iii) — §6 missing one of the 3 invariants. Drop the verify:native
// substring from CLAUDE.md while keeping AGENTS.md intact (this also exercises
// the sync-divergence guard, so the test asserts the invariant error fires).
test('check-testing-conventions-doc rejects when §6 omits the verify:native invariant', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    const claudeSection = [
      '## 6. 测试与验证',
      '- 不得用 source-grep 冒充行为验证，不得用 skip 当通过。',
      '- 详见 `docs/superpowers/testing-conventions.md`。',
      '',
      '## 7. 其它',
      '',
    ].join('\n')
    writeFileSync(join(root, 'CLAUDE.md'), claudeSection)
    writeFileSync(join(root, 'AGENTS.md'), buildSyncedSection())

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      /missing invariant "verify-native"/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-testing-conventions-doc rejects when §6 omits the no-source-grep invariant', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    const droppedSourceGrep = [
      '## 6. 测试与验证',
      '- 不得用 skip 当通过。',
      '- SQLite-backed 验收先跑 `npm run verify:native`。',
      '- 详见 `docs/superpowers/testing-conventions.md`。',
      '',
      '## 7. 其它',
      '',
    ].join('\n')
    writeFileSync(join(root, 'CLAUDE.md'), droppedSourceGrep)
    writeFileSync(join(root, 'AGENTS.md'), droppedSourceGrep)

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      /missing invariant "no-source-grep"/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-testing-conventions-doc rejects when §6 omits the no-skip-as-pass invariant', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    const droppedSkip = [
      '## 6. 测试与验证',
      '- 不得用 source-grep 冒充行为验证。',
      '- SQLite-backed 验收先跑 `npm run verify:native`。',
      '- 详见 `docs/superpowers/testing-conventions.md`。',
      '',
      '## 7. 其它',
      '',
    ].join('\n')
    writeFileSync(join(root, 'CLAUDE.md'), droppedSkip)
    writeFileSync(join(root, 'AGENTS.md'), droppedSkip)

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      /missing invariant "no-skip-as-pass"/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Case (iv) — CLAUDE.md and AGENTS.md diverge on §6 substance.
test('check-testing-conventions-doc rejects when CLAUDE.md and AGENTS.md §6 diverge', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    writeFileSync(join(root, 'CLAUDE.md'), buildSyncedSection())
    const diverged = [
      '## 6. 测试与验证',
      '- 不得用 source-grep 冒充行为验证，不得用 skip 当通过。',
      '- SQLite-backed 验收先跑 `npm run verify:native`。',
      '- AGENTS.md 私自加了一条额外约束，CLAUDE.md 没有同步。',
      '- 详见 `docs/superpowers/testing-conventions.md`。',
      '',
      '## 7. 其它',
      '',
    ].join('\n')
    writeFileSync(join(root, 'AGENTS.md'), diverged)

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, false)
    assert.match(
      result.errors.join('\n'),
      /CLAUDE\.md and AGENTS\.md .*substance diverged/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-testing-conventions-doc tolerates whitespace-only differences between CLAUDE.md and AGENTS.md', () => {
  const root = makeFixture()
  try {
    writeTestingConventionsDoc(root)
    const base = buildSyncedSection()
    // Insert pure whitespace (extra blank lines + trailing spaces on existing
    // lines) into AGENTS.md to confirm normalize-then-compare tolerates
    // whitespace-only divergence.
    const padded = base
      .replace('## 6. 测试与验证\n', '## 6. 测试与验证   \n\n')
      .replace('## 7. 其它', '\n## 7. 其它')
    writeFileSync(join(root, 'CLAUDE.md'), base)
    writeFileSync(join(root, 'AGENTS.md'), padded)

    const result = checkTestingConventionsDoc({ root })

    assert.equal(result.ok, true, result.errors.join('\n'))
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

function buildSyncedSection() {
  return [
    '## 6. 测试与验证',
    '- 不得用 source-grep 冒充行为验证，不得用 skip 当通过。',
    '- SQLite-backed 验收先跑 `npm run verify:native`。',
    '- 详见 `docs/superpowers/testing-conventions.md`。',
    '',
    '## 7. 其它',
    '',
  ].join('\n')
}

function writeSyncedAgentDocs(root) {
  const content = buildSyncedSection()
  writeFileSync(join(root, 'CLAUDE.md'), content)
  writeFileSync(join(root, 'AGENTS.md'), content)
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
