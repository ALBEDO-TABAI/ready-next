'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  observedEffectCounts,
  safeGatewayCaptureStats,
} = require('../codex-runtime/e6-failure-observation.cjs')

test('unreadable receipt evidence is unknown rather than confirmed zero', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-observation-'))
  const corruptDatabase = join(fixtureRoot, 'corrupt.db')
  try {
    writeFileSync(corruptDatabase, 'not-a-sqlite-database')
    assert.deepEqual(observedEffectCounts(corruptDatabase, () => {
      throw new Error('database locked or corrupt')
    }), { verified: false, feishuReads: null, larkReads: null })
    assert.deepEqual(observedEffectCounts(join(fixtureRoot, 'missing.db'), () => []), {
      verified: false,
      feishuReads: null,
      larkReads: null,
    })
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('malformed gateway lines are never counted as observed admissions', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-capture-'))
  const capturePath = join(fixtureRoot, 'capture.ndjson')
  try {
    writeFileSync(capturePath, [
      JSON.stringify({
        requestKind: 'product',
        readyRunId: 'run-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        requestDigest: 'a'.repeat(64),
      }),
      '{malformed',
      JSON.stringify({ requestKind: 'product' }),
      '',
    ].join('\n'))
    assert.deepEqual(safeGatewayCaptureStats(capturePath), {
      verified: false,
      validLineCount: null,
      malformedLineCount: 2,
    })
    assert.deepEqual(safeGatewayCaptureStats(join(fixtureRoot, 'missing.ndjson')), {
      verified: false,
      validLineCount: null,
      malformedLineCount: 0,
    })
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
