'use strict'

const { createHash } = require('node:crypto')
const { statSync } = require('node:fs')
const { isAbsolute, resolve } = require('node:path')

const SCHEMA_VERSION = 1
const PHASE = 'E6'
const TARGETS = new Set(['all', 'preflight-only'])
const DOC_TYPES = new Set(['doc', 'docx'])
const LARK_DOC_REF = /^[A-Za-z0-9_-]{8,256}$/
const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/
const POSITIVE_INTEGER = /^[1-9][0-9]*$/
const PROOF_SENTINEL = /^[A-Za-z0-9_-]{24,128}$/

const ENV_KEYS = Object.freeze({
  target: 'READY_CODEX_E6_TARGET',
  sourceDatabasePath: 'READY_CODEX_REAL_DB_PATH',
  channelId: 'READY_CODEX_E6_CHANNEL_ID',
  documentToken: 'READY_CODEX_E6_DOC_TOKEN',
  documentType: 'READY_CODEX_E6_DOC_TYPE',
  larkDocumentRef: 'READY_CODEX_E6_DOC_REF',
  feishuLogicalResourceId: 'READY_CODEX_E6_FEISHU_LOGICAL_RESOURCE_ID',
  feishuResourceVersion: 'READY_CODEX_E6_FEISHU_RESOURCE_VERSION',
  feishuResourceDigest: 'READY_CODEX_E6_FEISHU_RESOURCE_DIGEST',
  feishuExpectedAnswer: 'READY_CODEX_E6_FEISHU_EXPECTED_ANSWER',
  larkLogicalResourceId: 'READY_CODEX_E6_LARK_LOGICAL_RESOURCE_ID',
  larkResourceVersion: 'READY_CODEX_E6_LARK_RESOURCE_VERSION',
  larkResourceDigest: 'READY_CODEX_E6_LARK_RESOURCE_DIGEST',
  larkExpectedAnswer: 'READY_CODEX_E6_LARK_EXPECTED_ANSWER',
  policyEpoch: 'READY_CODEX_E6_POLICY_EPOCH',
  iterations: 'READY_CODEX_E6_ITERATIONS',
})

const ERROR_CODES = new Set([
  'invalid_environment',
  'missing_target',
  'invalid_target',
  'missing_source_database',
  'source_database_path_not_absolute',
  'source_database_not_found',
  'source_database_not_file',
  'missing_channel_id',
  'missing_document_token',
  'missing_document_type',
  'invalid_document_type',
  'missing_lark_document_ref',
  'invalid_lark_document_ref',
  'documents_not_distinct',
  'missing_feishu_logical_resource_id',
  'missing_feishu_resource_version',
  'missing_feishu_resource_digest',
  'invalid_feishu_resource_digest',
  'missing_feishu_expected_answer',
  'invalid_feishu_expected_answer',
  'missing_lark_logical_resource_id',
  'missing_lark_resource_version',
  'missing_lark_resource_digest',
  'invalid_lark_resource_digest',
  'missing_lark_expected_answer',
  'invalid_lark_expected_answer',
  'expected_answers_not_distinct',
  'expected_answers_overlap',
  'expected_answer_exposed_by_input',
  'missing_policy_epoch',
  'invalid_policy_epoch',
  'missing_iterations',
  'invalid_iterations',
  'invalid_validated_plan',
  'invalid_preflight_result',
])

const ZERO_EFFECTS = Object.freeze({
  providerRequests: 0,
  feishuReads: 0,
  larkReads: 0,
  sourceDatabaseOpens: 0,
  sourceDatabaseWrites: 0,
  processSpawns: 0,
})

const CREDENTIAL_SAFETY = Object.freeze({
  opaqueValuesEmitted: false,
  sensitiveFieldsEmitted: Object.freeze([]),
})
const ISSUED_PLANS = new WeakSet()

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function commitment(name, value) {
  return sha256(`${name}\0${value}`)
}

function trimmed(env, key) {
  const value = env[key]
  return typeof value === 'string' ? value.trim() : ''
}

function reject(code) {
  return Object.freeze({ ok: false, code })
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function buildPlan(input) {
  const planBody = {
    schemaVersion: SCHEMA_VERSION,
    phase: PHASE,
    target: input.target,
    validatedIterations: 3,
    intendedRuns: {
      feishu: input.target === 'all' ? 3 : 0,
      lark: input.target === 'all' ? 3 : 0,
    },
    commitments: {
      sourceDatabasePath: commitment('source_database_path', input.sourceDatabasePath),
      policyEpoch: commitment('policy_epoch', input.policyEpoch),
      feishu: {
        channelId: commitment('feishu_channel_id', input.channelId),
        documentToken: commitment('feishu_document_token', input.documentToken),
        documentType: commitment('feishu_document_type', input.documentType),
        logicalResourceId: commitment('feishu_logical_resource_id', input.feishuLogicalResourceId),
        resourceVersion: commitment('feishu_resource_version', input.feishuResourceVersion),
        resourceDigest: commitment('feishu_resource_digest', input.feishuResourceDigest),
        expectedAnswer: commitment('feishu_expected_answer', input.feishuExpectedAnswer),
      },
      lark: {
        documentRef: commitment('lark_document_ref', input.larkDocumentRef),
        logicalResourceId: commitment('lark_logical_resource_id', input.larkLogicalResourceId),
        resourceVersion: commitment('lark_resource_version', input.larkResourceVersion),
        resourceDigest: commitment('lark_resource_digest', input.larkResourceDigest),
        expectedAnswer: commitment('lark_expected_answer', input.larkExpectedAnswer),
      },
    },
    effects: { ...ZERO_EFFECTS },
  }
  const plan = deepFreeze({
    ...planBody,
    validatedPlanDigest: sha256(canonicalJson(planBody)),
  })
  ISSUED_PLANS.add(plan)
  return plan
}

function parseE6LiveProofPreflight(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return reject('invalid_environment')
  }

  // Deliberately access only ENV_KEYS. In particular, provider and connector
  // credentials are neither read nor copied into the preflight plan.
  const target = trimmed(env, ENV_KEYS.target)
  if (!target) return reject('missing_target')
  if (!TARGETS.has(target)) return reject('invalid_target')

  const sourceDatabaseInput = trimmed(env, ENV_KEYS.sourceDatabasePath)
  if (!sourceDatabaseInput) return reject('missing_source_database')
  if (!isAbsolute(sourceDatabaseInput)) return reject('source_database_path_not_absolute')
  const sourceDatabasePath = resolve(sourceDatabaseInput)
  let sourceDatabaseStat
  try {
    sourceDatabaseStat = statSync(sourceDatabasePath)
  } catch {
    return reject('source_database_not_found')
  }
  if (!sourceDatabaseStat.isFile()) return reject('source_database_not_file')

  const channelId = trimmed(env, ENV_KEYS.channelId)
  if (!channelId) return reject('missing_channel_id')
  const documentToken = trimmed(env, ENV_KEYS.documentToken)
  if (!documentToken) return reject('missing_document_token')
  const documentType = trimmed(env, ENV_KEYS.documentType)
  if (!documentType) return reject('missing_document_type')
  if (!DOC_TYPES.has(documentType)) return reject('invalid_document_type')
  const larkDocumentRef = trimmed(env, ENV_KEYS.larkDocumentRef)
  if (!larkDocumentRef) return reject('missing_lark_document_ref')
  if (!LARK_DOC_REF.test(larkDocumentRef)) return reject('invalid_lark_document_ref')
  if (documentToken === larkDocumentRef) return reject('documents_not_distinct')

  const feishuLogicalResourceId = trimmed(env, ENV_KEYS.feishuLogicalResourceId)
  if (!feishuLogicalResourceId) return reject('missing_feishu_logical_resource_id')
  const feishuResourceVersion = trimmed(env, ENV_KEYS.feishuResourceVersion)
  if (!feishuResourceVersion) return reject('missing_feishu_resource_version')
  const feishuResourceDigest = trimmed(env, ENV_KEYS.feishuResourceDigest)
  if (!feishuResourceDigest) return reject('missing_feishu_resource_digest')
  if (!LOWERCASE_SHA256.test(feishuResourceDigest)) return reject('invalid_feishu_resource_digest')
  const feishuExpectedAnswer = trimmed(env, ENV_KEYS.feishuExpectedAnswer)
  if (!feishuExpectedAnswer) return reject('missing_feishu_expected_answer')
  if (!PROOF_SENTINEL.test(feishuExpectedAnswer)) return reject('invalid_feishu_expected_answer')

  const larkLogicalResourceId = trimmed(env, ENV_KEYS.larkLogicalResourceId)
  if (!larkLogicalResourceId) return reject('missing_lark_logical_resource_id')
  const larkResourceVersion = trimmed(env, ENV_KEYS.larkResourceVersion)
  if (!larkResourceVersion) return reject('missing_lark_resource_version')
  const larkResourceDigest = trimmed(env, ENV_KEYS.larkResourceDigest)
  if (!larkResourceDigest) return reject('missing_lark_resource_digest')
  if (!LOWERCASE_SHA256.test(larkResourceDigest)) return reject('invalid_lark_resource_digest')
  const larkExpectedAnswer = trimmed(env, ENV_KEYS.larkExpectedAnswer)
  if (!larkExpectedAnswer) return reject('missing_lark_expected_answer')
  if (!PROOF_SENTINEL.test(larkExpectedAnswer)) return reject('invalid_lark_expected_answer')
  if (larkExpectedAnswer === feishuExpectedAnswer) return reject('expected_answers_not_distinct')
  if (larkExpectedAnswer.includes(feishuExpectedAnswer)
    || feishuExpectedAnswer.includes(larkExpectedAnswer)) {
    return reject('expected_answers_overlap')
  }
  const publicReadInputs = [
    channelId,
    documentToken,
    documentType,
    larkDocumentRef,
    feishuLogicalResourceId,
    feishuResourceVersion,
    feishuResourceDigest,
    larkLogicalResourceId,
    larkResourceVersion,
    larkResourceDigest,
  ]
  if ([feishuExpectedAnswer, larkExpectedAnswer].some(
    (answer) => publicReadInputs.some((value) => value.includes(answer)),
  )) return reject('expected_answer_exposed_by_input')
  const policyEpoch = trimmed(env, ENV_KEYS.policyEpoch)
  if (!policyEpoch) return reject('missing_policy_epoch')
  if (!POSITIVE_INTEGER.test(policyEpoch) || !Number.isSafeInteger(Number(policyEpoch))) {
    return reject('invalid_policy_epoch')
  }
  const iterations = trimmed(env, ENV_KEYS.iterations)
  if (!iterations) return reject('missing_iterations')
  if (iterations !== '3') return reject('invalid_iterations')

  const plan = buildPlan({
    target,
    sourceDatabasePath,
    channelId,
    documentToken,
    documentType,
    larkDocumentRef,
    feishuLogicalResourceId,
    feishuResourceVersion,
    feishuResourceDigest,
    feishuExpectedAnswer,
    larkLogicalResourceId,
    larkResourceVersion,
    larkResourceDigest,
    larkExpectedAnswer,
    policyEpoch,
  })
  return deepFreeze({ ok: true, plan })
}

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(code)
}

function assertSha256(value, code) {
  if (typeof value !== 'string' || !LOWERCASE_SHA256.test(value)) throw new Error(code)
}

function assertValidatedE6LiveProofPlan(plan) {
  const code = 'invalid_validated_plan'
  if (!plan || typeof plan !== 'object' || !ISSUED_PLANS.has(plan)) throw new Error(code)
  assertExactKeys(plan, [
    'schemaVersion',
    'phase',
    'target',
    'validatedIterations',
    'intendedRuns',
    'commitments',
    'effects',
    'validatedPlanDigest',
  ], code)
  if (plan.schemaVersion !== SCHEMA_VERSION
    || plan.phase !== PHASE
    || !TARGETS.has(plan.target)
    || plan.validatedIterations !== 3) throw new Error(code)
  assertExactKeys(plan.intendedRuns, ['feishu', 'lark'], code)
  const expectedRuns = plan.target === 'all' ? 3 : 0
  if (plan.intendedRuns.feishu !== expectedRuns || plan.intendedRuns.lark !== expectedRuns) {
    throw new Error(code)
  }
  assertExactKeys(plan.commitments, [
    'sourceDatabasePath',
    'policyEpoch',
    'feishu',
    'lark',
  ], code)
  assertSha256(plan.commitments.sourceDatabasePath, code)
  assertSha256(plan.commitments.policyEpoch, code)
  assertExactKeys(plan.commitments.feishu, [
    'channelId',
    'documentToken',
    'documentType',
    'logicalResourceId',
    'resourceVersion',
    'resourceDigest',
    'expectedAnswer',
  ], code)
  assertExactKeys(plan.commitments.lark, [
    'documentRef',
    'logicalResourceId',
    'resourceVersion',
    'resourceDigest',
    'expectedAnswer',
  ], code)
  for (const value of Object.values(plan.commitments.feishu)) assertSha256(value, code)
  for (const value of Object.values(plan.commitments.lark)) assertSha256(value, code)
  assertExactKeys(plan.effects, Object.keys(ZERO_EFFECTS), code)
  if (canonicalJson(plan.effects) !== canonicalJson(ZERO_EFFECTS)) throw new Error(code)
  assertSha256(plan.validatedPlanDigest, code)
  const { validatedPlanDigest, ...planBody } = plan
  if (sha256(canonicalJson(planBody)) !== validatedPlanDigest) throw new Error(code)
  return plan
}

function safeFailureReport(code) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    phase: PHASE,
    proofMode: 'zero-request-preflight',
    ok: false,
    code,
    effects: { ...ZERO_EFFECTS },
    credentialSafety: {
      opaqueValuesEmitted: CREDENTIAL_SAFETY.opaqueValuesEmitted,
      sensitiveFieldsEmitted: [],
    },
  })
}

function createSafePreflightReport(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return safeFailureReport('invalid_preflight_result')
  }
  if (result.ok !== true) {
    return safeFailureReport(
      typeof result.code === 'string' && ERROR_CODES.has(result.code)
        ? result.code
        : 'invalid_preflight_result',
    )
  }
  try {
    assertExactKeys(result, ['ok', 'plan'], 'invalid_validated_plan')
    const plan = assertValidatedE6LiveProofPlan(result.plan)
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      phase: PHASE,
      proofMode: 'zero-request-preflight',
      ok: true,
      target: plan.target,
      validatedPlanDigest: plan.validatedPlanDigest,
      intendedRuns: { ...plan.intendedRuns },
      commitments: { ...plan.commitments },
      effects: { ...ZERO_EFFECTS },
      credentialSafety: {
        opaqueValuesEmitted: CREDENTIAL_SAFETY.opaqueValuesEmitted,
        sensitiveFieldsEmitted: [],
      },
    })
  } catch {
    return safeFailureReport('invalid_validated_plan')
  }
}

module.exports = {
  parseE6LiveProofPreflight,
  assertValidatedE6LiveProofPlan,
  createSafePreflightReport,
}
