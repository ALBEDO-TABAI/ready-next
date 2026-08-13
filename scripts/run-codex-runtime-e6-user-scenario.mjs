#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync, readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

import {
  assertNoAmbientExecutionInjection,
  assertHandshake,
  assertRecordedProcessesExited,
  assertTrustedBuildProvenance,
  assertTrustedBuildToolchain,
  assertTrustedPublicHttpsEndpoint,
  captureDetachedDescendantProcessGroups,
  captureProcessCensus,
  closeChildProcess,
  copyFrozenDatabaseFamily,
  evaluateCdp,
  fingerprintDatabaseFamily,
  normalizeHandshake,
  openCdp,
  prepareTrustedBuildToolchain,
  runTrustedNpmBuild,
  sanitizedRuntimeEnvironment,
  seedProviderSettings,
  sha256File,
  sqliteJson,
  trustedElectronGypProvenance,
  trustedSidecarEnvironmentProvenance,
  trustedSidecarPythonProvenance,
  waitForCondition,
  waitForStableDatabaseSnapshot,
} from './codex-runtime/live-proof-runtime.mjs'
import {
  TRUSTED_PROVIDER_HOSTS,
  assertOwnedProcessGroupsZero,
  cleanupAbandonedSensitiveRoots,
  initializeSensitiveRunRoot,
  readSidecarCleanupState,
  readTrustedProviderReadiness,
  terminateRecordedProcesses,
  trustedSidecarRuntimeExpectation,
  updateSensitiveRootMarker,
} from './run-codex-runtime-e6-live-proof.mjs'

const require = createRequire(import.meta.url)
const { buildOutputManifest, buildSourceManifest } = require('./browser-live-proof-manifest.cjs')
const { digestFile, digestJson, readJson } = require('./codex-runtime/contract-lib.cjs')
const {
  EXPECTED_DOCX_URL,
  EXPECTED_SHEET_URL,
  SHEET_APPEND_POLICY,
  docxTaskMarkerForProofId,
  polishSentenceForE6,
  readCurrentLarkCliAuthority,
  runCurrentLarkCliRead,
  sheetSentinelForProofId,
} = require('./codex-runtime/e6-user-scenario-authority.cjs')
const {
  classifyE6UserScenarioRecoveryIntent,
  summarizeE6UserScenarioRecovery,
} = require('./codex-runtime/e6-user-scenario-recovery.cjs')
const {
  PROOF_MODE,
  buildE6UserScenarioEvidenceBundle,
  projectSafeAuthStatus,
  readE6UserScenarioDatabase,
} = require('./codex-runtime/e6-user-scenario-evidence.cjs')
const {
  validateSheetConfirmationPreReadResults,
  validateSheetPostInsertReadResults,
} = require('./codex-runtime/e6-user-scenario-confirmation-readback.cjs')
const {
  retainValidatedE6GatewayCapture,
} = require('./codex-runtime/e6-gateway-capture.cjs')
const {
  E6_AUTHORITY_ROOT,
  acquireE6GlobalLease,
  releaseE6GlobalLease,
} = require('./codex-runtime/e6-global-lease.cjs')

const ROOT = process.cwd()
const RUNTIME_MANIFEST_PATH = resolve(ROOT, 'assets/codex-runtime/runtime-manifest.json')
const SHEET_URL = String(process.env.READY_CODEX_E6_SHEET_URL || '').trim()
const DOCX_URL = String(process.env.READY_CODEX_E6_DOCX_URL || '').trim()
const SOURCE_DATABASE_PATH = resolve(String(process.env.READY_CODEX_REAL_DB_PATH || ''))
const PROOF_ID = randomBytes(20).toString('hex')
const SHEET_SENTINEL = sheetSentinelForProofId(PROOF_ID)
const DOCX_TASK_MARKER = docxTaskMarkerForProofId(PROOF_ID)
const SENSITIVE_ROOT = resolve(E6_AUTHORITY_ROOT, `ready-codex-e6-${PROOF_ID}`)
const PROFILE_PATH = resolve(SENSITIVE_ROOT, 'profile')
const TEMP_PATH = resolve(SENSITIVE_ROOT, 'tmp')
const BUILD_HOME_PATH = resolve(SENSITIVE_ROOT, 'build-home')
const BUILD_TOOLCHAIN_BIN_PATH = resolve(BUILD_HOME_PATH, 'trusted-bin')
const DATABASE_PATH = resolve(PROFILE_PATH, 'ready.db')
const SOURCE_SNAPSHOT_PATH = resolve(SENSITIVE_ROOT, 'source-ready.db')
const RAW_DATABASE_PATH = resolve(SENSITIVE_ROOT, 'e6-user-scenario-raw.db')
const RAW_GATEWAY_PATH = resolve(PROFILE_PATH, 'e5-gateway-capture.ndjson')
const EVIDENCE_ROOT = resolve(ROOT, 'outputs/codex-runtime-e6', PROOF_ID)
const RETAINED_GATEWAY_PATH = resolve(EVIDENCE_ROOT, 'e6-gateway-capture.ndjson')
const RETAINED_EVIDENCE_PATH = resolve(EVIDENCE_ROOT, 'e6-redacted-evidence.json')
const RELATIONAL_LEDGER_PATH = resolve(EVIDENCE_ROOT, 'e6-relational-ledger.json')
const COMPLETION_PATH = resolve(EVIDENCE_ROOT, 'e6-runtime-completion.json')
const REPORT_PATH = resolve(EVIDENCE_ROOT, 'e6-live-proof-report.json')

let globalLease = null
let child = null
let buildChild = null
let cdp = null
let processMonitor = null
let processRecords = []
let childRootRecord = null
let buildRootRecord = null
let sidecarRuntimeExpectation = null
let proofCompleted = false
let leaseLossError = null
let userScenarioRecovery = null
const ownedProcessGroupIds = new Set()
const spawnIntents = []

function assertInput() {
  let sheet
  let docx
  try {
    sheet = new URL(SHEET_URL)
    docx = new URL(DOCX_URL)
  } catch {
    throw new Error('e6_user_scenario_resource_input_invalid')
  }
  if (sheet.protocol !== 'https:' || docx.protocol !== 'https:'
    || !/(?:^|\.)feishu\.cn$/i.test(sheet.hostname)
    || !/(?:^|\.)feishu\.cn$/i.test(docx.hostname)
    || !/\/sheets\//.test(sheet.pathname)
    || !/\/docx\//.test(docx.pathname)
    || SHEET_URL === DOCX_URL
    || SHEET_URL !== EXPECTED_SHEET_URL
    || DOCX_URL !== EXPECTED_DOCX_URL) {
    throw new Error('e6_user_scenario_resource_input_invalid')
  }
  const sourceStats = lstatSync(SOURCE_DATABASE_PATH)
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.size <= 0) {
    throw new Error('e6_user_scenario_source_database_invalid')
  }
  assertNoAmbientExecutionInjection(process.env)
}

async function initializeSensitiveRoot() {
  await cleanupAbandonedSensitiveRoots({
    preserveRoot: preserveUnreconciledUserScenarioRoot,
  })
  if (await reconcileAbandonedUserScenarioRuns()) {
    throw new Error('e6_user_scenario_abandoned_effect_reconciliation_required')
  }
  if (hasCommittedUserScenarioReport()) {
    throw new Error('e6_user_scenario_proof_already_complete')
  }
  if (readdirSync(E6_AUTHORITY_ROOT).some((entry) => entry !== 'lease.lock')) {
    throw new Error('e6_user_scenario_authority_root_not_clean')
  }
  initializeSensitiveRunRoot(SENSITIVE_ROOT, PROOF_ID)
  mkdirSync(PROFILE_PATH, { mode: 0o700 })
  mkdirSync(TEMP_PATH, { mode: 0o700 })
  mkdirSync(BUILD_HOME_PATH, { mode: 0o700 })
  mkdirSync(dirname(EVIDENCE_ROOT), { recursive: true, mode: 0o700 })
  mkdirSync(EVIDENCE_ROOT, { recursive: false, mode: 0o700 })
  userScenarioRecovery = {
    schemaVersion: 1,
    proofMode: PROOF_MODE,
    proofId: PROOF_ID,
    sheetReferenceDigest: digestJson(SHEET_URL),
    docxReferenceDigest: digestJson(DOCX_URL),
    releaseIntents: [],
  }
  updateSensitiveRootMarker(SENSITIVE_ROOT, PROOF_ID, { userScenario: userScenarioRecovery })
}

function reconciliationOutputPath(proofId) {
  return resolve(ROOT, 'outputs/codex-runtime-e6', proofId, 'e6-effect-reconciliation.json')
}

function readRecoveryCommand(state, args) {
  const result = runCurrentLarkCliRead(args, ROOT)
  if (digestJson(result.authority) !== digestJson(state.cliIdentity)) {
    throw new Error('e6_user_scenario_recovery_cli_identity_drift')
  }
  return result.value
}

function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && digestJson(Object.keys(value).sort()) === digestJson([...expected].sort())
}

function assertNoSensitiveRecoveryPayload(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoSensitiveRecoveryPayload)
    return
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /(Bearer\s+|-----BEGIN|(?:app_?secret|client_?secret|access_?token|refresh_?token|private_?key)\s*[:=])/i.test(value)) {
      throw new Error('e6_user_scenario_reconciliation_sensitive_payload')
    }
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (/(authorization|cookie|credential|password|secret|token|private.?key|body|content|command)/i.test(key)
      && !/(Digest|Sha256|Length)$/.test(key)) {
      throw new Error('e6_user_scenario_reconciliation_sensitive_payload')
    }
    assertNoSensitiveRecoveryPayload(child)
  }
}

function sheetMetadataForSelector(value, selector) {
  const sheets = collectValuesForKey(value, 'sheets')
    .flat().filter((candidate) => candidate && typeof candidate === 'object')
  const matches = sheets.filter((candidate) => (
    selector.key === 'sheet_id'
      ? String(candidate.sheet_id ?? candidate.sheetId ?? '') === selector.value
      : String(candidate.sheet_name ?? candidate.sheetName ?? '') === selector.value
  ))
  if (matches.length !== 1) throw new Error('e6_user_scenario_recovery_sheet_invalid')
  const columnCount = Number(matches[0].column_count ?? matches[0].columnCount)
  if (!Number.isSafeInteger(columnCount) || columnCount < 1) {
    throw new Error('e6_user_scenario_recovery_sheet_invalid')
  }
  return { columnCount }
}

function uniqueRecoveryRevision(value) {
  const revisions = collectValuesForKey(value, 'revision')
    .concat(collectValuesForKey(value, 'revision_id'))
    .concat(collectValuesForKey(value, 'revisionId'))
    .map(Number).filter(Number.isSafeInteger)
  const unique = [...new Set(revisions)]
  if (unique.length !== 1 || unique[0] < 1) {
    throw new Error('e6_user_scenario_recovery_revision_invalid')
  }
  return unique[0]
}

function recoverySheetSelectorArgs(selector) {
  return [selector.key === 'sheet_id' ? '--sheet-id' : '--sheet-name', selector.value]
}

function singleRecoveryCellValue(value) {
  const matrices = collectValuesForKey(value, 'cells').filter(Array.isArray)
  if (matrices.length !== 1 || matrices[0].length !== 1
    || !Array.isArray(matrices[0][0]) || matrices[0][0].length !== 1) return undefined
  const cell = matrices[0][0][0]
  if (cell === null || cell === '') return null
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)
    || !Object.prototype.hasOwnProperty.call(cell, 'value')) return undefined
  return cell.value === null || cell.value === '' ? null : cell.value
}

function reconcileUserScenarioState(rawState) {
  const state = validateUserScenarioRecovery(rawState)
  try {
    const authRead = readRecoveryCommand(state, ['auth', 'status', '--json', '--verify'])
    const authIdentity = projectSafeAuthStatus(authRead)
    if (!state.releaseIntents.every((intent) => (
      digestJson(intent.authIdentity) === digestJson(authIdentity)
    ))) throw new Error('e6_user_scenario_recovery_auth_identity_drift')

    const sheetIntents = state.releaseIntents.filter((intent) => intent.stage.startsWith('sheet_'))
    let sheetInfo = null
    let sheetRevision = null
    if (sheetIntents.length > 0) {
      const selector = sheetIntents[0].sheetSelector
      if (!sheetIntents.every((intent) => (
        digestJson(intent.sheetSelector) === digestJson(selector)
      ))) throw new Error('e6_user_scenario_recovery_sheet_selector_drift')
      sheetInfo = sheetMetadataForSelector(readRecoveryCommand(state, [
        'sheets', '+workbook-info', '--url', EXPECTED_SHEET_URL, '--as', 'user', '--json',
      ]), selector)
      sheetRevision = uniqueRecoveryRevision(readRecoveryCommand(state, [
        'sheets', '+revision-get', '--url', EXPECTED_SHEET_URL, '--as', 'user', '--json',
      ]))
    }

    let docRead = null
    if (state.releaseIntents.some((intent) => intent.stage === 'docx_write')) {
      docRead = readRecoveryCommand(state, [
        'docs', '+fetch', '--doc', EXPECTED_DOCX_URL, '--as', 'user', '--json',
      ])
    }

    const outcomes = state.releaseIntents.map((intent) => {
      if (intent.stage === 'sheet_insert') {
        return { stage: intent.stage, state: classifyE6UserScenarioRecoveryIntent(intent, {
          columnCount: sheetInfo.columnCount,
          revision: sheetRevision,
        }) }
      }
      if (intent.stage === 'sheet_write') {
        const cellRead = readRecoveryCommand(state, [
          'sheets', '+cells-get', '--url', EXPECTED_SHEET_URL,
          ...recoverySheetSelectorArgs(intent.sheetSelector), '--range', intent.range,
          '--as', 'user', '--json',
        ])
        return { stage: intent.stage, state: classifyE6UserScenarioRecoveryIntent(intent, {
          columnCount: sheetInfo.columnCount,
          revision: sheetRevision,
          cellValue: singleRecoveryCellValue(cellRead),
          expectedCellValue: sheetSentinelForProofId(state.proofId),
        }) }
      }
      const contents = collectValuesForKey(docRead, 'content')
        .filter((value) => typeof value === 'string' && value.includes(`<title>${EXPECTED_DOCX_TITLE}</title>`))
      const tokens = collectValuesForKey(docRead, 'document_id')
        .concat(collectValuesForKey(docRead, 'documentId')).map(String)
      if (contents.length !== 1 || !tokens.some((token) => (
        digestJson(token) === intent.documentTokenDigest
      ))) return { stage: intent.stage, state: 'unknown' }
      const contentDigest = digestJson(contents[0])
      const revision = uniqueRecoveryRevision(docRead)
      return { stage: intent.stage, state: classifyE6UserScenarioRecoveryIntent(intent, {
        contentDigest,
        revision,
      }) }
    })
    return {
      status: summarizeE6UserScenarioRecovery(outcomes),
      outcomes,
    }
  } catch {
    return {
      status: 'effect_unknown',
      outcomes: state.releaseIntents.map((intent) => ({ stage: intent.stage, state: 'unknown' })),
    }
  }
}

function persistReconciliationRecord(state, result) {
  const proofOutputRoot = dirname(reconciliationOutputPath(state.proofId))
  rmSync(proofOutputRoot, { recursive: true, force: true })
  mkdirSync(proofOutputRoot, { recursive: true, mode: 0o700 })
  const record = {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: PROOF_MODE,
    proofId: state.proofId,
    reconciledAt: new Date().toISOString(),
    status: result.status,
    outcomes: result.outcomes,
    recovery: state,
  }
  assertNoSensitiveRecoveryPayload(record)
  writeFileAtomic(reconciliationOutputPath(state.proofId), `${JSON.stringify(record, null, 2)}\n`)
}

async function reconcileAbandonedUserScenarioRuns() {
  const states = new Map()
  for (const entry of readdirSync(E6_AUTHORITY_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^ready-codex-e6-[a-f0-9]{40}$/.test(entry.name)) continue
    const rootPath = resolve(E6_AUTHORITY_ROOT, entry.name)
    const marker = readJson(resolve(rootPath, 'e6-owner.json'))
    if (marker?.userScenario) states.set(marker.userScenario.proofId, {
      state: validateUserScenarioRecovery(marker.userScenario), rootPath,
    })
  }
  const outputRoot = resolve(ROOT, 'outputs/codex-runtime-e6')
  if (existsSync(outputRoot)) {
    for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{40}$/.test(entry.name)
        || states.has(entry.name)) continue
      const path = reconciliationOutputPath(entry.name)
      if (!existsSync(path)) continue
      const record = readJson(path)
      if (record?.schemaVersion !== 1 || record.phase !== 'E6'
        || record.proofMode !== PROOF_MODE || record.proofId !== entry.name) {
        throw new Error('e6_user_scenario_reconciliation_record_invalid')
      }
      states.set(entry.name, { state: validateUserScenarioRecovery(record.recovery), rootPath: null })
    }
  }
  let blocked = false
  for (const { state, rootPath } of states.values()) {
    const result = reconcileUserScenarioState(state)
    if (result.status === 'proven_absent') {
      rmSync(dirname(reconciliationOutputPath(state.proofId)), { recursive: true, force: true })
      if (rootPath) rmSync(rootPath, { recursive: true, force: true })
      continue
    }
    persistReconciliationRecord(state, result)
    if (rootPath) rmSync(rootPath, { recursive: true, force: true })
    blocked = true
  }
  return blocked
}

function validateUserScenarioRecovery(value) {
  const rootKeys = [
    'docxReferenceDigest', 'proofId', 'proofMode', 'releaseIntents', 'schemaVersion',
    'sheetReferenceDigest',
  ]
  if (value?.cliIdentity !== undefined) rootKeys.push('cliIdentity')
  if (!sameKeys(value, rootKeys)
    || value.schemaVersion !== 1 || value.proofMode !== PROOF_MODE
    || !/^[a-f0-9]{40}$/.test(value.proofId || '')
    || value.sheetReferenceDigest !== digestJson(EXPECTED_SHEET_URL)
    || value.docxReferenceDigest !== digestJson(EXPECTED_DOCX_URL)
    || !Array.isArray(value.releaseIntents)) {
    throw new Error('e6_user_scenario_recovery_marker_invalid')
  }
  const seen = new Set()
  for (const intent of value.releaseIntents) {
    const commonKeys = [
      'authIdentity', 'createdAt', 'frozenCallId', 'paramsCanonicalSha256', 'readyRunId',
      'scopeId', 'stage', 'targetReferenceDigest',
    ]
    const stageKeys = intent?.stage === 'sheet_insert'
      ? ['columnCountBefore', 'position', 'preInsertStructureContentDigest',
        'preInsertTemplateContentDigest', 'revisionBefore', 'sheetSelector',
        'sheetSelectorDigest', 'templateStyleDigest']
      : intent?.stage === 'sheet_write'
        ? ['columnCountAfterInsert', 'columnCountBefore', 'range', 'revisionAfterInsert',
          'postInsertTemplateContentDigest', 'preInsertStructureContentDigest',
          'preInsertTemplateContentDigest', 'revisionBefore', 'sentinelDigest',
          'sheetSelector', 'sheetSelectorDigest', 'templateStyleDigest']
        : intent?.stage === 'docx_write'
          ? ['beforeContentDigest', 'documentTokenDigest', 'expectedAfterContentDigest',
            'patternDigest', 'patternLength', 'revisionBefore', 'visibleContentDigest',
            'visibleContentLength']
          : []
    if (!sameKeys(intent, [...commonKeys, ...stageKeys])
      || !['sheet_insert', 'sheet_write', 'docx_write'].includes(intent.stage)
      || typeof intent.frozenCallId !== 'string' || intent.frozenCallId.length === 0
      || typeof intent.readyRunId !== 'string' || intent.readyRunId.length === 0
      || typeof intent.scopeId !== 'string' || intent.scopeId.length === 0
      || !/^[a-f0-9]{64}$/.test(intent.paramsCanonicalSha256 || '')
      || !/^[a-f0-9]{64}$/.test(intent.targetReferenceDigest || '')
      || !sameKeys(intent.authIdentity, ['principalDigest', 'scopeDigest', 'statusDigest'])
      || !['principalDigest', 'scopeDigest', 'statusDigest'].every(
        (key) => /^[a-f0-9]{64}$/.test(intent.authIdentity[key] || ''),
      )
      || typeof intent.createdAt !== 'string' || seen.has(intent.frozenCallId)) {
      throw new Error('e6_user_scenario_recovery_marker_invalid')
    }
    const expectedTarget = intent.stage === 'docx_write'
      ? digestJson(EXPECTED_DOCX_URL)
      : digestJson(EXPECTED_SHEET_URL)
    const selectorValid = sameKeys(intent.sheetSelector, ['key', 'value'])
      && ['sheet_id', 'title'].includes(intent.sheetSelector.key)
      && typeof intent.sheetSelector.value === 'string'
      && intent.sheetSelector.value.length > 0
      && digestJson(intent.sheetSelector) === intent.sheetSelectorDigest
    if (intent.targetReferenceDigest !== expectedTarget
      || (intent.stage === 'sheet_insert' && (!selectorValid
        || !/^[A-Z]{1,3}$/.test(intent.position || '')
        || !Number.isSafeInteger(intent.columnCountBefore) || intent.columnCountBefore < 1
        || !Number.isSafeInteger(intent.revisionBefore) || intent.revisionBefore < 1
        || ![intent.preInsertStructureContentDigest,
          intent.preInsertTemplateContentDigest, intent.templateStyleDigest]
          .every((digest) => /^[a-f0-9]{64}$/.test(digest || ''))))
      || (intent.stage === 'sheet_write' && (!selectorValid
        || !/^[A-Z]{1,3}1$/.test(intent.range || '')
        || intent.sentinelDigest !== digestJson(sheetSentinelForProofId(
          value.proofId,
        ))
        || !Number.isSafeInteger(intent.columnCountBefore) || intent.columnCountBefore < 1
        || !Number.isSafeInteger(intent.revisionBefore) || intent.revisionBefore < 1
        || intent.columnCountAfterInsert !== intent.columnCountBefore + 1
        || !Number.isSafeInteger(intent.revisionAfterInsert)
        || intent.revisionAfterInsert <= intent.revisionBefore
        || ![intent.preInsertStructureContentDigest, intent.preInsertTemplateContentDigest,
          intent.postInsertTemplateContentDigest, intent.templateStyleDigest]
          .every((digest) => /^[a-f0-9]{64}$/.test(digest || ''))))
      || (intent.stage === 'docx_write' && (
        !Number.isSafeInteger(intent.revisionBefore) || intent.revisionBefore < 1
        || !Number.isSafeInteger(intent.patternLength) || intent.patternLength < 12
        || !Number.isSafeInteger(intent.visibleContentLength) || intent.visibleContentLength < 12
        || ![intent.patternDigest, intent.visibleContentDigest, intent.beforeContentDigest,
          intent.expectedAfterContentDigest, intent.documentTokenDigest]
          .every((digest) => /^[a-f0-9]{64}$/.test(digest || ''))
      ))) {
      throw new Error('e6_user_scenario_recovery_marker_invalid')
    }
    seen.add(intent.frozenCallId)
  }
  if (value.cliIdentity !== undefined && (!sameKeys(value.cliIdentity, [
    'architecture', 'authorityDigest', 'autoInstallForbidden', 'launcherCount',
    'payloadSha256', 'version', 'wrapperExecutionForbidden',
  ])
    || !/^[a-f0-9]{64}$/.test(value.cliIdentity.authorityDigest || '')
    || !/^[a-f0-9]{64}$/.test(value.cliIdentity.payloadSha256 || '')
    || typeof value.cliIdentity.version !== 'string')) {
    throw new Error('e6_user_scenario_recovery_marker_invalid')
  }
  if (value.releaseIntents.length > 0 && !value.cliIdentity) {
    throw new Error('e6_user_scenario_recovery_marker_invalid')
  }
  const safe = {
    schemaVersion: value.schemaVersion,
    proofMode: value.proofMode,
    proofId: value.proofId,
    sheetReferenceDigest: value.sheetReferenceDigest,
    docxReferenceDigest: value.docxReferenceDigest,
    ...(value.cliIdentity ? { cliIdentity: { ...value.cliIdentity } } : {}),
    releaseIntents: value.releaseIntents.map((intent) => ({
      ...intent,
      authIdentity: { ...intent.authIdentity },
      ...(intent.sheetSelector ? { sheetSelector: { ...intent.sheetSelector } } : {}),
    })),
  }
  assertNoSensitiveRecoveryPayload(safe)
  return safe
}

function preserveUnreconciledUserScenarioRoot(marker) {
  if (marker?.userScenario === undefined) return false
  return validateUserScenarioRecovery(marker.userScenario).releaseIntents.length > 0
}

function hasCommittedUserScenarioReport() {
  const outputRoot = resolve(ROOT, 'outputs/codex-runtime-e6')
  if (!existsSync(outputRoot)) return false
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{40}$/.test(entry.name)) continue
    const reportPath = resolve(outputRoot, entry.name, 'e6-live-proof-report.json')
    if (!existsSync(reportPath)) continue
    let report
    try { report = readJson(reportPath) } catch {
      throw new Error('e6_user_scenario_existing_report_invalid')
    }
    if (report?.ok === true && report.phase === 'E6'
      && report.proofMode === PROOF_MODE && report.proofId === entry.name) return true
  }
  return false
}

function persistEffectReleaseIntent(input) {
  const state = validateUserScenarioRecovery(userScenarioRecovery)
  if (digestJson(input.cliIdentity) !== digestJson(state.cliIdentity)) {
    throw new Error('e6_user_scenario_confirmation_cli_identity_drift')
  }
  const existing = state.releaseIntents.find((intent) => intent.frozenCallId === input.frozenCallId)
  const intent = {
    stage: input.stage,
    frozenCallId: input.frozenCallId,
    readyRunId: input.readyRunId,
    scopeId: input.scopeId,
    paramsCanonicalSha256: input.proof.paramsCanonicalSha256,
    targetReferenceDigest: input.proof.targetReferenceDigest,
    authIdentity: currentAuthIdentity(input.readyRunId, input.cliIdentity),
    ...(input.stage === 'sheet_insert' ? {
      sheetSelector: input.proof.sheetSelector,
      sheetSelectorDigest: input.proof.sheetSelectorDigest,
      position: input.proof.position,
      columnCountBefore: input.state.columnCountBefore,
      preInsertStructureContentDigest: input.state.preInsertStructureContentDigest,
      preInsertTemplateContentDigest: input.state.preInsertTemplateContentDigest,
      revisionBefore: input.state.revisionBefore,
      templateStyleDigest: input.state.templateStyleDigest,
    } : {}),
    ...(input.stage === 'sheet_write' ? {
      sheetSelector: input.proof.sheetSelector,
      sheetSelectorDigest: input.proof.sheetSelectorDigest,
      range: input.proof.range,
      sentinelDigest: digestJson(SHEET_SENTINEL),
      columnCountBefore: input.state.columnCountBefore,
      preInsertStructureContentDigest: input.state.preInsertStructureContentDigest,
      preInsertTemplateContentDigest: input.state.preInsertTemplateContentDigest,
      revisionBefore: input.state.revisionBefore,
      columnCountAfterInsert: input.state.columnCountAfterInsert,
      postInsertTemplateContentDigest: input.state.postInsertTemplateContentDigest,
      revisionAfterInsert: input.state.revisionAfterInsert,
      templateStyleDigest: input.state.templateStyleDigest,
    } : {}),
    ...(input.stage === 'docx_write' ? input.state.docxRecovery : {}),
    createdAt: new Date().toISOString(),
  }
  if (existing) {
    const comparable = { ...existing, createdAt: intent.createdAt }
    if (digestJson(comparable) !== digestJson(intent)) {
      throw new Error('e6_user_scenario_confirmation_intent_drift')
    }
    return
  }
  userScenarioRecovery = {
    ...state,
    releaseIntents: [...state.releaseIntents, intent],
  }
  updateSensitiveRootMarker(SENSITIVE_ROOT, PROOF_ID, { userScenario: userScenarioRecovery })
}

async function assertOwnedProcessGroupsExited() {
  const groupIds = new Set([...ownedProcessGroupIds, ...processRecords.map(
    (row) => row.processGroupId,
  )].filter((groupId) => Number.isSafeInteger(groupId) && groupId > 1))
  if (childRootRecord?.processGroupId > 1) groupIds.add(childRootRecord.processGroupId)
  await assertOwnedProcessGroupsZero(groupIds, { timeoutMs: 20_000 })
}

function mergeProcessRecords(rows) {
  const byIdentity = new Map(processRecords.map((row) => [row.processStartIdentity, row]))
  for (const row of rows) byIdentity.set(row.processStartIdentity, row)
  processRecords = [...byIdentity.values()]
}

function persistSensitiveOwnership() {
  if (!existsSync(SENSITIVE_ROOT)) return
  const roots = []
  if (buildRootRecord) roots.push({ ...buildRootRecord, kind: 'build' })
  if (childRootRecord) roots.push({ ...childRootRecord, kind: 'main' })
  for (const groupId of ownedProcessGroupIds) {
    if (roots.some((row) => row.processGroupId === groupId)) continue
    const record = processRecords.find((row) => row.processGroupId === groupId)
    if (record) roots.push({ ...record, kind: 'sidecar' })
  }
  updateSensitiveRootMarker(SENSITIVE_ROOT, PROOF_ID, {
    processRoots: roots.map((row) => ({
      kind: row.kind,
      pid: row.pid,
      processGroupId: row.processGroupId,
      processStartIdentity: row.processStartIdentity,
      command: row.command,
    })),
    sidecarRuntime: spawnIntents.some((row) => row.kind === 'main')
      ? sidecarRuntimeExpectation
      : null,
    spawnIntents: spawnIntents.map((row) => ({ ...row })),
  })
}

function captureOwnedProcesses() {
  if (!childRootRecord) return
  const census = captureProcessCensus()
  mergeProcessRecords(census.filter((row) => (
    row.pid === childRootRecord.pid
    || row.processGroupId === childRootRecord.processGroupId
    || row.parentPid === childRootRecord.pid
    || row.command.includes(`--ready-e6-proof-id=${PROOF_ID}`)
    || row.command.includes(PROFILE_PATH)
  )))
  const detached = captureDetachedDescendantProcessGroups(childRootRecord, census)
  mergeProcessRecords(detached.records)
  for (const groupId of detached.groupIds) ownedProcessGroupIds.add(groupId)
  persistSensitiveOwnership()
}

function captureSidecarLeaseOwnership() {
  if (!childRootRecord || !sidecarRuntimeExpectation || !existsSync(DATABASE_PATH)) return null
  const state = readSidecarCleanupState(
    DATABASE_PATH,
    childRootRecord,
    sidecarRuntimeExpectation,
  )
  mergeProcessRecords(state.processRecords)
  for (const groupId of state.ownedProcessGroupIds) ownedProcessGroupIds.add(groupId)
  persistSensitiveOwnership()
  return state
}

function assertLeaseActive() {
  if (leaseLossError) throw leaseLossError
}

async function assertLeaseCheckpoint() {
  await new Promise((resolveTick) => setImmediate(resolveTick))
  assertLeaseActive()
}

function writeFileAtomic(path, payload) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  rmSync(temporaryPath, { force: true })
  try {
    writeFileSync(temporaryPath, payload, { mode: 0o600 })
    const fileDescriptor = openSync(temporaryPath, 'r')
    try { fsyncSync(fileDescriptor) } finally { closeSync(fileDescriptor) }
    renameSync(temporaryPath, path)
    const directoryDescriptor = openSync(dirname(path), 'r')
    try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

async function waitForRendererReady() {
  await waitForCondition(async () => {
    try {
      return await evaluateCdp(cdp, `Boolean(
        window.electronAPI?.app?.browserLiveProofHandshake
        && document.querySelector('[data-ready-agent-input="true"]')
        && document.querySelector('[data-ready-agent-send="true"]')
      )`, 5_000)
    } catch {
      return false
    }
  }, { timeoutMs: 120_000, pollMs: 250, message: 'e6 user scenario renderer unavailable' })
}

async function setAskAuthorizationMode() {
  await waitForCondition(async () => {
    const result = await evaluateCdp(cdp, `(() => {
      const selector = document.querySelector('[data-ready-action-authorization-mode]');
      if (!(selector instanceof HTMLButtonElement)) return 'missing';
      if (selector.dataset.readyActionAuthorizationMode === 'ask') return 'ready';
      selector.click();
      return 'opened';
    })()`)
    if (result === 'ready') return true
    if (result === 'opened') {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      const changed = await evaluateCdp(cdp, `(() => {
        const option = document.querySelector('[data-ready-action-authorization-option="ask"]');
        if (!(option instanceof HTMLButtonElement)) return false;
        option.click();
        return true;
      })()`)
      if (!changed) return false
    }
    return false
  }, { timeoutMs: 15_000, pollMs: 150, message: 'e6 authorization selector unavailable' })
}

async function submitOrdinaryPrompt(prompt) {
  await waitForCondition(async () => {
    assertLeaseActive()
    return evaluateCdp(cdp, `(async () => {
      const input = document.querySelector('[data-ready-agent-input="true"]');
      if (!(input instanceof HTMLTextAreaElement) || input.disabled) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(input, ${JSON.stringify(prompt)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      input.focus();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const send = document.querySelector('[data-ready-agent-send="true"]');
      if (!(send instanceof HTMLButtonElement) || send.disabled) return false;
      send.click();
      return true;
    })()`)
  }, { timeoutMs: 30_000, pollMs: 250, message: 'e6 user scenario prompt submit failed' })
}

function currentTurnRows() {
  if (!existsSync(DATABASE_PATH)) return []
  try {
    return sqliteJson(DATABASE_PATH, `
      SELECT ready_run_id AS readyRunId, engine_terminal_status AS engineTerminalStatus,
             product_terminal_digest AS productTerminalDigest,
             publication_receipt_digest AS publicationReceiptDigest,
             created_at AS createdAt
        FROM codex_turn_bindings ORDER BY created_at;
    `)
  } catch {
    return []
  }
}

function currentPendingConfirmationRows() {
  if (!existsSync(DATABASE_PATH)) return []
  try {
    return sqliteJson(DATABASE_PATH, `
      SELECT id, run_id AS readyRunId, scope_id AS scopeId, tool_name AS toolName,
             params_json AS paramsJson, created_at AS createdAt
        FROM pending_confirmations WHERE status = 'pending' ORDER BY created_at, id;
    `).map((row) => ({ ...row, audit: JSON.parse(row.paramsJson) }))
  } catch {
    return []
  }
}

function confirmationRowById(id) {
  if (!existsSync(DATABASE_PATH)) return null
  try {
    return sqliteJson(DATABASE_PATH, `
      SELECT id, status, released_at AS releasedAt
        FROM pending_confirmations WHERE id = ${JSON.stringify(id)};
    `)[0] || null
  } catch {
    return null
  }
}

function completedActionResults(runId) {
  if (!existsSync(DATABASE_PATH)) return []
  try {
    return sqliteJson(DATABASE_PATH, `
      SELECT action.result_json AS resultJson
        FROM codex_tool_call_bindings binding
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
       WHERE binding.ready_run_id = ${JSON.stringify(runId)}
         AND action.state = 'confirmed'
       ORDER BY action.updated_at;
    `).map((row) => JSON.parse(row.resultJson))
  } catch {
    return []
  }
}

function currentAuthIdentity(runId, cliIdentity) {
  const authRows = completedActionResults(runId).filter((result) => (
    JSON.stringify(result?.data?.command?.args)
      === JSON.stringify(['auth', 'status', '--json', '--verify'])
  ))
  if (authRows.length !== 1) throw new Error('e6_user_scenario_auth_status_invalid')
  const command = assertSafeEvidenceCommand(authRows[0], ['auth', 'status'], cliIdentity)
  let value
  try { value = JSON.parse(String(command.data.stdout || '').trim()) } catch {
    throw new Error('e6_user_scenario_auth_status_invalid')
  }
  return projectSafeAuthStatus(value)
}

function collectValuesForKey(value, key, output = []) {
  if (Array.isArray(value)) {
    value.forEach((child) => collectValuesForKey(child, key, output))
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === key) output.push(child)
      collectValuesForKey(child, key, output)
    }
  }
  return output
}

function exactCommandOption(args, name, optional = false) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === name) {
      const value = args[index + 1]
      if (typeof value === 'string' && !value.startsWith('--')) values.push(value)
    } else if (typeof token === 'string' && token.startsWith(`${name}=`)) {
      values.push(token.slice(name.length + 1))
    }
  }
  if (optional && values.length === 0) return null
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error('e6_user_scenario_confirmation_preread_invalid')
  }
  return values[0]
}

function assertSafeEvidenceCommand(result, expectedPath, cliIdentity) {
  const data = result?.data
  const args = data?.command?.args
  const authority = data?.requiredMethod
  if (data?.ok !== true || data.exitCode !== 0 || data.stdoutTruncated !== false
    || data.stderrTruncated !== false || data.command?.bin !== 'lark-cli'
    || !Array.isArray(args) || args[0] !== expectedPath[0] || args[1] !== expectedPath[1]
    || args.some((token) => token === '--jq' || token.startsWith('--jq=')
      || token === '-q' || (token.startsWith('-q') && token.length > 2)
      || token === '--format' || token.startsWith('--format=')
      || token === '--output' || token.startsWith('--output='))
    || authority?.authorityDigest !== cliIdentity.authorityDigest
    || authority?.payloadSha256 !== cliIdentity.payloadSha256
    || authority?.version !== cliIdentity.version) {
    throw new Error('e6_user_scenario_confirmation_preread_invalid')
  }
  return { data, args }
}

function assertSheetConfirmationPreRead(runId, proof, cliIdentity) {
  if (!proof.sheetSelector || digestJson(proof.sheetSelector) !== proof.sheetSelectorDigest) {
    throw new Error('e6_user_scenario_confirmation_preread_invalid')
  }
  const results = completedActionResults(runId)
  assertDryRunCompleted(results, proof, cliIdentity)
  return validateSheetConfirmationPreReadResults({
    results, proof, cliIdentity, sheetUrl: SHEET_URL,
  })
}

function assertDryRunCompleted(results, proof, cliIdentity) {
  const expectedPath = proof.stage === 'docx_write'
    ? ['docs', '+update']
    : ['sheets', proof.stage === 'sheet_insert' ? '+dim-insert' : '+cells-set']
  const matches = []
  for (const result of results) {
    const args = result?.data?.command?.args
    if (!Array.isArray(args) || args[0] !== expectedPath[0] || args[1] !== expectedPath[1]) continue
    const dryRunCount = args.filter((token) => token === '--dry-run').length
    if (dryRunCount !== 1 || args.some((token) => token.startsWith('--dry-run='))) continue
    const command = assertSafeEvidenceCommand(result, expectedPath, cliIdentity)
    if (digestJson(command.args.filter((token) => token !== '--dry-run'))
      === proof.commandArgsDigest) matches.push(result)
  }
  if (matches.length !== 1) throw new Error('e6_user_scenario_confirmation_preview_invalid')
}

function assertSheetPostInsertRead(runId, state, cliIdentity) {
  Object.assign(state, validateSheetPostInsertReadResults({
    results: completedActionResults(runId), state, cliIdentity, sheetUrl: SHEET_URL,
  }))
}

function assertDocxConfirmationPreRead(runId, proof, cliIdentity) {
  const fetches = completedActionResults(runId).filter((result) => {
    const args = result?.data?.command?.args
    return Array.isArray(args) && args[0] === 'docs' && args[1] === '+fetch'
  })
  if (fetches.length !== 1) throw new Error('e6_user_scenario_confirmation_preread_invalid')
  const command = assertSafeEvidenceCommand(fetches[0], ['docs', '+fetch'], cliIdentity)
  if (exactCommandOption(command.args, '--doc') !== DOCX_URL
    || exactCommandOption(command.args, '--as') !== 'user') {
    throw new Error('e6_user_scenario_confirmation_preread_invalid')
  }
  const stdout = String(command.data.stdout || '').trim()
  let parsed
  try { parsed = JSON.parse(stdout) } catch {
    throw new Error('e6_user_scenario_confirmation_preread_invalid')
  }
  const contents = collectValuesForKey(parsed, 'content')
    .filter((value) => typeof value === 'string' && value.includes('<title>'))
  const revisions = collectValuesForKey(parsed, 'revision_id')
    .concat(collectValuesForKey(parsed, 'revisionId'))
    .map(String)
  if (contents.length !== 1 || new Set(revisions).size !== 1
    || revisions[0] !== proof.revisionId
    || !contents[0].includes('<title>2026 年第二季度工作总结</title>')
    || !collectValuesForKey(parsed, 'document_id')
      .concat(collectValuesForKey(parsed, 'documentId'))
      .map(String).includes('GedDd3EATovEz9xILmbcCTk5n4e')) {
    throw new Error('e6_user_scenario_confirmation_preread_invalid')
  }
  const patternLength = Number(proof.patternLength)
  let occurrences = 0
  let pattern = null
  for (let index = 0; index <= contents[0].length - patternLength; index += 1) {
    const candidate = contents[0].slice(index, index + patternLength)
    if (digestJson(candidate) === proof.patternDigest) {
      occurrences += 1
      pattern = candidate
    }
  }
  if (occurrences !== 1) throw new Error('e6_user_scenario_confirmation_pattern_not_unique')
  const expected = polishSentenceForE6(pattern)
  const sourceParagraph = `<p>${pattern}</p>`
  const replacementParagraph = `<p>${expected}</p>`
  if (!expected || digestJson(expected) !== proof.visibleContentDigest
    || expected.length !== proof.visibleContentLength
    || contents[0].split(sourceParagraph).length !== 2) {
    throw new Error('e6_user_scenario_confirmation_preread_invalid')
  }
  return {
    revisionBefore: Number(proof.revisionId),
    patternDigest: proof.patternDigest,
    patternLength,
    visibleContentDigest: proof.visibleContentDigest,
    visibleContentLength: proof.visibleContentLength,
    beforeContentDigest: digestJson(contents[0]),
    expectedAfterContentDigest: digestJson(
      contents[0].replace(sourceParagraph, replacementParagraph),
    ),
    documentTokenDigest: digestJson('GedDd3EATovEz9xILmbcCTk5n4e'),
  }
}

async function answerActionConfirmationIfPresent(input) {
  assertLeaseActive()
  const pendingCard = await evaluateCdp(cdp, `(() => {
    const cards = [...document.querySelectorAll('[data-ready-ask-user-card="pending"]')];
    if (cards.length === 0) return { kind: 'none' };
    if (cards.length !== 1) return { kind: 'invalid', reason: 'multiple_cards' };
    const card = cards[0];
    const text = card.textContent || '';
    return { kind: 'pending', text };
  })()`)
  if (pendingCard?.kind !== 'pending') return pendingCard
  if (!input.runId) return { kind: 'waiting_identity' }
  const rows = currentPendingConfirmationRows()
  if (rows.length !== 1) return { kind: 'invalid', reason: 'pending_row_cardinality' }
  const row = rows[0]
  if (row.readyRunId !== input.runId || row.toolName !== 'skill_run_shell'
    || row.audit?.__audit !== 'redacted'
    || !/^[a-f0-9]{64}$/.test(row.audit?.canonicalSha256 || '')
    || !/^[a-f0-9]{64}$/.test(row.audit?.sha256 || '')
    || !pendingCard.text.includes(`参数指纹 ${row.audit.sha256.slice(0, 12)}`)) {
    return { kind: 'intervention', reason: 'confirmation_identity_mismatch' }
  }
  const stage = input.kind === 'sheet'
    ? input.state.count === 0 ? 'sheet_insert' : input.state.count === 1 ? 'sheet_write' : null
    : input.state.count === 0 ? 'docx_write' : null
  if (!stage) return { kind: 'intervention', reason: 'confirmation_cardinality_exceeded' }
  const inspected = await evaluateCdp(cdp, `window.electronAPI.app.browserLiveProofInspectFrozenCall(${JSON.stringify({
    nonce: input.proofNonce,
    frozenCallId: row.id,
    expectation: {
      stage,
      sheetUrl: SHEET_URL,
      docxUrl: DOCX_URL,
      sheetSentinel: SHEET_SENTINEL,
      docxTaskMarker: DOCX_TASK_MARKER,
    },
  })})`)
  const proof = inspected?.proof
  if (inspected?.success !== true || inspected.frozenCallId !== row.id
    || inspected.readyRunId !== input.runId || inspected.scopeId !== row.scopeId
    || inspected.toolName !== 'skill_run_shell'
    || proof?.stage !== stage
    || proof?.paramsCanonicalSha256 !== row.audit.canonicalSha256) {
    return { kind: 'intervention', reason: inspected?.error || 'confirmation_proof_invalid' }
  }
  if (stage === 'sheet_insert') {
    const preRead = assertSheetConfirmationPreRead(input.runId, proof, input.cliIdentity)
    input.state.sheetSelector = proof.sheetSelector
    input.state.sheetSelectorDigest = proof.sheetSelectorDigest
    input.state.position = proof.position
    input.state.columnCountBefore = preRead.columnCount
    input.state.preInsertStructureContentDigest = preRead.preInsertStructureContentDigest
    input.state.preInsertTemplateContentDigest = preRead.preInsertTemplateContentDigest
    input.state.revisionBefore = preRead.revision
    input.state.templateStyleDigest = preRead.templateStyleDigest
  } else if (stage === 'sheet_write') {
    if (proof.sheetSelectorDigest !== input.state.sheetSelectorDigest
      || proof.range !== `${input.state.position}1`) {
      return { kind: 'intervention', reason: 'sheet_confirmation_sequence_invalid' }
    }
    assertDryRunCompleted(completedActionResults(input.runId), proof, input.cliIdentity)
    assertSheetPostInsertRead(input.runId, input.state, input.cliIdentity)
  } else {
    const results = completedActionResults(input.runId)
    assertDryRunCompleted(results, proof, input.cliIdentity)
    input.state.docxRecovery = assertDocxConfirmationPreRead(
      input.runId, proof, input.cliIdentity,
    )
  }
  persistEffectReleaseIntent({
    stage,
    frozenCallId: row.id,
    readyRunId: input.runId,
    scopeId: row.scopeId,
    proof,
    state: input.state,
    cliIdentity: input.cliIdentity,
  })
  const clicked = await evaluateCdp(cdp, `(async () => {
    const cards = [...document.querySelectorAll('[data-ready-ask-user-card="pending"]')];
    if (cards.length !== 1) return { kind: 'invalid', reason: 'card_changed' };
    const card = cards[0];
    const text = card.textContent || '';
    if (!text.includes(${JSON.stringify(`参数指纹 ${row.audit.sha256.slice(0, 12)}`)})
      || !text.includes('确认执行 skill_run_shell')) return { kind: 'intervention' };
    const buttons = [...card.querySelectorAll('button')];
    const confirm = buttons.find((button) => button.textContent?.trim() === '确认执行');
    if (!(confirm instanceof HTMLButtonElement)) return { kind: 'invalid', reason: 'confirm_missing' };
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const submit = [...card.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '提交回答'
    );
    if (!(submit instanceof HTMLButtonElement) || submit.disabled) return { kind: 'selected' };
    submit.click();
    return { kind: 'submitted' };
  })()`)
  if (clicked?.kind === 'submitted') {
    await waitForCondition(() => {
      assertLeaseActive()
      const released = confirmationRowById(row.id)
      return released?.status === 'released' && typeof released.releasedAt === 'string'
        ? true
        : false
    }, {
      timeoutMs: 15_000,
      pollMs: 100,
      message: 'e6 user scenario confirmation release not committed',
    })
    input.state.count += 1
  }
  return clicked
}

async function waitForRun(prompt, previousRunIds, kind, proofNonce, cliIdentity) {
  await submitOrdinaryPrompt(prompt)
  const startedAt = Date.now()
  let runId = null
  const confirmationState = { count: 0, position: null, sheetSelectorDigest: null }
  const expectedConfirmationCount = kind === 'sheet' ? 2 : 1
  while (Date.now() - startedAt < 20 * 60_000) {
    assertLeaseActive()
    captureOwnedProcesses()
    const rows = currentTurnRows()
    const next = rows.find((row) => !previousRunIds.has(row.readyRunId))
    if (next) runId = next.readyRunId
    const card = await answerActionConfirmationIfPresent({
      runId, kind, proofNonce, cliIdentity, state: confirmationState,
    })
    if (card?.kind === 'intervention') throw new Error('e6_user_intervention_required')
    if (card?.kind === 'invalid') throw new Error('e6_user_scenario_confirmation_ui_invalid')
    if (runId) {
      const current = rows.find((row) => row.readyRunId === runId)
      if (current?.engineTerminalStatus && current.engineTerminalStatus !== 'completed') {
        throw new Error('e6_user_scenario_run_failed')
      }
      if (current?.engineTerminalStatus === 'completed'
        && current.productTerminalDigest && current.publicationReceiptDigest) {
        if (confirmationState.count !== expectedConfirmationCount) {
          throw new Error('e6_user_scenario_confirmation_cardinality_invalid')
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
        return runId
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error('e6_user_scenario_run_timeout')
}

function sheetPrompt() {
  return `用飞书 CLI 读取这份电子表格：${SHEET_URL}\n`
    + '第一条 CLI 命令必须是 lark-cli skills read lark-shared；随后执行 lark-cli auth status --json --verify，再完整读取 lark-sheets 方法，并在业务调用前读取 references/lark-sheets-sheet-structure.md 和 references/lark-sheets-write-cells.md。'
    + `只在当前最后一列的右侧追加一个新的空白列，随后只在新列第 1 行写入精确文本 ${SHEET_SENTINEL}。`
    + `插列前必须读取 workbook 信息和 revision，再执行 sheets +sheet-info --include ${SHEET_APPEND_POLICY.structureInclude}，并读取旧最后一列第 1 行 sheets +cells-get --include ${SHEET_APPEND_POLICY.templateInclude}；若存在合并单元格、读回不完整或目标位置不是最后一列右侧，立即停止。`
    + `插列必须使用 --inherit-style ${SHEET_APPEND_POLICY.inheritStyle}，插列与写单元格分别等待 Ready 的确认。`
    + `插列正式命令完成后，必须重新读取 workbook 信息、revision 和新列第 1 行（--include ${SHEET_APPEND_POLICY.templateInclude}），确认新列空白且样式与旧最后一列相同，再预览和执行单元格写入。每条写入先用完全相同参数加 --dry-run 预览，再发起正式命令。写入时必须使用 --allow-overwrite=false。完成后再次读取 workbook 信息、revision 和该单元格，确认列数恰好增加 1、revision 增加、样式未变且文本精确存在。`
    + '只使用内置 lark-cli Skill，不使用浏览器、飞书应用通道或通用 shell。'
}

function docxPrompt() {
  return `继续用飞书 CLI 读取这份云文档：${DOCX_URL}\n`
    + `本次润色任务标记是 ${DOCX_TASK_MARKER}，只用于对话证据，不得写入文档。`
    + '第一条 CLI 命令必须是 lark-cli skills read lark-shared；随后执行 lark-cli auth status --json --verify，再完整读取 lark-doc 方法，并在业务调用前读取 references/lark-doc-fetch.md、references/lark-doc-xml.md、references/style/lark-doc-style.md、references/lark-doc-update.md 和 references/style/lark-doc-update-workflow.md。全部读回完成后再执行一次完全相同的 auth status，三次身份必须一致。'
    + '先 fetch 并记录当前 revision，选择唯一同时包含“逐步发展为”和“推动内容生产在”的完整段落。改写必须只把前者替换为“逐步沉淀为”、后者替换为“使内容生产在”，其余字符保持不变。'
    + '必须使用 docs +update --command str_replace、默认 XML 格式、原 revision-id、精确 pattern，并把 content 写成只含普通文本的单个 <p>新句子</p>；不得包含任务标记、链接、图片、资源块、append、overwrite、删除或批量修改。'
    + '先用完全相同参数加 --dry-run 预览，再执行正式命令并等待 Ready 确认；完成后再次 fetch，确认 revision 增加、旧句子不再出现且新句子精确出现一次。'
}

function sourceFingerprintUnchanged(before) {
  return JSON.stringify(before) === JSON.stringify(fingerprintDatabaseFamily(SOURCE_DATABASE_PATH))
}

async function main() {
  assertInput()
  globalLease = await acquireE6GlobalLease()
  if (!globalLease.acquired) throw new Error(globalLease.code)
  void globalLease.lost.catch((error) => {
    leaseLossError = error instanceof Error ? error : new Error(String(error))
    try { cdp?.close() } catch {}
    cdp = null
    try { buildChild?.kill('SIGKILL') } catch {}
    try { child?.kill('SIGKILL') } catch {}
  })
  await initializeSensitiveRoot()
  const sourceDatabaseBefore = fingerprintDatabaseFamily(SOURCE_DATABASE_PATH)
  copyFrozenDatabaseFamily(SOURCE_DATABASE_PATH, SOURCE_SNAPSHOT_PATH)
  const sourceManifest = buildSourceManifest(ROOT)
  const buildProvenance = assertTrustedBuildProvenance(ROOT)
  const sidecarPythonProvenance = trustedSidecarPythonProvenance()
  const sidecarEnvironmentProvenance = trustedSidecarEnvironmentProvenance(ROOT)
  const electronGypProvenance = trustedElectronGypProvenance()
  const buildToolchainProvenance = prepareTrustedBuildToolchain(BUILD_TOOLCHAIN_BIN_PATH)
  const cliIdentity = readCurrentLarkCliAuthority(ROOT)
  userScenarioRecovery = { ...userScenarioRecovery, cliIdentity }
  updateSensitiveRootMarker(SENSITIVE_ROOT, PROOF_ID, { userScenario: userScenarioRecovery })
  let providerExpectation = readTrustedProviderReadiness(SOURCE_SNAPSHOT_PATH)
  const providerEndpoint = await assertTrustedPublicHttpsEndpoint(providerExpectation.baseUrl, {
    allowedHosts: TRUSTED_PROVIDER_HOSTS,
    allowedPathnames: ['/v1'],
  })
  providerExpectation = Object.freeze({
    ...providerExpectation,
    endpointClass: providerEndpoint.endpointClass,
    endpointOriginDigest: digestJson(providerEndpoint.origin),
  })
  const runtimeManifest = readJson(RUNTIME_MANIFEST_PATH)
  sidecarRuntimeExpectation = trustedSidecarRuntimeExpectation(runtimeManifest)
  seedProviderSettings({ sourceDatabasePath: SOURCE_SNAPSHOT_PATH, databasePath: DATABASE_PATH })

  const buildIdentityArgument = `ready-codex-e6-build-${PROOF_ID}`
  spawnIntents.push({
    kind: 'build',
    executablePath: '/bin/sh',
    identityArgument: buildIdentityArgument,
  })
  persistSensitiveOwnership()
  try {
    await runTrustedNpmBuild({
      cwd: ROOT,
      detached: true,
      homePath: BUILD_HOME_PATH,
      toolchainBinPath: BUILD_TOOLCHAIN_BIN_PATH,
      processIdentityArgument: buildIdentityArgument,
      onSpawn(spawnedBuild) {
        buildChild = spawnedBuild
        if (!Number.isSafeInteger(spawnedBuild.pid) || spawnedBuild.pid <= 1) {
          throw new Error('e6_user_scenario_build_identity_invalid')
        }
        ownedProcessGroupIds.add(spawnedBuild.pid)
        buildRootRecord = captureProcessCensus().find((row) => row.pid === spawnedBuild.pid) || null
        if (!buildRootRecord || buildRootRecord.processGroupId !== spawnedBuild.pid) {
          throw new Error('e6_user_scenario_build_identity_invalid')
        }
        mergeProcessRecords([buildRootRecord])
        persistSensitiveOwnership()
      },
    })
  } finally {
    buildChild = null
    if (buildRootRecord) {
      await assertRecordedProcessesExited([buildRootRecord], { timeoutMs: 10_000 })
      await assertOwnedProcessGroupsZero(new Set([buildRootRecord.processGroupId]), {
        timeoutMs: 10_000,
      })
      ownedProcessGroupIds.delete(buildRootRecord.processGroupId)
      buildRootRecord = null
      persistSensitiveOwnership()
    }
  }
  assertLeaseActive()
  if (buildSourceManifest(ROOT).digest !== sourceManifest.digest) {
    throw new Error('e6_user_scenario_source_changed_during_build')
  }
  const outputManifest = buildOutputManifest(ROOT)
  if (digestJson(assertTrustedBuildProvenance(ROOT)) !== digestJson(buildProvenance)
    || digestJson(assertTrustedBuildToolchain(BUILD_TOOLCHAIN_BIN_PATH))
      !== digestJson(buildToolchainProvenance)) {
    throw new Error('e6_user_scenario_build_provenance_drift')
  }

  const port = 12_400 + Number.parseInt(PROOF_ID.slice(0, 4), 16) % 1_000
  const proofNonce = randomBytes(24).toString('hex')
  const runtimeEnvironment = sanitizedRuntimeEnvironment(process.env)
  spawnIntents.push({
    kind: 'main',
    executablePath: buildProvenance.electronExecutablePath,
    identityArgument: `--ready-e6-proof-id=${PROOF_ID}`,
  })
  persistSensitiveOwnership()
  child = spawn(buildProvenance.electronExecutablePath, [
    ROOT,
    `--remote-debugging-port=${port}`,
    `--ready-e6-proof-id=${PROOF_ID}`,
  ], {
    cwd: ROOT,
    detached: true,
    env: {
      ...runtimeEnvironment,
      TMPDIR: TEMP_PATH,
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      PIP_NO_INDEX: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      READY_BROWSER_LIVE_PROOF_NONCE: proofNonce,
      READY_CODEX_E5_GATEWAY_CAPTURE: '1',
      READY_CODEX_E5_PROOF_SENTINELS_JSON: JSON.stringify([
        SHEET_SENTINEL, DOCX_TASK_MARKER, SHEET_URL, DOCX_URL,
      ]),
      READY_DB_PATH: DATABASE_PATH,
      READY_REMOTE_DEBUGGING_PORT: String(port),
      READY_SIDECAR_PYTHON: sidecarPythonProvenance.path,
      READY_USER_DATA_DIR: PROFILE_PATH,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  await waitForCondition(() => Number.isSafeInteger(child.pid) && child.pid > 1, {
    timeoutMs: 5_000,
    pollMs: 50,
    message: 'e6 user scenario main pid unavailable',
  })
  ownedProcessGroupIds.add(child.pid)
  persistSensitiveOwnership()
  childRootRecord = await waitForCondition(() => {
    const record = captureProcessCensus().find((row) => row.pid === child.pid)
    return record?.processGroupId === child.pid ? record : false
  }, {
    timeoutMs: 5_000,
    pollMs: 50,
    message: 'e6 user scenario main identity unavailable',
  })
  ownedProcessGroupIds.add(childRootRecord.processGroupId)
  captureOwnedProcesses()
  processMonitor = setInterval(captureOwnedProcesses, 500)
  cdp = await openCdp(port, { timeoutMs: 120_000 })
  assertLeaseActive()
  await waitForRendererReady()
  const handshake = await evaluateCdp(
    cdp,
    `window.electronAPI.app.browserLiveProofHandshake(${JSON.stringify(proofNonce)})`,
  )
  try {
    assertHandshake(handshake, {
      proofNonce,
      sourceManifestDigest: sourceManifest.digest,
      appPath: ROOT,
      runtimeOutputManifestDigest: outputManifest.digest,
      executablePath: buildProvenance.electronExecutablePath,
      executableSha256: buildProvenance.electronExecutableSha256,
      packaged: false,
      userDataPath: PROFILE_PATH,
      databasePath: DATABASE_PATH,
    })
  } catch {
    throw new Error('e6_user_scenario_handshake_invalid')
  }
  if (handshake.appVersion !== sourceManifest.appVersion) {
    throw new Error('e6_user_scenario_handshake_invalid')
  }
  assertLeaseActive()
  if (!sourceFingerprintUnchanged(sourceDatabaseBefore)) {
    throw new Error('e6_user_scenario_source_database_changed_before_effect')
  }
  await setAskAuthorizationMode()
  const knownRunIds = new Set(currentTurnRows().map((row) => row.readyRunId))
  const sheetRunId = await waitForRun(
    sheetPrompt(), knownRunIds, 'sheet', proofNonce, cliIdentity,
  )
  knownRunIds.add(sheetRunId)
  const docxRunId = await waitForRun(
    docxPrompt(), knownRunIds, 'docx', proofNonce, cliIdentity,
  )
  const runIds = [sheetRunId, docxRunId]

  captureOwnedProcesses()
  captureSidecarLeaseOwnership()
  const quit = await evaluateCdp(
    cdp,
    `window.electronAPI.app.browserLiveProofQuit(${JSON.stringify(proofNonce)})`,
    5_000,
  )
  if (quit?.success !== true) throw new Error('e6_user_scenario_graceful_quit_rejected')
  cdp.close()
  cdp = null
  const closeout = await closeChildProcess(child, { gracefulSignal: null, timeoutMs: 30_000 })
  child = null
  if (closeout.forced || closeout.exitCode !== 0 || closeout.signalCode !== null) {
    throw new Error('e6_user_scenario_main_exit_invalid')
  }
  clearInterval(processMonitor)
  processMonitor = null
  captureOwnedProcesses()
  const finalSidecarState = captureSidecarLeaseOwnership()
  if (!finalSidecarState?.treeZeroConfirmed || finalSidecarState.processRecords.length > 0) {
    throw new Error('e6_user_scenario_sidecar_cleanup_unproven')
  }
  await assertRecordedProcessesExited(processRecords, { timeoutMs: 20_000 })
  await assertOwnedProcessGroupsExited()
  if (!sourceFingerprintUnchanged(sourceDatabaseBefore)) {
    throw new Error('e6_user_scenario_source_database_changed')
  }
  if (buildSourceManifest(ROOT).digest !== sourceManifest.digest
    || buildOutputManifest(ROOT).digest !== outputManifest.digest
    || digestJson(readCurrentLarkCliAuthority(ROOT)) !== digestJson(cliIdentity)) {
    throw new Error('e6_user_scenario_runtime_identity_drift')
  }

  await waitForStableDatabaseSnapshot(DATABASE_PATH, RAW_DATABASE_PATH)
  await assertLeaseCheckpoint()
  const databaseEvidence = readE6UserScenarioDatabase(
    RAW_DATABASE_PATH,
    runIds,
    sqliteJson,
  )
  await assertLeaseCheckpoint()
  const retainedGateway = retainValidatedE6GatewayCapture({
    sourcePath: RAW_GATEWAY_PATH,
    targetPath: RETAINED_GATEWAY_PATH,
    validate(gatewayCapture) {
      return buildE6UserScenarioEvidenceBundle({
        cliIdentity,
        databaseEvidence,
        docxTaskMarker: DOCX_TASK_MARKER,
        docxUrl: DOCX_URL,
        gatewayCapture,
        protocolSchemaDigest: runtimeManifest.stableV2SchemaSha256,
        providerExpectation,
        runIds,
        runtimeManifestDigest: digestJson(runtimeManifest),
        sidecarRuntimeExpectation,
        mainProcessExpectation: {
          pid: childRootRecord.pid,
          processStartIdentity: childRootRecord.processStartIdentity,
        },
        sheetSentinel: SHEET_SENTINEL,
        sheetUrl: SHEET_URL,
      })
    },
  })
  await assertLeaseCheckpoint()
  const { evidence: redactedEvidence, relationalLedger } = retainedGateway.validationResult
  writeFileAtomic(RETAINED_EVIDENCE_PATH, `${JSON.stringify(redactedEvidence, null, 2)}\n`)
  writeFileAtomic(RELATIONAL_LEDGER_PATH, `${JSON.stringify(relationalLedger, null, 2)}\n`)
  const rawEvidenceDatabaseSha256 = sha256File(RAW_DATABASE_PATH)
  const gatewayCaptureSha256 = sha256File(RETAINED_GATEWAY_PATH)
  const redactedEvidenceSha256 = sha256File(RETAINED_EVIDENCE_PATH)
  const relationalLedgerSha256 = sha256File(RELATIONAL_LEDGER_PATH)
  const sourceDatabaseAfter = fingerprintDatabaseFamily(SOURCE_DATABASE_PATH)
  const validatedPlanDigest = digestJson({
    schemaVersion: 1,
    proofMode: PROOF_MODE,
    sourceManifestDigest: sourceManifest.digest,
    outputManifestDigest: outputManifest.digest,
    cliIdentity,
    sheetReferenceDigest: digestJson(SHEET_URL),
    docxReferenceDigest: digestJson(DOCX_URL),
    sheetSentinelDigest: digestJson(SHEET_SENTINEL),
    docxTaskMarkerDigest: digestJson(DOCX_TASK_MARKER),
  })
  const leaseRows = databaseEvidence.sidecarLeases
  const shutdown = {
    gracefulQuitAccepted: true,
    forcedMainShutdown: false,
    mainExitCode: 0,
    mainSignalCode: null,
    forcedTreeCleanup: false,
    cleanupObservationFailed: false,
    leaseTreeZeroConfirmed: leaseRows.every((row) => Boolean(row.treeZeroAt)),
    processGroupsZeroConfirmed: true,
    leaseProcessesZeroConfirmed: leaseRows.every((row) => Boolean(row.closedAt)),
    sensitiveCleanupConfirmed: true,
    recordedProcessCount: processRecords.length,
    recordedProcessIdentityDigest: digestJson(
      processRecords.map((row) => row.processStartIdentity).sort(),
    ),
  }
  const normalizedHandshake = {
    ...normalizeHandshake(handshake),
    pid: handshake.pid,
    processStartIdentityDigest: createHash('sha256')
      .update(childRootRecord.processStartIdentity).digest('hex'),
  }
  const completion = {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: PROOF_MODE,
    proofId: PROOF_ID,
    completedAt: new Date().toISOString(),
    validatedPlanDigest,
    sourceManifestDigest: sourceManifest.digest,
    outputManifestDigest: outputManifest.digest,
    buildProvenance,
    sidecarPythonProvenance,
    sidecarEnvironmentProvenance,
    electronGypProvenance,
    buildToolchainProvenance,
    handshake: normalizedHandshake,
    sourceDatabase: {
      pathDigest: digestJson(SOURCE_DATABASE_PATH),
      fingerprintBefore: sourceDatabaseBefore,
      fingerprintAfter: sourceDatabaseAfter,
      unchanged: true,
    },
    artifacts: {
      rawEvidenceDatabaseSha256,
      rawEvidenceDatabaseRetained: false,
      gatewayCaptureSha256,
      redactedEvidenceSha256,
      relationalLedgerSha256,
    },
    shutdown,
    credentialSafety: {
      isolatedChannelConfigScrubbed: true,
      rawRuntimeArtifactsDestroyed: true,
      sensitiveFieldsEmitted: [],
    },
  }
  await assertLeaseCheckpoint()
  writeFileAtomic(COMPLETION_PATH, `${JSON.stringify(completion, null, 2)}\n`)
  const report = {
    ok: true,
    schemaVersion: 1,
    phase: 'E6',
    proofMode: PROOF_MODE,
    runtimeMode: 'built-development-app',
    generatedAt: new Date().toISOString(),
    proofId: PROOF_ID,
    validatedPlanDigest,
    sourceManifest,
    handshake: normalizedHandshake,
    evidence: redactedEvidence,
    sourceDatabaseUnchanged: true,
    shutdown,
    credentialSafety: completion.credentialSafety,
    artifacts: {
      completionMarkerPath: COMPLETION_PATH,
      completionMarkerSha256: digestFile(COMPLETION_PATH),
      redactedEvidencePath: RETAINED_EVIDENCE_PATH,
      redactedEvidenceSha256,
      relationalLedgerPath: RELATIONAL_LEDGER_PATH,
      relationalLedgerSha256,
      gatewayCapturePath: RETAINED_GATEWAY_PATH,
      gatewayCaptureSha256,
      rawEvidenceDatabaseSha256,
      rawEvidenceDatabaseRetained: false,
    },
  }
  await assertLeaseCheckpoint()
  writeFileAtomic(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  await assertLeaseCheckpoint()
  rmSync(RAW_DATABASE_PATH, { force: true })
  rmSync(PROFILE_PATH, { recursive: true, force: true })
  rmSync(TEMP_PATH, { recursive: true, force: true })
  rmSync(SENSITIVE_ROOT, { recursive: true, force: true })
  proofCompleted = true
  process.stdout.write(`${JSON.stringify({
    ok: true,
    phase: 'E6',
    proofMode: PROOF_MODE,
    proofId: PROOF_ID,
    reportPath: REPORT_PATH,
    reportSha256: digestFile(REPORT_PATH),
  })}\n`)
}

async function cleanup() {
  if (processMonitor) clearInterval(processMonitor)
  processMonitor = null
  try { cdp?.close() } catch {}
  cdp = null
  if (buildChild) {
    try { buildChild.kill('SIGKILL') } catch {}
  }
  buildChild = null
  if (child) {
    try { captureOwnedProcesses(); captureSidecarLeaseOwnership() } catch {}
    try { await closeChildProcess(child, { gracefulSignal: 'SIGTERM', timeoutMs: 10_000 }) } catch {}
    child = null
  }
  captureOwnedProcesses()
  try { captureSidecarLeaseOwnership() } catch {}
  let processGroupsZero = false
  try {
    if (!proofCompleted && ownedProcessGroupIds.size > 0) {
      await terminateRecordedProcesses(processRecords, ownedProcessGroupIds)
    }
    await assertOwnedProcessGroupsExited()
    processGroupsZero = true
  } catch {
    processGroupsZero = false
  }
  if (!proofCompleted) {
    if (userScenarioRecovery?.releaseIntents?.length && processGroupsZero) {
      const result = reconcileUserScenarioState(userScenarioRecovery)
      if (result.status === 'proven_absent') {
        rmSync(EVIDENCE_ROOT, { recursive: true, force: true })
      } else {
        persistReconciliationRecord(userScenarioRecovery, result)
      }
      rmSync(SENSITIVE_ROOT, { recursive: true, force: true })
    } else if (!userScenarioRecovery?.releaseIntents?.length) {
      rmSync(EVIDENCE_ROOT, { recursive: true, force: true })
      if (processGroupsZero) rmSync(SENSITIVE_ROOT, { recursive: true, force: true })
    }
  }
  if (globalLease) {
    try { await releaseE6GlobalLease(globalLease) } catch {}
    globalLease = null
  }
}

main().catch((error) => {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
  const message = /^e6_user_scenario_[a-z0-9_]+$/.test(cause)
    ? cause
    : error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}).finally(cleanup)
