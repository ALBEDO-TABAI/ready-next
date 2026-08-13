'use strict'

const { createHash } = require('node:crypto')
const {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} = require('node:fs')
const { basename, relative, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const { buildOutputManifest, buildSourceManifest } = require('../browser-live-proof-manifest.cjs')
const {
  auditRoot,
  canonicalJson,
  digestFile,
  digestJson,
  readJson,
  repoRoot,
} = require('./contract-lib.cjs')
const {
  validateRetainedE6GatewayCapture,
} = require('./e6-gateway-capture.cjs')
const {
  EXPECTED_DOCX_URL,
  EXPECTED_SHEET_URL,
  assertNoAmbientExecutionInjection,
  columnNameForNumber,
  docxTaskMarkerForProofId,
  readCurrentLarkCliAuthority,
  sheetSentinelForProofId,
} = require('./e6-user-scenario-authority.cjs')
const {
  ALLOWED_TOOLS: USER_SCENARIO_ALLOWED_TOOLS,
  PROOF_MODE: USER_SCENARIO_PROOF_MODE,
  assertE6UserScenarioRelationalLedger,
} = require('./e6-user-scenario-evidence.cjs')
const {
  E6_AUTHORITY_ROOT,
  acquireE6GlobalLease,
  releaseE6GlobalLease,
} = require('./e6-global-lease.cjs')

const SHA256 = /^[a-f0-9]{64}$/
const PROOF_ID = /^[a-f0-9]{40}$/
const REPORT_KEYS = [
  'artifacts', 'credentialSafety', 'evidence', 'generatedAt', 'handshake', 'ok', 'phase',
  'proofId', 'proofMode', 'runtimeMode', 'schemaVersion', 'shutdown',
  'sourceDatabaseUnchanged', 'sourceManifest', 'validatedPlanDigest',
]
const COMPLETION_KEYS = [
  'artifacts', 'buildProvenance', 'buildToolchainProvenance', 'completedAt',
  'credentialSafety', 'electronGypProvenance', 'handshake', 'outputManifestDigest', 'phase',
  'proofId', 'proofMode', 'schemaVersion', 'shutdown', 'sidecarEnvironmentProvenance',
  'sidecarPythonProvenance', 'sourceDatabase', 'sourceManifestDigest', 'validatedPlanDigest',
]
const HANDSHAKE_KEYS = [
  'appPath', 'appVersion', 'asarPath', 'asarSha256', 'databasePath', 'execPath',
  'execSha256', 'ok', 'proofNonce', 'runtimeOutputManifestDigest', 'sourceManifestDigest',
  'userDataPath',
]
const USER_HANDSHAKE_KEYS = [...HANDSHAKE_KEYS, 'pid', 'processStartIdentityDigest']
const SHUTDOWN_KEYS = [
  'cleanupObservationFailed', 'forcedMainShutdown', 'forcedTreeCleanup',
  'gracefulQuitAccepted', 'leaseProcessesZeroConfirmed', 'leaseTreeZeroConfirmed',
  'mainExitCode', 'mainSignalCode', 'processGroupsZeroConfirmed', 'recordedProcessCount',
  'recordedProcessIdentityDigest', 'sensitiveCleanupConfirmed',
]
const EVIDENCE_KEYS = [
  'ignoredUnstartedThreadCount', 'phase', 'proofMode', 'providerIdentity',
  'providerRequestCount', 'protocolSchemaDigest', 'runCount', 'runs',
  'runtimeManifestDigest', 'schemaVersion', 'sidecarLeaseCount', 'toolCallCount',
]
const RUN_KEYS = [
  'dependencySnapshotDigest', 'kind', 'methodConstraintDigest', 'providerRequestCount',
  'scopeIdDigest', 'threadIdDigest', 'toolCallCount', 'toolSurfaceDigest', 'turnIdDigest',
]
const USER_EVIDENCE_KEYS = [
  'cliAuthIdentity', 'cliIdentity', 'confirmationCount', 'confirmations', 'phase', 'proofMode',
  'protocolSchemaDigest', 'providerIdentity', 'providerRequestCount', 'resources',
  'runCount', 'runs', 'runtimeManifestDigest', 'schemaVersion', 'sidecarLeaseCount',
  'toolCallCount',
]
const USER_RUN_KEYS = [
  'authorizationSnapshotDigest', 'kind', 'providerRequestCount', 'publicationReceiptDigest',
  'readyRunIdDigest', 'scopeIdDigest', 'threadIdDigest', 'toolCallCount',
  'toolSurfaceDigest', 'turnIdDigest',
]
const USER_CONFIRMATION_KEYS = ['argsDigest', 'idDigest', 'releasedAtDigest']
const USER_SHEET_KEYS = [
  'columnCountAfter', 'columnCountAfterInsert', 'columnCountBefore',
  'commandAuthorityBindingDigest',
  'insertArgsDigest', 'insertCallIdDigest',
  'insertResultDigest', 'insertedColumn', 'postInsertInfoCallIdDigest',
  'postInsertInfoContentDigest', 'postInsertInfoResultDigest',
  'postInsertRevisionCallIdDigest', 'postInsertRevisionContentDigest',
  'postInsertRevisionResultDigest', 'postInsertTemplateCallIdDigest',
  'postInsertTemplateContentDigest', 'postInsertTemplateResultDigest',
  'preInsertStructureCallIdDigest', 'preInsertStructureContentDigest',
  'preInsertStructureResultDigest', 'preInsertTemplateCallIdDigest',
  'preInsertTemplateContentDigest', 'preInsertTemplateResultDigest',
  'readbackCallIdDigest',
  'readbackContentDigest', 'readbackResultDigest', 'referenceDigest', 'revisionAfter',
  'revisionAfterInsert', 'revisionBefore', 'sentinelDigest', 'templateStyleDigest',
  'writeArgsDigest', 'writeCallIdDigest', 'writeResultDigest',
]
const USER_DOCX_KEYS = [
  'commandAuthorityBindingDigest', 'originalSentenceDigest', 'polishedSentenceDigest',
  'preReadCallIdDigest',
  'preReadContentDigest', 'preReadResultDigest', 'readbackCallIdDigest',
  'readbackContentDigest', 'readbackResultDigest', 'referenceDigest', 'revisionAfter',
  'revisionBefore', 'taskMarkerDigest', 'writeArgsDigest', 'writeCallIdDigest',
  'writeResultDigest',
]
const PROMOTION_DRIFT_PATHS = new Set([
  'assets/codex-runtime/implementation-status.json',
  'docs/code-health/large-file-health-log.md',
  'docs/superpowers/audits/2026-08-08-codex-runtime-e6-blocked-report.md',
  'docs/superpowers/audits/2026-08-08-codex-runtime-e6-report.json',
  'docs/superpowers/plans/2026-08-06-cod-ready-codex-runtime-minimal-replacement-experiment.md',
])

function fail(code) {
  throw new Error(code)
}

function assert(condition, code) {
  if (!condition) fail(code)
}

function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort())
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value
}

function readJsonStrict(path, code) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { fail(code) }
}

function assertRegularFile(path, code) {
  assert(existsSync(path), code)
  const stats = lstatSync(path)
  assert(stats.isFile() && !stats.isSymbolicLink(), code)
}

function assertAuthorityRootIdentity(authorityRoot) {
  assert(existsSync(authorityRoot), 'e6_promotion_authority_root_invalid')
  const rootStats = lstatSync(authorityRoot)
  assert(rootStats.isDirectory() && !rootStats.isSymbolicLink()
    && rootStats.uid === process.getuid() && (rootStats.mode & 0o777) === 0o700,
  'e6_promotion_authority_root_invalid')
  const lockPath = resolve(authorityRoot, 'lease.lock')
  assert(existsSync(lockPath), 'e6_promotion_authority_root_invalid')
  const lockStats = lstatSync(lockPath)
  assert(lockStats.isFile() && !lockStats.isSymbolicLink()
    && lockStats.uid === process.getuid() && (lockStats.mode & 0o777) === 0o600,
  'e6_promotion_authority_root_invalid')
}

function assertAuthorityRootClean(authorityRoot) {
  assert(canonicalJson(readdirSync(authorityRoot).sort()) === canonicalJson(['lease.lock']),
    'e6_promotion_authority_root_not_clean')
}

function assertWithin(path, parent, code) {
  const child = relative(parent, path)
  assert(child && !child.startsWith('..') && !child.startsWith('/'), code)
}

function recomputeSourceDigest(files) {
  return createHash('sha256').update(
    files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(''),
  ).digest('hex')
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertSourceManifest(manifest, code) {
  assert(sameKeys(manifest, ['appVersion', 'branch', 'digest', 'files', 'head', 'version'])
    && manifest.version === 1 && SHA256.test(manifest.digest)
    && typeof manifest.head === 'string' && manifest.head.length > 0
    && typeof manifest.branch === 'string' && manifest.branch.length > 0
    && typeof manifest.appVersion === 'string' && manifest.appVersion.length > 0
    && Array.isArray(manifest.files), code)
  let previousPath = ''
  for (const file of manifest.files) {
    assert(sameKeys(file, ['bytes', 'path', 'sha256'])
      && typeof file.path === 'string' && file.path.length > 0
      && !file.path.startsWith('/') && !file.path.split('/').includes('..')
      && file.path > previousPath
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && SHA256.test(file.sha256), code)
    previousPath = file.path
  }
  assert(recomputeSourceDigest(manifest.files) === manifest.digest, code)
}

function assertNoSensitivePayload(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitivePayload(item)
    return
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /Bearer\s+[A-Za-z0-9._-]+/i.test(value)) {
      fail('e6_promotion_sensitive_payload_retained')
    }
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api.?key|authorization|body|content|cookie|headers|password|refresh.?token|secret|token)$/i
      .test(key)) fail('e6_promotion_sensitive_payload_retained')
    assertNoSensitivePayload(child)
  }
}

function assertSourcePromotionDrift(recorded, current) {
  assertSourceManifest(recorded, 'e6_promotion_recorded_source_invalid')
  assertSourceManifest(current, 'e6_promotion_current_source_invalid')
  assert(recorded.branch === current.branch
    && recorded.appVersion === current.appVersion,
  'e6_promotion_source_identity_drift')
  const stableFiles = (manifest) => manifest.files.filter(
    (file) => !PROMOTION_DRIFT_PATHS.has(file.path),
  )
  assert(canonicalJson(stableFiles(recorded)) === canonicalJson(stableFiles(current)),
    'e6_promotion_source_drift')
}

function successfulReports(outputRoot) {
  if (!existsSync(outputRoot)) return []
  const matches = []
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!PROOF_ID.test(entry.name)) continue
    assert(entry.isDirectory() && !entry.isSymbolicLink(), 'e6_promotion_output_root_invalid')
    const reportPath = resolve(outputRoot, entry.name, 'e6-live-proof-report.json')
    if (!existsSync(reportPath)) continue
    assertRegularFile(reportPath, 'e6_promotion_report_file_invalid')
    const report = readJsonStrict(reportPath, 'e6_promotion_report_json_invalid')
    if (report?.ok === true) matches.push(reportPath)
  }
  return matches
}

function assertShutdown(shutdown) {
  assert(sameKeys(shutdown, SHUTDOWN_KEYS)
    && shutdown.gracefulQuitAccepted === true
    && shutdown.forcedMainShutdown === false
    && shutdown.mainExitCode === 0
    && shutdown.mainSignalCode === null
    && shutdown.forcedTreeCleanup === false
    && shutdown.cleanupObservationFailed === false
    && shutdown.leaseTreeZeroConfirmed === true
    && shutdown.processGroupsZeroConfirmed === true
    && shutdown.leaseProcessesZeroConfirmed === true
    && shutdown.sensitiveCleanupConfirmed === true
    && Number.isSafeInteger(shutdown.recordedProcessCount)
    && shutdown.recordedProcessCount > 0
    && SHA256.test(shutdown.recordedProcessIdentityDigest),
  'e6_promotion_shutdown_invalid')
}

function assertEvidence(evidence, gatewayCapture, runtimeManifest) {
  assert(sameKeys(evidence, EVIDENCE_KEYS)
    && evidence.schemaVersion === 1
    && evidence.phase === 'E6'
    && evidence.proofMode === 'typed-and-cli-3-plus-3'
    && evidence.runCount === 6
    && Array.isArray(evidence.runs) && evidence.runs.length === 6
    && Number.isSafeInteger(evidence.toolCallCount) && evidence.toolCallCount > 0
    && Number.isSafeInteger(evidence.providerRequestCount)
    && evidence.providerRequestCount === gatewayCapture.length
    && evidence.ignoredUnstartedThreadCount === 1
    && Number.isSafeInteger(evidence.sidecarLeaseCount) && evidence.sidecarLeaseCount > 0
    && sameKeys(evidence.providerIdentity, [
      'endpointClass', 'endpointOriginDigest', 'modelDigest', 'providerId', 'snapshotDigest',
    ])
    && typeof evidence.providerIdentity.providerId === 'string'
    && evidence.providerIdentity.providerId.length > 0
    && !/(?:mock|test|fixture)/i.test(evidence.providerIdentity.providerId)
    && evidence.providerIdentity.endpointClass === 'trusted_public_https'
    && SHA256.test(evidence.providerIdentity.endpointOriginDigest)
    && SHA256.test(evidence.providerIdentity.modelDigest)
    && SHA256.test(evidence.providerIdentity.snapshotDigest),
  'e6_promotion_evidence_invalid')
  const kinds = evidence.runs.map((run) => run.kind)
  assert(canonicalJson(kinds) === canonicalJson([
    'feishu_typed_read', 'feishu_typed_read', 'feishu_typed_read',
    'lark_cli_read', 'lark_cli_read', 'lark_cli_read',
  ]),
  'e6_promotion_run_cardinality_invalid')
  assert(evidence.runs.every((run) => sameKeys(run, RUN_KEYS)
    && SHA256.test(run.scopeIdDigest)
    && SHA256.test(run.threadIdDigest) && SHA256.test(run.turnIdDigest)
    && SHA256.test(run.toolSurfaceDigest) && SHA256.test(run.methodConstraintDigest)
    && SHA256.test(run.dependencySnapshotDigest)
    && Number.isSafeInteger(run.toolCallCount) && run.toolCallCount > 0
    && Number.isSafeInteger(run.providerRequestCount) && run.providerRequestCount > 0),
  'e6_promotion_run_evidence_invalid')
  assert(evidence.runs.every((run) => (
    run.kind === 'feishu_typed_read'
      ? run.toolCallCount === 1 && run.providerRequestCount === 2
      : run.toolCallCount === 4 && run.providerRequestCount === 5
  )), 'e6_promotion_run_sequence_invalid')
  for (const kind of ['feishu_typed_read', 'lark_cli_read']) {
    const rows = evidence.runs.filter((run) => run.kind === kind)
    assert(new Set(rows.map((run) => run.toolSurfaceDigest)).size === 1
      && new Set(rows.map((run) => run.methodConstraintDigest)).size === 1
      && new Set(rows.map((run) => run.dependencySnapshotDigest)).size === 1,
    'e6_promotion_three_run_stability_invalid')
  }
  assert(new Set(evidence.runs.map((run) => run.scopeIdDigest)).size === 6
    && new Set(evidence.runs.map((run) => run.threadIdDigest)).size === 6
    && new Set(evidence.runs.map((run) => run.turnIdDigest)).size === 6
    && evidence.runs.reduce((total, run) => total + run.toolCallCount, 0)
      === evidence.toolCallCount
    && evidence.runs.reduce((total, run) => total + run.providerRequestCount, 0)
      === evidence.providerRequestCount,
  'e6_promotion_run_totals_invalid')
  const runtimeManifestDigest = digestJson(runtimeManifest)
  assert(evidence.runtimeManifestDigest === runtimeManifestDigest
    && evidence.protocolSchemaDigest === runtimeManifest.stableV2SchemaSha256,
  'e6_promotion_runtime_identity_invalid')
  assert(new Set(gatewayCapture.map((row) => row.requestDigest)).size === gatewayCapture.length
    && new Set(gatewayCapture.map((row) => row.readyRunId)).size === 6
    && gatewayCapture.every((row) => row.readyResourceReferenceCount === 1
      && row.proofSentinels.length === 3
      && new Set(row.proofSentinels.map((sentinel) => sentinel.digest)).size === 3),
  'e6_promotion_gateway_capture_invalid')
  const proofSentinelDigests = gatewayCapture[0]?.proofSentinels.map((row) => row.digest) || []
  assert(gatewayCapture.every((row) => canonicalJson(row.proofSentinels.map(
    (sentinel) => sentinel.digest,
  )) === canonicalJson(proofSentinelDigests)), 'e6_promotion_sentinel_identity_invalid')
  for (const run of evidence.runs) {
    const captures = gatewayCapture.filter((row) => (
      digestJson(row.threadId) === run.threadIdDigest
      && digestJson(row.turnId) === run.turnIdDigest
    ))
    const requiredTools = run.kind === 'feishu_typed_read'
      ? ['feishu_doc_read']
      : ['skill_read_artifact', 'skill_run_shell']
    assert(captures.length === run.providerRequestCount
      && new Set(captures.map((capture) => capture.readyRunId)).size === 1
      && captures.every((capture) => capture.toolsDigest === run.toolSurfaceDigest
        && requiredTools.every((name) => capture.toolNames.includes(name))
        && !capture.toolNames.some((name) => /(?:browser|write|delete|generic_shell)/i.test(name))),
      'e6_promotion_gateway_run_binding_invalid')
  }
  const groups = evidence.runs.map((run) => gatewayCapture.filter((row) => (
    digestJson(row.threadId) === run.threadIdDigest && digestJson(row.turnId) === run.turnIdDigest
  )))
  assert(canonicalJson(groups.flat()) === canonicalJson(gatewayCapture),
    'e6_promotion_gateway_order_invalid')
  assert(new Set(groups.map((captures) => captures[0].readyRunId)).size === 6,
    'e6_promotion_gateway_run_binding_invalid')
  const feishuGroups = groups.slice(0, 3)
  const larkGroups = groups.slice(3)
  const patterns = proofSentinelDigests.map((digest) => ({
    digest,
    feishu: feishuGroups.map((captures) => captures.map((row) => (
      row.proofSentinels.find((item) => item.digest === digest).occurrences
    ))),
    lark: larkGroups.map((captures) => captures.map((row) => (
      row.proofSentinels.find((item) => item.digest === digest).occurrences
    ))),
  }))
  const answerPattern = (sets, otherSets) => sets.every((occurrences) => (
    occurrences.slice(0, -1).every((count) => count === 0) && occurrences.at(-1) >= 1
  )) && otherSets.every((occurrences) => occurrences.every((count) => count === 0))
  assert(patterns.filter((pattern) => answerPattern(pattern.feishu, pattern.lark)).length === 1
    && patterns.filter((pattern) => answerPattern(pattern.lark, pattern.feishu)).length === 1
    && patterns.filter((pattern) => pattern.lark.every((row) => row[0] >= 1)
      && pattern.feishu.every((row) => row.every((count) => count === 0))).length === 1,
  'e6_promotion_sentinel_sequence_invalid')
}

function assertUserScenarioEvidence(
  evidence, relationalLedger, gatewayCapture, runtimeManifest, repositoryRoot,
  currentCliIdentity, handshake, completedAt,
) {
  assert(sameKeys(evidence, USER_EVIDENCE_KEYS)
    && evidence.schemaVersion === 1
    && evidence.phase === 'E6'
    && evidence.proofMode === USER_SCENARIO_PROOF_MODE
    && evidence.runCount === 2
    && Array.isArray(evidence.runs) && evidence.runs.length === 2
    && evidence.confirmationCount === 3
    && Array.isArray(evidence.confirmations) && evidence.confirmations.length === 3
    && Number.isSafeInteger(evidence.toolCallCount) && evidence.toolCallCount > 0
    && Number.isSafeInteger(evidence.providerRequestCount)
    && evidence.providerRequestCount === gatewayCapture.length
    && Number.isSafeInteger(evidence.sidecarLeaseCount) && evidence.sidecarLeaseCount > 0
    && sameKeys(evidence.cliAuthIdentity, [
      'principalDigest', 'scopeDigest', 'statusDigest',
    ])
    && Object.values(evidence.cliAuthIdentity).every((value) => SHA256.test(value))
    && sameKeys(evidence.providerIdentity, [
      'endpointClass', 'endpointOriginDigest', 'modelDigest', 'profileIdDigest',
      'providerId', 'snapshotDigest',
    ])
    && typeof evidence.providerIdentity.providerId === 'string'
    && evidence.providerIdentity.providerId.length > 0
    && !/(?:mock|test|fixture)/i.test(evidence.providerIdentity.providerId)
    && evidence.providerIdentity.endpointClass === 'trusted_public_https'
    && SHA256.test(evidence.providerIdentity.endpointOriginDigest)
    && SHA256.test(evidence.providerIdentity.modelDigest)
    && SHA256.test(evidence.providerIdentity.profileIdDigest)
    && SHA256.test(evidence.providerIdentity.snapshotDigest),
  'e6_promotion_user_evidence_invalid')
  const resolvedCliIdentity = currentCliIdentity || readCurrentLarkCliAuthority(repositoryRoot)
  assert(canonicalJson(evidence.cliIdentity) === canonicalJson(resolvedCliIdentity),
    'e6_promotion_user_cli_identity_drift')
  assert(evidence.runtimeManifestDigest === digestJson(runtimeManifest)
    && evidence.protocolSchemaDigest === runtimeManifest.stableV2SchemaSha256,
  'e6_promotion_runtime_identity_invalid')
  assertE6UserScenarioRelationalLedger(relationalLedger, evidence, gatewayCapture)
  const expectedSidecarExecutablePath = resolve(
    repositoryRoot,
    'build/codex',
    String(runtimeManifest.targetTriple || ''),
    'codex',
  )
  assert(SHA256.test(runtimeManifest.binarySha256)
    && relationalLedger.sidecarLeases.every((lease) => (
      lease.runtimeManifestDigest === digestJson(runtimeManifest)
      && lease.binarySha256 === runtimeManifest.binarySha256
      && lease.executablePathDigest === digestText(expectedSidecarExecutablePath)
      && lease.ownerMainPid === handshake.pid
      && lease.ownerMainProcessStartIdentityDigest === handshake.processStartIdentityDigest
      && Date.parse(lease.closedAt) <= Date.parse(lease.treeZeroAt)
      && Date.parse(lease.treeZeroAt) <= Date.parse(completedAt)
    )),
  'e6_promotion_user_sidecar_identity_invalid')

  const [sheetRun, docxRun] = evidence.runs
  assert(evidence.runs.every((run) => sameKeys(run, USER_RUN_KEYS)
    && ['sheet', 'docx'].includes(run.kind)
    && SHA256.test(run.readyRunIdDigest)
    && SHA256.test(run.scopeIdDigest)
    && SHA256.test(run.threadIdDigest)
    && SHA256.test(run.turnIdDigest)
    && SHA256.test(run.toolSurfaceDigest)
    && SHA256.test(run.authorizationSnapshotDigest)
    && SHA256.test(run.publicationReceiptDigest)
    && Number.isSafeInteger(run.toolCallCount) && run.toolCallCount > 0
    && Number.isSafeInteger(run.providerRequestCount) && run.providerRequestCount > 0)
    && sheetRun.kind === 'sheet' && docxRun.kind === 'docx'
    && sheetRun.readyRunIdDigest !== docxRun.readyRunIdDigest
    && sheetRun.scopeIdDigest === docxRun.scopeIdDigest
    && sheetRun.threadIdDigest === docxRun.threadIdDigest
    && sheetRun.turnIdDigest !== docxRun.turnIdDigest
    && sheetRun.toolSurfaceDigest === docxRun.toolSurfaceDigest
    && sheetRun.authorizationSnapshotDigest !== docxRun.authorizationSnapshotDigest
    && evidence.runs.reduce((sum, run) => sum + run.toolCallCount, 0)
      === evidence.toolCallCount
    && evidence.runs.reduce((sum, run) => sum + run.providerRequestCount, 0)
      === evidence.providerRequestCount,
  'e6_promotion_user_run_invalid')

  assert(evidence.confirmations.every((confirmation) => (
    sameKeys(confirmation, USER_CONFIRMATION_KEYS)
    && SHA256.test(confirmation.idDigest)
    && SHA256.test(confirmation.argsDigest)
    && SHA256.test(confirmation.releasedAtDigest)
  ))
    && new Set(evidence.confirmations.map((row) => row.idDigest)).size === 3
    && new Set(evidence.confirmations.map((row) => row.argsDigest)).size === 3,
  'e6_promotion_user_confirmation_invalid')
  const sheet = evidence.resources?.sheet
  const docx = evidence.resources?.docx
  assert(sameKeys(evidence.resources, ['docx', 'sheet'])
    && sameKeys(sheet, USER_SHEET_KEYS)
    && sameKeys(docx, USER_DOCX_KEYS)
    && SHA256.test(sheet.referenceDigest) && SHA256.test(sheet.sentinelDigest)
    && sheet.referenceDigest === digestJson(EXPECTED_SHEET_URL)
    && SHA256.test(sheet.commandAuthorityBindingDigest)
    && /^[A-Z]{1,3}$/.test(sheet.insertedColumn)
    && Number.isSafeInteger(sheet.columnCountBefore) && sheet.columnCountBefore > 0
    && sheet.insertedColumn === columnNameForNumber(sheet.columnCountBefore + 1)
    && sheet.columnCountAfterInsert === sheet.columnCountBefore + 1
    && sheet.columnCountAfter === sheet.columnCountAfterInsert
    && Number.isSafeInteger(sheet.revisionBefore) && sheet.revisionBefore >= 0
    && Number.isSafeInteger(sheet.revisionAfterInsert)
    && sheet.revisionAfterInsert > sheet.revisionBefore
    && Number.isSafeInteger(sheet.revisionAfter)
    && sheet.revisionAfter > sheet.revisionAfterInsert
    && SHA256.test(docx.referenceDigest) && SHA256.test(docx.originalSentenceDigest)
    && docx.referenceDigest === digestJson(EXPECTED_DOCX_URL)
    && SHA256.test(docx.commandAuthorityBindingDigest)
    && SHA256.test(docx.polishedSentenceDigest)
    && SHA256.test(docx.taskMarkerDigest)
    && docx.originalSentenceDigest !== docx.polishedSentenceDigest
    && Number.isSafeInteger(docx.revisionBefore) && docx.revisionBefore >= 0
    && Number.isSafeInteger(docx.revisionAfter)
    && docx.revisionAfter > docx.revisionBefore
    && sheet.referenceDigest !== docx.referenceDigest
    && sheet.readbackContentDigest !== docx.readbackContentDigest
    && docx.preReadContentDigest !== docx.readbackContentDigest,
  'e6_promotion_user_resource_invalid')
  for (const digest of [
    sheet.preInsertStructureCallIdDigest, sheet.preInsertStructureResultDigest,
    sheet.preInsertStructureContentDigest, sheet.preInsertTemplateCallIdDigest,
    sheet.preInsertTemplateResultDigest, sheet.preInsertTemplateContentDigest,
    sheet.templateStyleDigest,
    sheet.insertArgsDigest, sheet.insertCallIdDigest, sheet.insertResultDigest,
    sheet.postInsertInfoCallIdDigest, sheet.postInsertInfoResultDigest,
    sheet.postInsertInfoContentDigest, sheet.postInsertRevisionCallIdDigest,
    sheet.postInsertRevisionResultDigest, sheet.postInsertRevisionContentDigest,
    sheet.postInsertTemplateCallIdDigest, sheet.postInsertTemplateResultDigest,
    sheet.postInsertTemplateContentDigest,
    sheet.writeArgsDigest, sheet.writeCallIdDigest, sheet.writeResultDigest,
    sheet.readbackCallIdDigest, sheet.readbackResultDigest, sheet.readbackContentDigest,
    docx.preReadCallIdDigest, docx.preReadResultDigest, docx.preReadContentDigest,
    docx.writeArgsDigest, docx.writeCallIdDigest, docx.writeResultDigest,
    docx.readbackCallIdDigest, docx.readbackResultDigest, docx.readbackContentDigest,
  ]) assert(SHA256.test(digest), 'e6_promotion_user_resource_invalid')
  const confirmationArgs = new Set(evidence.confirmations.map((row) => row.argsDigest))
  assert(confirmationArgs.size === 3
    && confirmationArgs.has(sheet.insertArgsDigest)
    && confirmationArgs.has(sheet.writeArgsDigest)
    && confirmationArgs.has(docx.writeArgsDigest)
    && new Set([
      sheet.insertCallIdDigest, sheet.writeCallIdDigest, sheet.readbackCallIdDigest,
      docx.preReadCallIdDigest, docx.writeCallIdDigest, docx.readbackCallIdDigest,
    ]).size === 6
    && new Set([
      sheet.insertResultDigest, sheet.writeResultDigest, sheet.readbackResultDigest,
      docx.preReadResultDigest, docx.writeResultDigest, docx.readbackResultDigest,
    ]).size === 6,
  'e6_promotion_user_identity_reuse_invalid')

  const expectedSentinelDigests = [
    sheet.sentinelDigest,
    docx.taskMarkerDigest,
    sheet.referenceDigest,
    docx.referenceDigest,
  ]
  const groups = evidence.runs.map((run) => gatewayCapture.filter((capture) => (
    digestJson(capture.readyRunId) === run.readyRunIdDigest
    && digestJson(capture.threadId) === run.threadIdDigest
    && digestJson(capture.turnId) === run.turnIdDigest
  )))
  assert(groups.every((group, index) => group.length === evidence.runs[index].providerRequestCount)
    && canonicalJson(groups.flat()) === canonicalJson(gatewayCapture)
    && new Set(gatewayCapture.map((row) => row.requestDigest)).size === gatewayCapture.length
    && gatewayCapture.every((capture) => capture.toolsDigest === sheetRun.toolSurfaceDigest
      && capture.readyResourceReferenceCount === 0
      && canonicalJson([...capture.toolNames].sort())
        === canonicalJson([...USER_SCENARIO_ALLOWED_TOOLS].sort())
      && canonicalJson(capture.proofSentinels.map((row) => row.digest))
        === canonicalJson(expectedSentinelDigests)),
  'e6_promotion_user_gateway_invalid')
  const occurrenceRows = groups.map((group) => group.map((capture) => Object.fromEntries(
    capture.proofSentinels.map((row) => [row.digest, row.occurrences]),
  )))
  assert(occurrenceRows[0].every((row) => row[sheet.sentinelDigest] >= 1
    && row[sheet.referenceDigest] >= 1
    && row[docx.taskMarkerDigest] === 0
    && row[docx.referenceDigest] === 0)
    && occurrenceRows[1].every((row) => expectedSentinelDigests.every((digest) => row[digest] >= 1)),
  'e6_promotion_user_gateway_sentinel_invalid')
}

function assertProvenanceSchemas(provenance) {
  const build = provenance.buildProvenance
  const python = provenance.sidecarPythonProvenance
  const environment = provenance.sidecarEnvironmentProvenance
  const electronGyp = provenance.electronGypProvenance
  assert(sameKeys(build, [
    'dependencyEntryCount', 'dependencyFileBytes', 'dependencyTreeDigest',
    'electronExecutablePath', 'electronExecutableSha256', 'packageLockSha256',
  ])
    && SHA256.test(build.packageLockSha256) && SHA256.test(build.dependencyTreeDigest)
    && Number.isSafeInteger(build.dependencyEntryCount) && build.dependencyEntryCount > 0
    && Number.isSafeInteger(build.dependencyFileBytes) && build.dependencyFileBytes > 0
    && typeof build.electronExecutablePath === 'string'
    && build.electronExecutablePath.startsWith('/')
    && SHA256.test(build.electronExecutableSha256)
    && digestFile(build.electronExecutablePath) === build.electronExecutableSha256,
  'e6_promotion_provenance_invalid')
  assert(sameKeys(python, [
    'path', 'runtimeDigest', 'runtimeEntryCount', 'runtimeFileBytes', 'runtimeRoot',
    'sha256', 'sslVersion', 'version',
  ])
    && typeof python.path === 'string' && python.path.startsWith('/')
    && SHA256.test(python.sha256) && digestFile(python.path) === python.sha256
    && typeof python.runtimeRoot === 'string' && python.runtimeRoot.startsWith('/')
    && SHA256.test(python.runtimeDigest)
    && Number.isSafeInteger(python.runtimeEntryCount) && python.runtimeEntryCount > 0
    && Number.isSafeInteger(python.runtimeFileBytes) && python.runtimeFileBytes > 0
    && typeof python.version === 'string' && python.version.length > 0
    && typeof python.sslVersion === 'string' && python.sslVersion.length > 0,
  'e6_promotion_provenance_invalid')
  assert(sameKeys(environment, [
    'digest', 'entryCount', 'fileBytes', 'requirementsInstallDigest',
    'requirementsSha256', 'sourceRoot',
  ])
    && typeof environment.sourceRoot === 'string' && environment.sourceRoot.startsWith('/')
    && SHA256.test(environment.digest) && SHA256.test(environment.requirementsSha256)
    && typeof environment.requirementsInstallDigest === 'string'
    && environment.requirementsInstallDigest.length > 0
    && Number.isSafeInteger(environment.entryCount) && environment.entryCount > 0
    && Number.isSafeInteger(environment.fileBytes) && environment.fileBytes > 0,
  'e6_promotion_provenance_invalid')
  assert(sameKeys(electronGyp, ['digest', 'entryCount', 'fileBytes', 'root'])
    && typeof electronGyp.root === 'string' && electronGyp.root.startsWith('/')
    && SHA256.test(electronGyp.digest)
    && Number.isSafeInteger(electronGyp.entryCount) && electronGyp.entryCount > 0
    && Number.isSafeInteger(electronGyp.fileBytes) && electronGyp.fileBytes > 0,
  'e6_promotion_provenance_invalid')
}

function assertHandshake(handshake, input) {
  const expectedKeys = input.proofMode === USER_SCENARIO_PROOF_MODE
    ? USER_HANDSHAKE_KEYS
    : HANDSHAKE_KEYS
  assert(sameKeys(handshake, expectedKeys)
    && handshake.ok === true
    && /^[a-f0-9]{48}$/.test(handshake.proofNonce)
    && handshake.appPath === input.repositoryRoot
    && handshake.appVersion === input.sourceManifest.appVersion
    && handshake.asarPath === null
    && handshake.asarSha256 === null
    && handshake.execPath === input.buildProvenance.electronExecutablePath
    && handshake.execSha256 === input.buildProvenance.electronExecutableSha256
    && handshake.sourceManifestDigest === input.sourceManifest.digest
    && handshake.runtimeOutputManifestDigest === input.outputManifestDigest
    && handshake.userDataPath === resolve(input.sensitiveRoot, 'profile')
    && handshake.databasePath === resolve(input.sensitiveRoot, 'profile/ready.db')
    && (input.proofMode !== USER_SCENARIO_PROOF_MODE
      || (Number.isSafeInteger(handshake.pid) && handshake.pid > 1
        && SHA256.test(handshake.processStartIdentityDigest))),
  'e6_promotion_handshake_invalid')
}

function assertSourceDatabase(sourceDatabase) {
  assert(sameKeys(sourceDatabase, [
    'fingerprintAfter', 'fingerprintBefore', 'pathDigest', 'unchanged',
  ])
    && SHA256.test(sourceDatabase.pathDigest)
    && sourceDatabase.unchanged === true
    && Array.isArray(sourceDatabase.fingerprintBefore)
    && sourceDatabase.fingerprintBefore.length === 4
    && canonicalJson(sourceDatabase.fingerprintBefore)
      === canonicalJson(sourceDatabase.fingerprintAfter),
  'e6_promotion_source_database_invalid')
  const kinds = ['main', 'wal', 'shm', 'journal']
  assert(sourceDatabase.fingerprintBefore.every((row, index) => (
    row?.kind === kinds[index]
    && Number.isSafeInteger(row.bytes) && row.bytes >= 0
    && (row.sha256 === null || SHA256.test(row.sha256))
    && (row.sha256 === null
      ? sameKeys(row, ['bytes', 'kind', 'sha256'])
      : sameKeys(row, ['bytes', 'kind', 'mtimeMs', 'sha256'])
        && Number.isFinite(row.mtimeMs) && row.mtimeMs >= 0)
  )), 'e6_promotion_source_database_invalid')
  const main = sourceDatabase.fingerprintBefore[0]
  assert(main.bytes > 0 && SHA256.test(main.sha256)
    && Number.isFinite(main.mtimeMs) && main.mtimeMs >= 0,
  'e6_promotion_source_database_invalid')
}

function assertBuildToolchain(provenance, sensitiveRoot) {
  assert(sameKeys(provenance, [
    'binPath', 'nodePath', 'nodeSha256', 'npmCliPath', 'npmCliSha256', 'npmWrapperSha256',
  ])
    && provenance.binPath === resolve(sensitiveRoot, 'build-home/trusted-bin')
    && typeof provenance.nodePath === 'string' && provenance.nodePath.startsWith('/')
    && typeof provenance.npmCliPath === 'string' && provenance.npmCliPath.startsWith('/')
    && SHA256.test(provenance.nodeSha256) && SHA256.test(provenance.npmCliSha256)
    && SHA256.test(provenance.npmWrapperSha256)
    && digestFile(provenance.nodePath) === provenance.nodeSha256
    && digestFile(provenance.npmCliPath) === provenance.npmCliSha256,
  'e6_promotion_build_toolchain_invalid')
}

async function currentProvenance(repositoryRoot) {
  const runtime = await import(pathToFileURL(resolve(
    repositoryRoot, 'scripts/codex-runtime/live-proof-runtime.mjs',
  )).href)
  return {
    buildProvenance: runtime.assertTrustedBuildProvenance(repositoryRoot),
    sidecarPythonProvenance: runtime.trustedSidecarPythonProvenance(),
    sidecarEnvironmentProvenance: runtime.trustedSidecarEnvironmentProvenance(repositoryRoot),
    electronGypProvenance: runtime.trustedElectronGypProvenance(),
  }
}

async function assertE6LiveProofPromotionWhileLeased(options = {}) {
  assertNoAmbientExecutionInjection(process.env)
  const repositoryRoot = resolve(options.repoRoot || repoRoot)
  const phaseReportPath = resolve(options.phaseReportPath || (
    `${auditRoot}/2026-08-08-codex-runtime-e6-report.json`
  ))
  const phaseReport = options.phaseReport || readJsonStrict(
    phaseReportPath, 'e6_promotion_phase_report_invalid',
  )
  assert(phaseReport?.phase === 'E6' && phaseReport.status === 'PASS'
    && phaseReport.nextPhase === 'E7' && phaseReport.nextPhaseAllowed === true
    && phaseReport.failureCode === null, 'e6_promotion_phase_not_passed')
  assertNoSensitivePayload(phaseReport)
  const liveProof = phaseReport.liveProof
  assert(sameKeys(liveProof, [
    'proofId', 'reportPath', 'reportSha256', 'runtimeManifestDigest', 'sourceManifestDigest',
  ]) && PROOF_ID.test(liveProof.proofId)
    && SHA256.test(liveProof.reportSha256)
    && SHA256.test(liveProof.sourceManifestDigest)
    && SHA256.test(liveProof.runtimeManifestDigest),
  'e6_promotion_reference_invalid')
  const relativeReportPath = `outputs/codex-runtime-e6/${liveProof.proofId}/e6-live-proof-report.json`
  assert(liveProof.reportPath === relativeReportPath, 'e6_promotion_report_path_invalid')
  const outputRoot = resolve(repositoryRoot, 'outputs/codex-runtime-e6')
  const proofRoot = resolve(outputRoot, liveProof.proofId)
  const reportPath = resolve(repositoryRoot, relativeReportPath)
  assertWithin(reportPath, proofRoot, 'e6_promotion_report_path_invalid')
  assert(canonicalJson(successfulReports(outputRoot)) === canonicalJson([reportPath]),
    'e6_promotion_success_report_not_unique')
  assertRegularFile(reportPath, 'e6_promotion_report_file_invalid')
  assert(digestFile(reportPath) === liveProof.reportSha256, 'e6_promotion_report_hash_invalid')

  const expectedFiles = [
    'e6-gateway-capture.ndjson',
    'e6-live-proof-report.json',
    'e6-redacted-evidence.json',
    'e6-relational-ledger.json',
    'e6-runtime-completion.json',
  ]
  assert(canonicalJson(readdirSync(proofRoot).sort()) === canonicalJson(expectedFiles),
    'e6_promotion_artifact_set_invalid')
  const report = readJsonStrict(reportPath, 'e6_promotion_report_json_invalid')
  assert(sameKeys(report, REPORT_KEYS)
    && report.ok === true && report.schemaVersion === 1 && report.phase === 'E6'
    && (report.proofMode === USER_SCENARIO_PROOF_MODE
      || (options.allowHistoricalProofModeForTests === true
        && report.proofMode === 'typed-and-cli-3-plus-3'))
    && report.runtimeMode === 'built-development-app'
    && report.proofId === liveProof.proofId
    && isIsoDate(report.generatedAt)
    && SHA256.test(report.validatedPlanDigest)
    && report.sourceDatabaseUnchanged === true,
  'e6_promotion_report_contract_invalid')
  assertSourceManifest(report.sourceManifest, 'e6_promotion_recorded_source_invalid')
  assert(report.sourceManifest.digest === liveProof.sourceManifestDigest,
    'e6_promotion_source_reference_invalid')

  const completionPath = resolve(proofRoot, 'e6-runtime-completion.json')
  const redactedPath = resolve(proofRoot, 'e6-redacted-evidence.json')
  const relationalLedgerPath = resolve(proofRoot, 'e6-relational-ledger.json')
  const gatewayPath = resolve(proofRoot, 'e6-gateway-capture.ndjson')
  for (const path of [completionPath, redactedPath, relationalLedgerPath, gatewayPath]) {
    assertWithin(path, proofRoot, 'e6_promotion_artifact_path_invalid')
    assertRegularFile(path, 'e6_promotion_artifact_file_invalid')
  }
  assert(report.artifacts?.completionMarkerPath === completionPath
    && report.artifacts.redactedEvidencePath === redactedPath
    && report.artifacts.relationalLedgerPath === relationalLedgerPath
    && report.artifacts.gatewayCapturePath === gatewayPath,
  'e6_promotion_artifact_path_invalid')
  assert(digestFile(completionPath) === report.artifacts.completionMarkerSha256
    && digestFile(redactedPath) === report.artifacts.redactedEvidenceSha256
    && digestFile(relationalLedgerPath) === report.artifacts.relationalLedgerSha256
    && digestFile(gatewayPath) === report.artifacts.gatewayCaptureSha256
    && SHA256.test(report.artifacts.rawEvidenceDatabaseSha256)
    && report.artifacts.rawEvidenceDatabaseRetained === false,
  'e6_promotion_artifact_hash_invalid')

  const completion = readJsonStrict(completionPath, 'e6_promotion_completion_invalid')
  const redactedEvidence = readJsonStrict(redactedPath, 'e6_promotion_evidence_invalid')
  const relationalLedger = readJsonStrict(
    relationalLedgerPath, 'e6_promotion_relational_ledger_invalid',
  )
  const gatewayCapture = validateRetainedE6GatewayCapture(
    readFileSync(gatewayPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)),
  )
  assertNoSensitivePayload(report)
  assertNoSensitivePayload(completion)
  assertNoSensitivePayload(relationalLedger)
  assertNoSensitivePayload(gatewayCapture)
  assert(sameKeys(report.artifacts, [
    'completionMarkerPath', 'completionMarkerSha256', 'gatewayCapturePath',
    'gatewayCaptureSha256', 'rawEvidenceDatabaseRetained', 'rawEvidenceDatabaseSha256',
    'redactedEvidencePath', 'redactedEvidenceSha256', 'relationalLedgerPath',
    'relationalLedgerSha256',
  ])
    && sameKeys(completion.artifacts, [
      'gatewayCaptureSha256', 'rawEvidenceDatabaseRetained', 'rawEvidenceDatabaseSha256',
      'redactedEvidenceSha256', 'relationalLedgerSha256',
    ]),
  'e6_promotion_artifact_schema_invalid')
  assert(sameKeys(completion, COMPLETION_KEYS)
    && completion.schemaVersion === 1 && completion.phase === 'E6'
    && completion.proofMode === report.proofMode && completion.proofId === report.proofId
    && isIsoDate(completion.completedAt)
    && completion.validatedPlanDigest === report.validatedPlanDigest
    && completion.sourceManifestDigest === report.sourceManifest.digest
    && completion.artifacts.rawEvidenceDatabaseSha256
      === report.artifacts.rawEvidenceDatabaseSha256
    && completion.artifacts.rawEvidenceDatabaseRetained === false
    && completion.artifacts.gatewayCaptureSha256 === report.artifacts.gatewayCaptureSha256
    && completion.artifacts.redactedEvidenceSha256 === report.artifacts.redactedEvidenceSha256
    && completion.artifacts.relationalLedgerSha256
      === report.artifacts.relationalLedgerSha256,
  'e6_promotion_completion_contract_invalid')
  assert(canonicalJson(redactedEvidence) === canonicalJson(report.evidence)
    && canonicalJson(completion.handshake) === canonicalJson(report.handshake)
    && canonicalJson(completion.shutdown) === canonicalJson(report.shutdown)
    && canonicalJson(completion.credentialSafety) === canonicalJson(report.credentialSafety),
  'e6_promotion_report_binding_invalid')
  assertShutdown(report.shutdown)
  assert(sameKeys(report.credentialSafety, [
    'isolatedChannelConfigScrubbed', 'rawRuntimeArtifactsDestroyed', 'sensitiveFieldsEmitted',
  ])
    && report.credentialSafety.isolatedChannelConfigScrubbed === true
    && report.credentialSafety.rawRuntimeArtifactsDestroyed === true
    && Array.isArray(report.credentialSafety.sensitiveFieldsEmitted)
    && report.credentialSafety.sensitiveFieldsEmitted.length === 0,
  'e6_promotion_credential_safety_invalid')

  const runtimeManifest = options.currentRuntimeManifest || readJson(
    resolve(repositoryRoot, 'assets/codex-runtime/runtime-manifest.json'),
  )
  assert(digestJson(runtimeManifest) === liveProof.runtimeManifestDigest,
    'e6_promotion_runtime_reference_invalid')
  if (report.proofMode === USER_SCENARIO_PROOF_MODE) {
    assertUserScenarioEvidence(
      redactedEvidence,
      relationalLedger,
      gatewayCapture,
      runtimeManifest,
      repositoryRoot,
      options.currentCliAuthority,
      report.handshake,
      completion.completedAt,
    )
    const expectedSheetSentinel = sheetSentinelForProofId(report.proofId)
    const expectedDocxTaskMarker = docxTaskMarkerForProofId(report.proofId)
    assert(redactedEvidence.resources.sheet.sentinelDigest === digestJson(expectedSheetSentinel)
      && redactedEvidence.resources.docx.taskMarkerDigest === digestJson(expectedDocxTaskMarker),
    'e6_promotion_user_plan_identity_invalid')
    const expectedPlanDigest = digestJson({
      schemaVersion: 1,
      proofMode: USER_SCENARIO_PROOF_MODE,
      sourceManifestDigest: report.sourceManifest.digest,
      outputManifestDigest: completion.outputManifestDigest,
      cliIdentity: redactedEvidence.cliIdentity,
      sheetReferenceDigest: digestJson(EXPECTED_SHEET_URL),
      docxReferenceDigest: digestJson(EXPECTED_DOCX_URL),
      sheetSentinelDigest: digestJson(expectedSheetSentinel),
      docxTaskMarkerDigest: digestJson(expectedDocxTaskMarker),
    })
    assert(report.validatedPlanDigest === expectedPlanDigest,
      'e6_promotion_user_plan_identity_invalid')
  } else {
    assertEvidence(redactedEvidence, gatewayCapture, runtimeManifest)
  }
  const currentSourceManifest = options.currentSourceManifest || buildSourceManifest(repositoryRoot)
  assertSourcePromotionDrift(report.sourceManifest, currentSourceManifest)
  const currentOutputManifest = options.currentOutputManifest || buildOutputManifest(repositoryRoot)
  assert(currentOutputManifest.digest === completion.outputManifestDigest,
    'e6_promotion_output_drift')
  const reportedUserDataPath = report.handshake?.userDataPath
  const authorityRoot = resolve(options.authorityRoot || E6_AUTHORITY_ROOT)
  assertAuthorityRootIdentity(authorityRoot)
  const sensitiveRoot = resolve(
    typeof reportedUserDataPath === 'string' ? resolve(reportedUserDataPath, '..') : '',
  )
  assert(basename(reportedUserDataPath || '') === 'profile'
    && basename(sensitiveRoot) === `ready-codex-e6-${report.proofId}`
    && sensitiveRoot === resolve(authorityRoot, `ready-codex-e6-${report.proofId}`),
  'e6_promotion_sensitive_root_identity_invalid')
  assert(!existsSync(sensitiveRoot), 'e6_promotion_sensitive_root_retained')
  assertAuthorityRootClean(authorityRoot)
  const provenance = await (options.currentProvenance || currentProvenance(repositoryRoot))
  assertProvenanceSchemas(provenance)
  for (const key of [
    'buildProvenance', 'sidecarPythonProvenance',
    'sidecarEnvironmentProvenance', 'electronGypProvenance',
  ]) {
    assert(canonicalJson(completion[key]) === canonicalJson(provenance[key]),
      'e6_promotion_provenance_invalid')
  }
  assertBuildToolchain(completion.buildToolchainProvenance, sensitiveRoot)
  assertSourceDatabase(completion.sourceDatabase)
  assertHandshake(report.handshake, {
    repositoryRoot,
    sensitiveRoot,
    sourceManifest: report.sourceManifest,
    outputManifestDigest: completion.outputManifestDigest,
    buildProvenance: completion.buildProvenance,
    proofMode: report.proofMode,
  })
  return {
    proofId: report.proofId,
    reportPath: relativeReportPath,
    reportSha256: liveProof.reportSha256,
  }
}

async function assertE6LiveProofPromotion(options = {}) {
  const leaseAuthority = options.leaseAuthority || {
    acquire: acquireE6GlobalLease,
    release: releaseE6GlobalLease,
  }
  assert(typeof leaseAuthority.acquire === 'function'
    && typeof leaseAuthority.release === 'function',
  'e6_promotion_lease_authority_invalid')
  const lease = await leaseAuthority.acquire()
  assert(lease?.acquired === true, 'e6_promotion_global_lease_busy')
  try {
    return await assertE6LiveProofPromotionWhileLeased(options)
  } finally {
    await leaseAuthority.release(lease)
  }
}

module.exports = {
  assertE6LiveProofPromotion,
}
