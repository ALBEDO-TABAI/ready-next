const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-eslint-baseline.cjs')

test('check-eslint-baseline --area a1-gate counts only a1-gate entries', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    writeSourceGrepTest(root, 'src/__tests__/document-widget-system.test.ts')
    writeLegacyBackdoor(root)
    updateBaseline(root)

    const output = runScript(root, ['--area', 'a1-gate'])

    assert.match(output, /a1-gate current entries: 1/)
    assert.match(output, /files: 1/)
    assert.match(output, /src\/__tests__\/skill-demo-contract\.test\.ts: 1/)
    assert.doesNotMatch(output, /document-widget-system/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline --area ui-history counts only ui-history entries', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    writeSourceGrepTest(root, 'src/__tests__/rss-draft-store-ui-contract.test.ts')
    writeSourceGrepTest(root, 'src/__tests__/rss-list-row-style-contract.test.ts')
    updateBaseline(root)

    const output = runScript(root, ['--area', 'ui-history'])

    assert.match(output, /ui-history current entries: 2/)
    assert.match(output, /files: 2/)
    assert.match(output, /rss-draft-store-ui-contract\.test\.ts: 1/)
    assert.match(output, /rss-list-row-style-contract\.test\.ts: 1/)
    assert.doesNotMatch(output, /skill-demo-contract/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline --area a1-gate exits 0 when count is non-zero', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    updateBaseline(root)

    const result = spawnScript(root, ['--area', 'a1-gate'])

    assert.equal(result.status, 0)
    assert.match(result.stdout, /a1-gate current entries: 1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline --area a1-gate --max 0 fails when count is non-zero', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    updateBaseline(root)

    const result = spawnScript(root, ['--area', 'a1-gate', '--max', '0'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /a1-gate current entries 1 exceeds max 0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline --area unknown-area errors with usage message', () => {
  const root = makeFixture()
  try {
    updateBaseline(root)

    const result = spawnScript(root, ['--area', 'unknown-area'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:/)
    assert.match(result.stderr, /unknown-area/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline rejects missing area in v2 baseline entries', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    updateBaseline(root)
    const baseline = JSON.parse(readFileSync(join(root, 'eslint-rules/baseline.json'), 'utf8'))
    delete baseline.entries[0].area
    writeBaseline(root, baseline)

    const result = spawnScript(root, ['--area', 'a1-gate'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Missing baseline area/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline rejects invalid area in v2 baseline entries', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    updateBaseline(root)
    const baseline = JSON.parse(readFileSync(join(root, 'eslint-rules/baseline.json'), 'utf8'))
    baseline.entries[0].area = 'oops'
    writeBaseline(root, baseline)

    const result = spawnScript(root, ['--area', 'a1-gate'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Invalid baseline area/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline rejects duplicate baseline keys', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    updateBaseline(root)
    const baseline = JSON.parse(readFileSync(join(root, 'eslint-rules/baseline.json'), 'utf8'))
    baseline.entries.push({ ...baseline.entries[0] })
    writeBaseline(root, baseline)

    const result = spawnScript(root, [])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Duplicate baseline entries/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline --update writes version 2 with areas', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    writeSourceGrepTest(root, 'src/__tests__/document-widget-system.test.ts')
    writeLegacyBackdoor(root)

    updateBaseline(root)

    const baseline = JSON.parse(readFileSync(join(root, 'eslint-rules/baseline.json'), 'utf8'))
    assert.equal(baseline.version, 2)
    assert.ok(baseline.areaPolicy)
    assert.deepEqual(
      baseline.entries.map((entry) => entry.area).sort(),
      ['a1-gate', 'other-a0', 'ui-history'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-eslint-baseline without --area preserves A0 behavior (total entries)', () => {
  const root = makeFixture()
  try {
    writeSourceGrepTest(root, 'src/__tests__/skill-demo-contract.test.ts')
    writeSourceGrepTest(root, 'src/__tests__/document-widget-system.test.ts')
    writeLegacyBackdoor(root)
    updateBaseline(root)

    const output = runScript(root, [])

    assert.match(output, /A0 ESLint baseline ok \(3 entries\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-a05-baseline-'))
  mkdirSync(join(root, 'src/__tests__'), { recursive: true })
  mkdirSync(join(root, 'src/main/modules/agent-control'), { recursive: true })
  mkdirSync(join(root, 'eslint-rules'), { recursive: true })
  return root
}

function writeSourceGrepTest(root, file) {
  const abs = join(root, file)
  mkdirSync(resolve(abs, '..'), { recursive: true })
  writeFileSync(abs, [
    "import assert from 'node:assert/strict'",
    "import { readFileSync } from 'node:fs'",
    "const source = readFileSync('src/main/foo.ts', 'utf8')",
    'assert.match(source, /foo/)',
    '',
  ].join('\n'))
}

function writeLegacyBackdoor(root) {
  writeFileSync(
    join(root, 'src/main/modules/agent-control/legacy-demo.ts'),
    'interface Options { legacy?: boolean }\n',
  )
}

function updateBaseline(root) {
  runScript(root, ['--update'])
}

function writeBaseline(root, baseline) {
  writeFileSync(join(root, 'eslint-rules/baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`)
}

function runScript(root, args) {
  return execFileSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
}

function spawnScript(root, args) {
  return spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
}
