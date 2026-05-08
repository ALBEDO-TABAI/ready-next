'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  check,
  TARGETS,
} = require('../check-llm-retry-applied-at-execution-clients.cjs')

function makeFixture({ openaiContent, anthropicContent }) {
  const root = mkdtempSync(join(tmpdir(), 'check-llm-retry-applied-'))
  if (openaiContent !== null) {
    const abs = join(root, TARGETS[0])
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, openaiContent)
  }
  if (anthropicContent !== null) {
    const abs = join(root, TARGETS[1])
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, anthropicContent)
  }
  return root
}

function goodClient() {
  return `import { withRetryBackoff } from './llm-resilience'\nexport async function go() { return withRetryBackoff(async () => 1) }\n`
}

test('passes when both clients import and call withRetryBackoff', () => {
  const root = makeFixture({ openaiContent: goodClient(), anthropicContent: goodClient() })
  try {
    const r = check({ root })
    assert.equal(r.ok, true, r.errors?.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when openai client is missing the import', () => {
  const root = makeFixture({
    openaiContent: `export async function go() { return 1 }\n`,
    anthropicContent: goodClient(),
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /openai-execution-client.*import/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when anthropic client imports but never calls', () => {
  const root = makeFixture({
    openaiContent: goodClient(),
    anthropicContent: `import { withRetryBackoff } from './llm-resilience'\nexport async function go() { return 1 }\n`,
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /anthropic-execution-client.*0 time/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a target file is missing', () => {
  const root = makeFixture({ openaiContent: null, anthropicContent: goodClient() })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /Missing/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
