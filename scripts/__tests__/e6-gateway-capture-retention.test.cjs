'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  retainValidatedE6GatewayCapture,
} = require('../codex-runtime/e6-gateway-capture.cjs')

function validRawCapture() {
  return {
    capturedAt: '2026-08-08T00:00:00.000Z',
    requestKind: 'product',
    readyRunId: 'ready-run-e6',
    threadId: 'thread-e6',
    turnId: 'turn-e6',
    requestDigest: 'a'.repeat(64),
    bodyBytes: 2048,
    instructionDigest: 'e'.repeat(64),
    inputDigest: 'b'.repeat(64),
    readyResourceReferenceCount: 1,
    toolsDigest: 'c'.repeat(64),
    toolNames: ['feishu_doc_read'],
    toolCount: 1,
    proofSentinelDigest: 'd'.repeat(64),
    proofSentinelOccurrences: 0,
    proofSentinels: [{ digest: 'd'.repeat(64), occurrences: 0 }],
    inputItems: [{
      index: 0,
      type: 'message',
      role: 'user',
      id: null,
      stringCount: 2,
      totalStringCharacters: 48,
      maxStringCharacters: 32,
      digest: 'f'.repeat(64),
    }],
  }
}

function validRetainedCapture() {
  const capture = validRawCapture()
  return {
    requestKind: capture.requestKind,
    readyRunId: capture.readyRunId,
    threadId: capture.threadId,
    turnId: capture.turnId,
    requestDigest: capture.requestDigest,
    inputDigest: capture.inputDigest,
    readyResourceReferenceCount: capture.readyResourceReferenceCount,
    toolsDigest: capture.toolsDigest,
    toolNames: capture.toolNames,
    toolCount: capture.toolCount,
    proofSentinels: capture.proofSentinels,
  }
}

function writeCapture(path, capture) {
  writeFileSync(path, `${JSON.stringify(capture)}\n`)
}

test('retains only the exact sanitized gateway schema after validation succeeds', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-gateway-retain-'))
  const sourcePath = join(fixtureRoot, 'source.ndjson')
  const targetPath = join(fixtureRoot, 'retained.ndjson')
  try {
    writeCapture(sourcePath, validRawCapture())
    const retained = retainValidatedE6GatewayCapture({
      sourcePath,
      targetPath,
      validate(rows) {
        assert.equal(rows.length, 1)
        return { accepted: true }
      },
    })
    assert.deepEqual(retained.validationResult, { accepted: true })
    assert.deepEqual(
      JSON.parse(readFileSync(targetPath, 'utf8').trim()),
      validRetainedCapture(),
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('extra body or credential fields fail before permanent retention', () => {
  const mutations = [
    (capture) => { capture.body = 'resource body must not persist' },
    (capture) => { capture.authorization = 'Bearer credential-must-not-persist' },
    (capture) => { capture.apiKey = 'credential-must-not-persist' },
    (capture) => { capture.proofSentinels[0].body = 'nested body must not persist' },
  ]
  for (const [index, mutate] of mutations.entries()) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-gateway-reject-'))
    const sourcePath = join(fixtureRoot, 'source.ndjson')
    const targetPath = join(fixtureRoot, 'retained.ndjson')
    try {
      const capture = validRawCapture()
      mutate(capture)
      writeCapture(sourcePath, capture)
      let validationCalled = false
      assert.throws(() => retainValidatedE6GatewayCapture({
        sourcePath,
        targetPath,
        validate() {
          validationCalled = true
        },
      }), /e6_gateway_capture_schema_invalid/, `mutation ${index}`)
      assert.equal(validationCalled, false)
      assert.equal(existsSync(targetPath), false)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }
})

test('a later evidence validation failure leaves no permanent capture', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-gateway-late-failure-'))
  const sourcePath = join(fixtureRoot, 'source.ndjson')
  const targetPath = join(fixtureRoot, 'retained.ndjson')
  try {
    writeCapture(sourcePath, validRawCapture())
    assert.throws(() => retainValidatedE6GatewayCapture({
      sourcePath,
      targetPath,
      validate() {
        throw new Error('e6_fixture_evidence_rejected')
      },
    }), /e6_fixture_evidence_rejected/)
    assert.equal(existsSync(targetPath), false)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
