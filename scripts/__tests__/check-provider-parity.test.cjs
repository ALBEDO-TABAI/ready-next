'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const { checkProviderParity, PROVIDER_IDS, ALLOWED_EXTRA } = require('../check-provider-parity.cjs')

function makeFixture() {
  return mkdtempSync(join(tmpdir(), 'check-provider-parity-'))
}

function writeProviderFile(root, name) {
  const dir = join(root, 'src/shared/ai-providers')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.ts`), '// fixture\nexport {}\n')
}

test('soft-skips when ai-providers/ subdir is absent (PR-S2 baseline)', () => {
  const root = makeFixture()
  try {
    const result = checkProviderParity({ root })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'subdir_not_present')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('passes when all 7 provider files + allowed extras present', () => {
  const root = makeFixture()
  try {
    for (const id of PROVIDER_IDS) writeProviderFile(root, id)
    for (const extra of ALLOWED_EXTRA) writeProviderFile(root, extra)
    const result = checkProviderParity({ root })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, false)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.extra, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a provider file is missing', () => {
  const root = makeFixture()
  try {
    for (const id of PROVIDER_IDS) {
      if (id === 'fox') continue
      writeProviderFile(root, id)
    }
    const result = checkProviderParity({ root })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, ['fox'])
    assert.deepEqual(result.extra, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when an unexpected file appears', () => {
  const root = makeFixture()
  try {
    for (const id of PROVIDER_IDS) writeProviderFile(root, id)
    writeProviderFile(root, 'rogue-provider')
    const result = checkProviderParity({ root })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.extra, ['rogue-provider'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
