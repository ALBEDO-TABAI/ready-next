'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  check,
  SOURCE_REL,
  EXPECTED_DIMENSIONS,
} = require('../check-token-attribution-dimensions-registered.cjs')

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'check-token-dims-'))
  const dir = join(root, 'src/main/modules/agent-control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, SOURCE_REL), content)
  return root
}

function goodSource() {
  return `export const TOKEN_ATTRIBUTION_DIMENSIONS = [
  'search', 'fetch', 'subagent', 'present', 'clarification', 'todo',
] as const
`
}

test('passes when dimension tuple is exactly the 6 expected literals in order', () => {
  const root = makeFixture(goodSource())
  try {
    const r = check({ root })
    assert.equal(r.ok, true, r.errors?.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when tuple has wrong arity (5 elements)', () => {
  const root = makeFixture(
    `export const TOKEN_ATTRIBUTION_DIMENSIONS = ['search','fetch','subagent','present','todo'] as const\n`,
  )
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /exactly 6 elements/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when an element is renamed', () => {
  const root = makeFixture(
    `export const TOKEN_ATTRIBUTION_DIMENSIONS = ['search','fetch','subagent','present','clarify','todo'] as const\n`,
  )
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /\[4\] must be 'clarification'/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when declaration is missing entirely', () => {
  const root = makeFixture(`// empty\n`)
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /missing.*TOKEN_ATTRIBUTION_DIMENSIONS/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when source file is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-token-dims-missing-'))
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /Missing source/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EXPECTED_DIMENSIONS is the canonical 6-element tuple', () => {
  assert.deepEqual([...EXPECTED_DIMENSIONS], [
    'search',
    'fetch',
    'subagent',
    'present',
    'clarification',
    'todo',
  ])
})
