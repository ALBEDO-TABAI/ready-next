'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  verifyAiSeedReleaseSafety,
  verifyAiSeedReleaseSafetyFile,
} = require('../check-ai-seed-release-safety.cjs')

test('empty AI seed is safe for a normal release build', () => {
  assert.deepEqual(verifyAiSeedReleaseSafety('{}\n'), {
    entryCount: 0,
    overrideUsed: false,
  })
})

test('non-empty AI seed is rejected by default without exposing its values', () => {
  assert.throws(
    () => verifyAiSeedReleaseSafety('{"ai_model_config":{"apiKey":"fixture-secret"}}'),
    (error) => {
      assert.match(error.message, /non-empty/)
      assert.doesNotMatch(error.message, /fixture-secret/)
      return true
    },
  )
})

test('explicit controlled-build override accepts a non-empty AI seed', () => {
  assert.deepEqual(
    verifyAiSeedReleaseSafety('{"ai_model_config":{}}', { allowBakedSeed: true }),
    { entryCount: 1, overrideUsed: true },
  )
})

test('malformed or non-object AI seeds are rejected even with the override', () => {
  assert.throws(
    () => verifyAiSeedReleaseSafety('{not json', { allowBakedSeed: true }),
    /not valid JSON/,
  )
  assert.throws(
    () => verifyAiSeedReleaseSafety('[]', { allowBakedSeed: true }),
    /must be a JSON object/,
  )
})

test('file check fails closed when the configured seed is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-ai-seed-safety-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(
    () => verifyAiSeedReleaseSafetyFile(path.join(root, 'missing.json')),
    /seed is missing/,
  )
})
