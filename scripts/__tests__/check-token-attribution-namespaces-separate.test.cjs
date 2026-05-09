'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  check,
  SOURCE_REL,
  EXPECTED_NAMESPACES,
} = require('../check-token-attribution-namespaces-separate.cjs')

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'check-token-ns-'))
  const dir = join(root, 'src/main/modules/agent-control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, SOURCE_REL), content)
  return root
}

function goodSource() {
  return `export const TOKEN_ATTRIBUTION_NAMESPACES = ['model_call', 'task_card_step'] as const
export type TokenAttributionNamespace = (typeof TOKEN_ATTRIBUTION_NAMESPACES)[number]
`
}

test('passes when namespace tuple is exactly the 2 expected literals', () => {
  const root = makeFixture(goodSource())
  try {
    const r = check({ root })
    assert.equal(r.ok, true, r.errors?.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when source imports from tool-error-metrics', () => {
  const root = makeFixture(
    `import { TOOL_ERROR_METRICS } from './tool-error-metrics'\n` + goodSource(),
  )
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /must not import from tool-error-metrics/.test(e)))
    assert.ok(r.errors.some((e) => /must not reference TOOL_ERROR_METRICS/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when tuple has wrong arity', () => {
  const root = makeFixture(
    `export const TOKEN_ATTRIBUTION_NAMESPACES = ['model_call'] as const\n`,
  )
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /exactly 2 elements/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when tuple order is swapped', () => {
  const root = makeFixture(
    `export const TOKEN_ATTRIBUTION_NAMESPACES = ['task_card_step', 'model_call'] as const\n`,
  )
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /\[0\] must be 'model_call'/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when source file is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-token-ns-missing-'))
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /Missing source/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EXPECTED_NAMESPACES is the canonical 2-element tuple', () => {
  assert.deepEqual([...EXPECTED_NAMESPACES], ['model_call', 'task_card_step'])
})
