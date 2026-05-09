'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  check,
  SOURCE_REL,
  EXPECTED_CODES,
} = require('../check-llm-retry-status-codes.cjs')

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'check-llm-retry-codes-'))
  const abs = join(root, SOURCE_REL)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return root
}

function goodSource() {
  return `export const RETRY_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504] as const\n`
}

test('passes when all 8 codes are present', () => {
  const root = makeFixture(goodSource())
  try {
    const r = check({ root })
    assert.equal(r.ok, true, r.errors?.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a code is missing', () => {
  const root = makeFixture(
    `export const RETRY_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503] as const\n`,
  )
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /504/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when declaration is missing', () => {
  const root = makeFixture(`// nothing here\n`)
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /RETRY_STATUS_CODES/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when source file is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-llm-retry-codes-missing-'))
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /Missing/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EXPECTED_CODES is the canonical 8-element tuple', () => {
  assert.deepEqual([...EXPECTED_CODES].sort((a, b) => a - b), [408, 409, 425, 429, 500, 502, 503, 504])
})
