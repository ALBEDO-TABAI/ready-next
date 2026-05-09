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

// Stage S round 2 — TARGETS shape switched from string[] to
// `Array<{ rel, minCalls }>` so we can require ≥ 6 calls in the openai
// client and ≥ 2 calls in the anthropic client. Tests below build
// fixtures sized to the configured minima.

function targetEntry(index) {
  const t = TARGETS[index]
  return typeof t === 'string' ? { rel: t, minCalls: 1 } : t
}

function makeFixture({ openaiContent, anthropicContent }) {
  const root = mkdtempSync(join(tmpdir(), 'check-llm-retry-applied-'))
  if (openaiContent !== null) {
    const abs = join(root, targetEntry(0).rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, openaiContent)
  }
  if (anthropicContent !== null) {
    const abs = join(root, targetEntry(1).rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, anthropicContent)
  }
  return root
}

function goodClient(callCount) {
  const calls = Array.from({ length: callCount }, () => 'await withRetryBackoff(async () => 1)').join('; ')
  return `import { withRetryBackoff } from './llm-resilience'\nexport async function go() { ${calls} }\n`
}

test('passes when both clients import and call withRetryBackoff at the required minima', () => {
  const root = makeFixture({
    openaiContent: goodClient(targetEntry(0).minCalls),
    anthropicContent: goodClient(targetEntry(1).minCalls),
  })
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
    anthropicContent: goodClient(targetEntry(1).minCalls),
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
    openaiContent: goodClient(targetEntry(0).minCalls),
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

test('fails when openai client falls below the strengthened ≥ 6 floor', () => {
  const root = makeFixture({
    // 1 call < 6 → fail
    openaiContent: goodClient(1),
    anthropicContent: goodClient(targetEntry(1).minCalls),
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /openai-execution-client.*1 time.*expected ≥ 6/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a leftover TODO(stage-s-followup) marker is present', () => {
  const root = makeFixture({
    openaiContent: `${goodClient(targetEntry(0).minCalls)}\n// TODO(stage-s-followup): wrap with withRetryBackoff\n`,
    anthropicContent: goodClient(targetEntry(1).minCalls),
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /leftover TODO\(stage-s-followup\)/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a target file is missing', () => {
  const root = makeFixture({ openaiContent: null, anthropicContent: goodClient(targetEntry(1).minCalls) })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /Missing/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
