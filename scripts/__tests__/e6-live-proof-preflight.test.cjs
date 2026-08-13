'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  parseE6LiveProofPreflight,
  assertValidatedE6LiveProofPlan,
  createSafePreflightReport,
} = require('../codex-runtime/e6-live-proof-preflight.cjs')

const ZERO_EFFECTS = {
  providerRequests: 0,
  feishuReads: 0,
  larkReads: 0,
  sourceDatabaseOpens: 0,
  sourceDatabaseWrites: 0,
  processSpawns: 0,
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function databaseFingerprint(path) {
  return [path, `${path}-wal`, `${path}-shm`].map((candidate) => {
    try {
      const stats = statSync(candidate)
      return {
        name: candidate.slice(path.length),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        sha256: sha256File(candidate),
      }
    } catch {
      return { name: candidate.slice(path.length), missing: true }
    }
  })
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-e6-preflight-'))
  const databasePath = join(root, 'ready.db')
  writeFileSync(databasePath, 'source-db-canary', 'utf8')
  writeFileSync(`${databasePath}-wal`, 'source-wal-canary', 'utf8')
  writeFileSync(`${databasePath}-shm`, 'source-shm-canary', 'utf8')
  const env = {
    READY_CODEX_E6_TARGET: 'all',
    READY_CODEX_REAL_DB_PATH: databasePath,
    READY_CODEX_E6_CHANNEL_ID: 'channel-opaque-canary',
    READY_CODEX_E6_DOC_TOKEN: 'feishu-doc-opaque-canary',
    READY_CODEX_E6_DOC_TYPE: 'docx',
    READY_CODEX_E6_DOC_REF: 'LarkDocRef_1234',
    READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID: 'feishu-logical-resource-opaque-canary',
    READY_CODEX_E6_FEISHU_RESOURCE_VERSION: 'feishu-resource-version-opaque-canary',
    READY_CODEX_E6_FEISHU_RESOURCE_DIGEST: 'a'.repeat(64),
    READY_CODEX_E6_FEISHU_EXPECTED_ANSWER: 'feishu-expected-answer-opaque-canary',
    READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID: 'lark-logical-resource-opaque-canary',
    READY_CODEX_E6_LARK_RESOURCE_VERSION: 'lark-resource-version-opaque-canary',
    READY_CODEX_E6_LARK_RESOURCE_DIGEST: 'b'.repeat(64),
    READY_CODEX_E6_LARK_EXPECTED_ANSWER: 'lark-expected-answer-opaque-canary',
    READY_CODEX_E6_POLICY_EPOCH: '1',
    READY_CODEX_E6_ITERATIONS: '3',
  }
  return { root, databasePath, env, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function assertSafeReport(report, forbiddenValues = []) {
  assert.deepEqual(report.effects, ZERO_EFFECTS)
  const serialized = JSON.stringify(report)
  for (const forbidden of forbiddenValues.filter(Boolean)) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(serialized, /api[_-]?key|app[_-]?secret|access[_-]?token|tenant[_-]?access[_-]?token|authorization|cookie|password|private[_-]?key/i)
  assert.equal(report.credentialSafety.opaqueValuesEmitted, false)
  assert.deepEqual(report.credentialSafety.sensitiveFieldsEmitted, [])
}

test('valid all-target preflight is deterministic, safe, and plans exactly 3+3', () => {
  const fx = fixture()
  try {
    const before = databaseFingerprint(fx.databasePath)
    const first = parseE6LiveProofPreflight(fx.env)
    const second = parseE6LiveProofPreflight({ ...fx.env })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.doesNotThrow(() => assertValidatedE6LiveProofPlan(first.plan))
    assert.equal(first.plan.validatedPlanDigest, second.plan.validatedPlanDigest)
    assert.deepEqual(first.plan.intendedRuns, { feishu: 3, lark: 3 })
    assert.deepEqual(first.plan.effects, ZERO_EFFECTS)
    assert.deepEqual(Object.keys(first).sort(), ['ok', 'plan'])
    const report = createSafePreflightReport(first)
    assert.equal(report.ok, true)
    assert.equal(report.target, 'all')
    assert.deepEqual(Object.keys(report).sort(), [
      'commitments',
      'credentialSafety',
      'effects',
      'intendedRuns',
      'ok',
      'phase',
      'proofMode',
      'schemaVersion',
      'target',
      'validatedPlanDigest',
    ])
    assertSafeReport(report, [
      fx.databasePath,
      fx.env.READY_CODEX_E6_CHANNEL_ID,
      fx.env.READY_CODEX_E6_DOC_TOKEN,
      fx.env.READY_CODEX_E6_DOC_REF,
      fx.env.READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID,
      fx.env.READY_CODEX_E6_FEISHU_RESOURCE_VERSION,
      fx.env.READY_CODEX_E6_FEISHU_RESOURCE_DIGEST,
      fx.env.READY_CODEX_E6_FEISHU_EXPECTED_ANSWER,
      fx.env.READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID,
      fx.env.READY_CODEX_E6_LARK_RESOURCE_VERSION,
      fx.env.READY_CODEX_E6_LARK_RESOURCE_DIGEST,
      fx.env.READY_CODEX_E6_LARK_EXPECTED_ANSWER,
    ])
    assert.deepEqual(databaseFingerprint(fx.databasePath), before)
  } finally {
    fx.cleanup()
  }
})

test('valid preflight-only target validates all inputs but plans no effects or runs', () => {
  const fx = fixture()
  try {
    const parsed = parseE6LiveProofPreflight({
      ...fx.env,
      READY_CODEX_E6_TARGET: 'preflight-only',
    })
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.plan.intendedRuns, { feishu: 0, lark: 0 })
    assert.deepEqual(parsed.plan.effects, ZERO_EFFECTS)
    assertSafeReport(createSafePreflightReport(parsed), [fx.databasePath])
  } finally {
    fx.cleanup()
  }
})

test('the same Feishu token and Lark document reference reject before any effect', () => {
  const fx = fixture()
  try {
    const before = databaseFingerprint(fx.databasePath)
    const parsed = parseE6LiveProofPreflight({
      ...fx.env,
      READY_CODEX_E6_DOC_TOKEN: fx.env.READY_CODEX_E6_DOC_REF,
    })
    assert.deepEqual(parsed, { ok: false, code: 'documents_not_distinct' })
    const report = createSafePreflightReport(parsed)
    assert.equal(report.code, 'documents_not_distinct')
    assertSafeReport(report, [
      fx.databasePath,
      fx.env.READY_CODEX_E6_DOC_REF,
    ])
    assert.deepEqual(databaseFingerprint(fx.databasePath), before)
  } finally {
    fx.cleanup()
  }
})

test('missing channel, documents, and digest reject with zero effects and no source DB mutation', () => {
  const fx = fixture()
  try {
    const cases = [
      ['READY_CODEX_E6_CHANNEL_ID', undefined, 'missing_channel_id'],
      ['READY_CODEX_E6_CHANNEL_ID', '   ', 'missing_channel_id'],
      ['READY_CODEX_E6_DOC_TOKEN', undefined, 'missing_document_token'],
      ['READY_CODEX_E6_DOC_REF', undefined, 'missing_lark_document_ref'],
      ['READY_CODEX_E6_FEISHU_RESOURCE_DIGEST', undefined, 'missing_feishu_resource_digest'],
      ['READY_CODEX_E6_LARK_RESOURCE_DIGEST', undefined, 'missing_lark_resource_digest'],
      ['READY_CODEX_E6_FEISHU_RESOURCE_DIGEST', 'not-a-digest-CREDENTIAL-CANARY', 'invalid_feishu_resource_digest'],
      ['READY_CODEX_E6_LARK_RESOURCE_DIGEST', 'not-a-digest-CREDENTIAL-CANARY', 'invalid_lark_resource_digest'],
    ]
    for (const [key, value, expectedCode] of cases) {
      const env = { ...fx.env }
      if (value === undefined) delete env[key]
      else env[key] = value
      env.OPENAI_API_KEY = 'provider-credential-canary'
      env.FEISHU_APP_SECRET = 'feishu-credential-canary'
      env.LARK_ACCESS_TOKEN = 'lark-credential-canary'
      const before = databaseFingerprint(fx.databasePath)
      const parsed = parseE6LiveProofPreflight(env)
      assert.deepEqual(parsed, { ok: false, code: expectedCode })
      const report = createSafePreflightReport(parsed)
      assert.equal(report.ok, false)
      assert.equal(report.code, expectedCode)
      assert.deepEqual(Object.keys(report).sort(), [
        'code',
        'credentialSafety',
        'effects',
        'ok',
        'phase',
        'proofMode',
        'schemaVersion',
      ])
      assertSafeReport(report, [
        fx.databasePath,
        'provider-credential-canary',
        'feishu-credential-canary',
        'lark-credential-canary',
        'CREDENTIAL-CANARY',
      ])
      assert.deepEqual(databaseFingerprint(fx.databasePath), before)
    }
  } finally {
    fx.cleanup()
  }
})

test('strict validation rejects every malformed contract field with constant safe codes', () => {
  const fx = fixture()
  try {
    const directoryPath = join(fx.root, 'not-a-database')
    mkdirSync(directoryPath)
    const cases = [
      ['READY_CODEX_E6_TARGET', '', 'missing_target'],
      ['READY_CODEX_E6_TARGET', 'feishu', 'invalid_target'],
      ['READY_CODEX_REAL_DB_PATH', '', 'missing_source_database'],
      ['READY_CODEX_REAL_DB_PATH', 'relative.db', 'source_database_path_not_absolute'],
      ['READY_CODEX_REAL_DB_PATH', join(fx.root, 'missing.db'), 'source_database_not_found'],
      ['READY_CODEX_REAL_DB_PATH', directoryPath, 'source_database_not_file'],
      ['READY_CODEX_E6_DOC_TYPE', '', 'missing_document_type'],
      ['READY_CODEX_E6_DOC_TYPE', 'wiki', 'invalid_document_type'],
      ['READY_CODEX_E6_DOC_TYPE', 'sheet', 'invalid_document_type'],
      ['READY_CODEX_E6_DOC_TYPE', 'bitable', 'invalid_document_type'],
      ['READY_CODEX_E6_DOC_REF', 'short', 'invalid_lark_document_ref'],
      ['READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID', '', 'missing_feishu_logical_resource_id'],
      ['READY_CODEX_E6_FEISHU_RESOURCE_VERSION', '', 'missing_feishu_resource_version'],
      ['READY_CODEX_E6_FEISHU_RESOURCE_DIGEST', 'A'.repeat(64), 'invalid_feishu_resource_digest'],
      ['READY_CODEX_E6_FEISHU_RESOURCE_DIGEST', 'a'.repeat(63), 'invalid_feishu_resource_digest'],
      ['READY_CODEX_E6_FEISHU_EXPECTED_ANSWER', '', 'missing_feishu_expected_answer'],
      ['READY_CODEX_E6_FEISHU_EXPECTED_ANSWER', 'A"B', 'invalid_feishu_expected_answer'],
      ['READY_CODEX_E6_FEISHU_EXPECTED_ANSWER', 'A\\B', 'invalid_feishu_expected_answer'],
      ['READY_CODEX_E6_FEISHU_EXPECTED_ANSWER', 'short', 'invalid_feishu_expected_answer'],
      ['READY_CODEX_E6_FEISHU_EXPECTED_ANSWER', 'x'.repeat(257), 'invalid_feishu_expected_answer'],
      ['READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID', '', 'missing_lark_logical_resource_id'],
      ['READY_CODEX_E6_LARK_RESOURCE_VERSION', '', 'missing_lark_resource_version'],
      ['READY_CODEX_E6_LARK_RESOURCE_DIGEST', 'B'.repeat(64), 'invalid_lark_resource_digest'],
      ['READY_CODEX_E6_LARK_RESOURCE_DIGEST', 'b'.repeat(63), 'invalid_lark_resource_digest'],
      ['READY_CODEX_E6_LARK_EXPECTED_ANSWER', '', 'missing_lark_expected_answer'],
      ['READY_CODEX_E6_LARK_EXPECTED_ANSWER', 'A"B', 'invalid_lark_expected_answer'],
      ['READY_CODEX_E6_LARK_EXPECTED_ANSWER', 'A\\B', 'invalid_lark_expected_answer'],
      ['READY_CODEX_E6_LARK_EXPECTED_ANSWER', 'short', 'invalid_lark_expected_answer'],
      ['READY_CODEX_E6_LARK_EXPECTED_ANSWER', 'x'.repeat(257), 'invalid_lark_expected_answer'],
      ['READY_CODEX_E6_POLICY_EPOCH', '', 'missing_policy_epoch'],
      ['READY_CODEX_E6_POLICY_EPOCH', '0', 'invalid_policy_epoch'],
      ['READY_CODEX_E6_POLICY_EPOCH', '1.5', 'invalid_policy_epoch'],
      ['READY_CODEX_E6_ITERATIONS', '', 'missing_iterations'],
      ['READY_CODEX_E6_ITERATIONS', '2', 'invalid_iterations'],
    ]
    for (const [key, value, expectedCode] of cases) {
      const parsed = parseE6LiveProofPreflight({ ...fx.env, [key]: value })
      assert.deepEqual(parsed, { ok: false, code: expectedCode })
      assertSafeReport(createSafePreflightReport(parsed), [fx.databasePath])
    }
    const sameAnswers = parseE6LiveProofPreflight({
      ...fx.env,
      READY_CODEX_E6_LARK_EXPECTED_ANSWER: fx.env.READY_CODEX_E6_FEISHU_EXPECTED_ANSWER,
    })
    assert.deepEqual(sameAnswers, { ok: false, code: 'expected_answers_not_distinct' })
    assertSafeReport(createSafePreflightReport(sameAnswers), [fx.databasePath])

    for (const [feishuAnswer, larkAnswer] of [
      ['ABCDEFGHIJKLMNOPQRSTUVWX', 'ABCDEFGHIJKLMNOPQRSTUVWXY'],
      ['ABCDEFGHIJKLMNOPQRSTUVWXY', 'ABCDEFGHIJKLMNOPQRSTUVWX'],
    ]) {
      const overlappingAnswers = parseE6LiveProofPreflight({
        ...fx.env,
        READY_CODEX_E6_FEISHU_EXPECTED_ANSWER: feishuAnswer,
        READY_CODEX_E6_LARK_EXPECTED_ANSWER: larkAnswer,
      })
      assert.deepEqual(overlappingAnswers, { ok: false, code: 'expected_answers_overlap' })
      const overlapReport = createSafePreflightReport(overlappingAnswers)
      assert.equal(overlapReport.code, 'expected_answers_overlap')
      assertSafeReport(overlapReport, [fx.databasePath])
    }

    const answerAsDocumentRef = parseE6LiveProofPreflight({
      ...fx.env,
      READY_CODEX_E6_DOC_REF: fx.env.READY_CODEX_E6_LARK_EXPECTED_ANSWER,
    })
    assert.deepEqual(answerAsDocumentRef, { ok: false, code: 'expected_answer_exposed_by_input' })
    assertSafeReport(createSafePreflightReport(answerAsDocumentRef), [fx.databasePath])

    const answerInsideLogicalId = parseE6LiveProofPreflight({
      ...fx.env,
      READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID:
        `resource-${fx.env.READY_CODEX_E6_LARK_EXPECTED_ANSWER}`,
    })
    assert.deepEqual(answerInsideLogicalId, { ok: false, code: 'expected_answer_exposed_by_input' })
    assertSafeReport(createSafePreflightReport(answerInsideLogicalId), [fx.databasePath])
  } finally {
    fx.cleanup()
  }
})

test('every Feishu and Lark resource field is mandatory and legacy generic fields never substitute', () => {
  const fx = fixture()
  try {
    const cases = [
      ['READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID', 'missing_feishu_logical_resource_id'],
      ['READY_CODEX_E6_FEISHU_RESOURCE_VERSION', 'missing_feishu_resource_version'],
      ['READY_CODEX_E6_FEISHU_RESOURCE_DIGEST', 'missing_feishu_resource_digest'],
      ['READY_CODEX_E6_FEISHU_EXPECTED_ANSWER', 'missing_feishu_expected_answer'],
      ['READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID', 'missing_lark_logical_resource_id'],
      ['READY_CODEX_E6_LARK_RESOURCE_VERSION', 'missing_lark_resource_version'],
      ['READY_CODEX_E6_LARK_RESOURCE_DIGEST', 'missing_lark_resource_digest'],
      ['READY_CODEX_E6_LARK_EXPECTED_ANSWER', 'missing_lark_expected_answer'],
    ]
    for (const [missingKey, expectedCode] of cases) {
      const env = {
        ...fx.env,
        READY_CODEX_E6_LOGICAL_RESOURCE_ID: 'legacy-logical-resource-canary',
        READY_CODEX_E6_RESOURCE_VERSION: 'legacy-resource-version-canary',
        READY_CODEX_E6_RESOURCE_DIGEST: 'c'.repeat(64),
        READY_CODEX_E6_EXPECTED_ANSWER: 'legacy-expected-answer-canary',
      }
      delete env[missingKey]
      const parsed = parseE6LiveProofPreflight(env)
      assert.deepEqual(parsed, { ok: false, code: expectedCode })
      assertSafeReport(createSafePreflightReport(parsed), [
        'legacy-logical-resource-canary',
        'legacy-resource-version-canary',
        'legacy-expected-answer-canary',
      ])
    }
  } finally {
    fx.cleanup()
  }
})

test('preflight reads only its env whitelist and never touches credential getters', () => {
  const fx = fixture()
  try {
    const env = { ...fx.env }
    for (const key of ['OPENAI_API_KEY', 'FEISHU_APP_SECRET', 'LARK_ACCESS_TOKEN', 'COOKIE']) {
      Object.defineProperty(env, key, {
        enumerable: true,
        get() { throw new Error(`credential getter accessed: ${key}`) },
      })
    }
    const parsed = parseE6LiveProofPreflight(env)
    assert.equal(parsed.ok, true)
    assertSafeReport(createSafePreflightReport(parsed), [fx.databasePath])
  } finally {
    fx.cleanup()
  }
})

test('cross-swapped Feishu and Lark commitments are rejected', () => {
  const fx = fixture()
  try {
    const parsed = parseE6LiveProofPreflight(fx.env)
    assert.equal(parsed.ok, true)
    const swapped = {
      ...parsed.plan,
      commitments: {
        ...parsed.plan.commitments,
        feishu: parsed.plan.commitments.lark,
        lark: parsed.plan.commitments.feishu,
      },
    }
    assert.throws(
      () => assertValidatedE6LiveProofPlan(swapped),
      (error) => error instanceof Error && error.message === 'invalid_validated_plan',
    )
    const report = createSafePreflightReport({ ok: true, plan: swapped })
    assert.equal(report.code, 'invalid_validated_plan')
    assertSafeReport(report, [fx.databasePath])
  } finally {
    fx.cleanup()
  }
})

test('mutated, forged, or extra-field plans fail validation without echoing their payload', () => {
  const fx = fixture()
  try {
    const parsed = parseE6LiveProofPreflight(fx.env)
    assert.equal(parsed.ok, true)
    const mutationCases = [
      JSON.parse(JSON.stringify(parsed.plan)),
      { ...parsed.plan, validatedIterations: 2 },
      { ...parsed.plan, target: 'all', intendedRuns: { feishu: 2, lark: 3 } },
      {
        ...parsed.plan,
        commitments: {
          ...parsed.plan.commitments,
          feishu: { ...parsed.plan.commitments.feishu, channelId: 'b'.repeat(64) },
        },
      },
      { ...parsed.plan, effects: { ...parsed.plan.effects, providerRequests: 1 } },
      { ...parsed.plan, extra: 'forged-secret-canary' },
      { schemaVersion: 1, phase: 'E6', validatedPlanDigest: 'c'.repeat(64) },
    ]
    for (const forged of mutationCases) {
      assert.throws(
        () => assertValidatedE6LiveProofPlan(forged),
        (error) => error instanceof Error && error.message === 'invalid_validated_plan',
      )
      const report = createSafePreflightReport({ ok: true, plan: forged })
      assert.equal(report.code, 'invalid_validated_plan')
      assertSafeReport(report, ['forged-secret-canary', fx.databasePath])
    }
    const maliciousFailure = createSafePreflightReport({
      ok: false,
      code: 'app_secret=malicious-secret-canary',
    })
    assert.equal(maliciousFailure.code, 'invalid_preflight_result')
    assertSafeReport(maliciousFailure, ['malicious-secret-canary'])
  } finally {
    fx.cleanup()
  }
})
