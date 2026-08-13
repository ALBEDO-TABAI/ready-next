'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const { digestJson } = require('../codex-runtime/contract-lib.cjs')
const {
  mapReadyToolOutputDigests,
} = require('../codex-runtime/e6-user-scenario-authority.cjs')
const {
  classifyE6UserScenarioRecoveryIntent,
} = require('../codex-runtime/e6-user-scenario-recovery.cjs')
const {
  ALLOWED_TOOLS,
  assertE6UserScenarioEvidence,
  buildE6UserScenarioEvidenceBundle,
  readE6UserScenarioDatabase,
} = require('../codex-runtime/e6-user-scenario-evidence.cjs')

const sha = (value) => digestJson(value)
const iso = (offset) => new Date(Date.UTC(2026, 7, 10, 1, 0, offset)).toISOString()
const sqlValue = (value) => value === null || value === undefined
  ? 'NULL'
  : typeof value === 'number'
    ? String(value)
    : `'${String(value).replaceAll("'", "''")}'`
const insertSql = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(sqlValue).join(',')});`
const SHOULD_REGISTER_TESTS = process.argv[1]
  && resolve(process.argv[1]) === __filename

if (SHOULD_REGISTER_TESTS) test('user-scenario recovery distinguishes never executed, completed, and reverted effects', () => {
  const insertIntent = { stage: 'sheet_insert', columnCountBefore: 21, revisionBefore: 46 }
  assert.equal(classifyE6UserScenarioRecoveryIntent(
    insertIntent, { columnCount: 21, revision: 46 },
  ), 'absent')
  assert.equal(classifyE6UserScenarioRecoveryIntent(
    insertIntent, { columnCount: 22, revision: 47 },
  ), 'completed')
  assert.equal(classifyE6UserScenarioRecoveryIntent(
    insertIntent, { columnCount: 21, revision: 48 },
  ), 'unknown')

  const writeIntent = {
    stage: 'sheet_write', columnCountAfterInsert: 22, revisionAfterInsert: 47,
  }
  assert.equal(classifyE6UserScenarioRecoveryIntent(writeIntent, {
    columnCount: 22, revision: 47, cellValue: null, expectedCellValue: 'sentinel',
  }), 'absent')
  assert.equal(classifyE6UserScenarioRecoveryIntent(writeIntent, {
    columnCount: 22, revision: 48, cellValue: 'sentinel', expectedCellValue: 'sentinel',
  }), 'completed')
  assert.equal(classifyE6UserScenarioRecoveryIntent(writeIntent, {
    columnCount: 22, revision: 49, cellValue: null, expectedCellValue: 'sentinel',
  }), 'unknown')

  const docxIntent = {
    stage: 'docx_write', revisionBefore: 7,
    beforeContentDigest: sha('before'), expectedAfterContentDigest: sha('after'),
  }
  assert.equal(classifyE6UserScenarioRecoveryIntent(docxIntent, {
    revision: 7, contentDigest: sha('before'),
  }), 'absent')
  assert.equal(classifyE6UserScenarioRecoveryIntent(docxIntent, {
    revision: 8, contentDigest: sha('after'),
  }), 'completed')
  assert.equal(classifyE6UserScenarioRecoveryIntent(docxIntent, {
    revision: 9, contentDigest: sha('before'),
  }), 'unknown')
})

function sqliteJson(databasePath, sql) {
  const output = execFileSync('/usr/bin/sqlite3', ['-json', databasePath, sql], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
  return output ? JSON.parse(output) : []
}

function authStatus() {
  return {
    identity: 'user',
    verified: true,
    defaultAs: 'user',
    appId: 'cli_app_real',
    brand: 'Feishu',
    identities: {
      user: {
        available: true,
        verified: true,
        openId: 'ou_real_principal',
        status: 'ready',
        tokenStatus: 'valid',
        scope: 'docs:document.content:read sheets:spreadsheet',
      },
    },
  }
}

function commandResult(args, stdout, cliIdentity) {
  const stdoutText = typeof stdout === 'string' ? stdout : `${JSON.stringify(stdout)}\n`
  return {
    text: `exitCode=0 durationMs=10\nSTDOUT:\n${stdoutText}`,
    shape: 'json',
    data: {
      ok: true,
      exitCode: 0,
      durationMs: 10,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdout: stdoutText,
      stderr: '',
      stdoutArtifactPath: null,
      stderrArtifactPath: null,
      stdoutArtifactError: null,
      stderrArtifactError: null,
      command: { bin: 'lark-cli', args },
      requiredMethod: {
        methodId: 'lark-cli-method',
        commandName: 'lark-cli',
        authorityDigest: cliIdentity.authorityDigest,
        payloadSha256: cliIdentity.payloadSha256,
        version: cliIdentity.version,
      },
    },
    projectionPatch: null,
    interactionHint: null,
    framePatch: null,
    contextModifier: null,
  }
}

function createFixture(options = {}) {
  const sheetUrl = 'https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink'
  const docxUrl = 'https://ji3jaf9ul0l.feishu.cn/docx/GedDd3EATovEz9xILmbcCTk5n4e?from=from_copylink'
  const sheetSentinel = options.sheetSentinel || 'E6-READY-0123456789abcdef'
  const docxTaskMarker = options.docxTaskMarker || 'E6-POLISH-0123456789ab'
  const cliIdentity = {
    architecture: 'arm64',
    authorityDigest: sha('cli-authority'),
    autoInstallForbidden: true,
    launcherCount: 1,
    payloadSha256: sha('cli-payload'),
    version: 'lark-cli version 1.0.76',
    wrapperExecutionForbidden: true,
  }
  const providerExpectation = {
    profileId: 'profile-real',
    providerId: 'openai-compatible',
    model: 'gpt-5.4',
    baseUrl: 'https://cn-novacode.i0yu.cn/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    endpointClass: 'trusted_public_https',
    endpointOriginDigest: sha('https://cn-novacode.i0yu.cn'),
  }
  const providerSnapshot = {
    agentProtocol: 'openai',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    baseUrl: providerExpectation.baseUrl,
    credentialReferenceId: 'ai-profile:profile-real',
    extraHeaders: {},
    model: providerExpectation.model,
    multiTurnThinkingPolicy: 'proven_safe',
    patchProfileId: null,
    profileId: providerExpectation.profileId,
    providerId: providerExpectation.providerId,
    reasoningEffort: 'high',
    retryPolicy: { maxRetries: 6, owner: 'ready_gateway', semantic4xxRetries: 0 },
    supportsNativeToolCalls: true,
    supportsThinking: true,
    supportsToolCalls: true,
    supportsVision: true,
    wireApi: 'responses',
  }
  const providerSnapshotDigest = digestJson(providerSnapshot)
  const sidecarRuntimeExpectation = {
    runtimeManifestDigest: sha('sidecar-runtime-manifest'),
    binarySha256: sha('sidecar-binary'),
    executablePath: '/trusted/sidecar-python',
  }
  const mainProcessExpectation = {
    pid: 4242,
    processStartIdentity: 'main-process-real',
  }
  const inputSchema = {
    type: 'object',
    properties: { command: { type: 'string' }, stdin: { type: 'string' } },
    required: ['command'],
    additionalProperties: false,
  }
  const effectProfile = {
    groupId: 'skill',
    domain: 'skill',
    kind: 'external_write',
    concurrency: 'serial',
    interruptBehavior: 'wait',
    timeoutProfile: 'default',
    executionTimeoutMs: null,
    supportsTextBridge: true,
    projectionHint: null,
    requiresExplicitAllowlist: true,
    resultShape: 'json',
  }
  const entries = ALLOWED_TOOLS.map((name) => ({
    name,
    description: `Production fixture for ${name}`,
    inputSchema,
    schemaDigest: digestJson(inputSchema),
    effectProfileDigest: digestJson(effectProfile),
    effectProfile,
  }))
  const dynamicTools = entries.map((entry) => ({
    type: 'function',
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
  }))
  const responsesTools = entries.map((entry) => ({
    type: 'function',
    name: entry.name,
    description: entry.description,
    strict: false,
    parameters: entry.inputSchema,
  }))
  const surfaceDigest = digestJson(responsesTools)
  const surfaceSnapshotDigest = digestJson({ entries, dynamicTools, responsesTools })
  const toolSurface = {
    surfaceId: 'surface-real',
    toolSurfaceDigest: surfaceDigest,
    surfaceSnapshotDigest,
    toolNames: [...ALLOWED_TOOLS],
    entries,
    dynamicTools,
    responsesTools,
  }
  const scopeId = 'scope-real'
  const sessionId = 'session-real'
  const threadId = 'thread-real'
  const runIds = ['run-sheet', 'run-docx']
  const turns = runIds.map((readyRunId, index) => {
    const readyTaskId = `task-${index}`
    const codexTurnId = `turn-${index}`
    const turnContractDigest = sha(`turn-contract-${index}`)
    const skillAuthorization = {
      mode: 'selected',
      skillId: 'lark-cli',
      allowedTypedActions: [],
      allowedPrimitives: ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
      source: 'explicit',
      reason: 'explicit lark-cli request',
    }
    const authorizationId = `authorization-${index}`
    const allowedToolNames = [...ALLOWED_TOOLS]
    const authorizationDigest = digestJson({ authorizationId, allowedToolNames, skillAuthorization })
    const authorizationSnapshot = {
      authorizationId,
      authorizationDigest,
      authorizationSnapshotDigest: '',
      readySessionKey: sessionId,
      readyTaskId,
      readyRunId,
      scopeId,
      toolSurfaceDigest: surfaceDigest,
      turnContractDigest,
      resourceAnchorDigest: sha(`resource-anchor-${index}`),
      createdAt: iso(index),
      allowedToolNames,
      skillAuthorization,
    }
    authorizationSnapshot.authorizationSnapshotDigest = digestJson({
      authorizationId: authorizationSnapshot.authorizationId,
      authorizationDigest: authorizationSnapshot.authorizationDigest,
      readySessionKey: authorizationSnapshot.readySessionKey,
      readyTaskId: authorizationSnapshot.readyTaskId,
      readyRunId: authorizationSnapshot.readyRunId,
      scopeId: authorizationSnapshot.scopeId,
      toolSurfaceDigest: authorizationSnapshot.toolSurfaceDigest,
      turnContractDigest: authorizationSnapshot.turnContractDigest,
      resourceAnchorDigest: authorizationSnapshot.resourceAnchorDigest,
      createdAt: authorizationSnapshot.createdAt,
      allowedToolNames: authorizationSnapshot.allowedToolNames,
      skillAuthorization: authorizationSnapshot.skillAuthorization,
    })
    return {
      readyRunId,
      readyTaskId,
      scopeId,
      codexSessionId: sessionId,
      codexThreadId: threadId,
      codexTurnId,
      toolSurfaceDigest: surfaceDigest,
      toolSurfaceSnapshotDigest: surfaceSnapshotDigest,
      authorizationSnapshotDigest: authorizationSnapshot.authorizationSnapshotDigest,
      authorizationSnapshotJson: JSON.stringify(authorizationSnapshot),
      authorizationSnapshot,
      turnContractDigest,
      toolSurfaceJson: JSON.stringify(toolSurface),
      toolSurface,
      engineTerminalStatus: 'completed',
      engineTerminalCandidateJson: '',
      engineTerminalCandidate: null,
      engineTerminalCandidateDigest: '',
      productTerminalDigest: sha(`terminal-${index}`),
      publicationReceiptRefsJson: '[]',
      publicationReceiptRefs: [],
      publicationReceiptDigest: '',
      fenceReleaseRevision: 1,
      canonicalMessageCount: 1,
      createdAt: iso(index),
    }
  })
  const sheetArgs = (path, extra = []) => [
    'sheets', path, '--url', sheetUrl, '--sheet-id', 'sheet-1', '--as', 'user', ...extra,
  ]
  const sheetWorkbookArgs = (path) => ['sheets', path, '--url', sheetUrl, '--as', 'user']
  const docxArgs = (path, extra = []) => ['docs', path, '--doc', docxUrl, '--as', 'user', ...extra]
  const original = '本季度工作逐步发展为稳定方法，推动内容生产在协作方式上形成阶段性能力。'
  const polished = '本季度工作逐步沉淀为稳定方法，使内容生产在协作方式上形成阶段性能力。'
  const commandSpecs = [
    [0, ['skills', 'read', 'lark-shared'], '> Tip: use the CLI directly\n---\nname: lark-shared\n', false],
    [0, ['auth', 'status', '--json', '--verify'], authStatus(), false],
    [0, ['skills', 'read', 'lark-sheets'], '> Tip: use the CLI directly\n---\nname: lark-sheets\n', false],
    [0, ['skills', 'read', 'lark-sheets', 'references/lark-sheets-sheet-structure.md'], '# Sheet structure\n', false],
    [0, ['skills', 'read', 'lark-sheets', 'references/lark-sheets-write-cells.md'], '# Write cells\n', false],
    [0, sheetWorkbookArgs('+workbook-info'), { data: { sheets: [{ sheet_id: 'sheet-1', column_count: 3 }] } }, false],
    [0, sheetWorkbookArgs('+revision-get'), { data: { revision: 10 } }, false],
    [0, sheetArgs('+sheet-info', ['--include', 'merges']), { data: { merged_cells: [], range: 'A1:C200', revision: 10, sheet_id: 'sheet-1', sheet_name: 'Sheet1' } }, false],
    [0, sheetArgs('+cells-get', ['--range', 'C1', '--include', 'value,formula,style,data_validation']), { data: { has_more: false, warning_message: 'The actual cell range is also returned.', revision: 10, ranges: [{ actual_range: 'C1:C1', range: 'C1', row_indices: [1], col_indices: ['C'], truncated: false, cells: [[{ cell_styles: { font_size: 13, vertical_alignment: 'middle' } }]] }] } }, false],
    [0, sheetArgs('+dim-insert', ['--position', 'D', '--count', '1', '--inherit-style', 'before', '--dry-run']), { data: { dry_run: true } }, false],
    [0, sheetArgs('+dim-insert', ['--position', 'D', '--count', '1', '--inherit-style', 'before']), { data: { inserted: 1 } }, true],
    [0, sheetWorkbookArgs('+workbook-info'), { data: { sheets: [{ sheet_id: 'sheet-1', column_count: 4 }] } }, false],
    [0, sheetWorkbookArgs('+revision-get'), { data: { revision: 11 } }, false],
    [0, sheetArgs('+cells-get', ['--range', 'D1', '--include', 'value,formula,style,data_validation']), { data: { has_more: false, warning_message: 'The actual cell range is also returned.', revision: 11, ranges: [{ actual_range: 'D1:D1', range: 'D1', row_indices: [1], col_indices: ['D'], truncated: false, cells: [[{ cell_styles: { font_size: 13, vertical_alignment: 'middle' } }]] }] } }, false],
    [0, sheetArgs('+cells-set', ['--range', 'D1', '--cells', JSON.stringify([[{ value: sheetSentinel }]]), '--allow-overwrite', 'false', '--dry-run']), { data: { dry_run: true } }, false],
    [0, sheetArgs('+cells-set', ['--range', 'D1', '--cells', JSON.stringify([[{ value: sheetSentinel }]]), '--allow-overwrite', 'false']), { data: { updated: 1 } }, true],
    [0, sheetWorkbookArgs('+workbook-info'), { data: { sheets: [{ sheet_id: 'sheet-1', column_count: 4 }] } }, false],
    [0, sheetWorkbookArgs('+revision-get'), { data: { revision: 12 } }, false],
    [0, sheetArgs('+cells-get', ['--range', 'D1']), { data: { has_more: false, warning_message: 'The actual cell range is also returned.', revision: 12, ranges: [{ actual_range: 'D1:D1', range: 'D1', row_indices: [1], col_indices: ['D'], truncated: false, cells: [[{ value: sheetSentinel, cell_styles: { font_size: 13, vertical_alignment: 'middle' } }]] }] } }, false],
    [1, ['skills', 'read', 'lark-shared'], '> Tip: use the CLI directly\n---\nname: lark-shared\n', false],
    [1, ['auth', 'status', '--json', '--verify'], authStatus(), false],
    [1, ['skills', 'read', 'lark-doc'], '> Tip: use the CLI directly\n---\nname: lark-doc\n', false],
    [1, ['skills', 'read', 'lark-doc', 'references/lark-doc-fetch.md'], '# Fetch\n', false],
    [1, ['skills', 'read', 'lark-doc', 'references/lark-doc-xml.md'], '# XML\n', false],
    [1, ['skills', 'read', 'lark-doc', 'references/style/lark-doc-style.md'], '# Style\n', false],
    [1, ['skills', 'read', 'lark-doc', 'references/lark-doc-update.md'], '# Update\n', false],
    [1, ['skills', 'read', 'lark-doc', 'references/style/lark-doc-update-workflow.md'], '# Update workflow\n', false],
    [1, docxArgs('+fetch'), { data: { document_id: 'GedDd3EATovEz9xILmbcCTk5n4e', revision_id: 5, content: `<title>2026 年第二季度工作总结</title><p>${original}</p>` } }, false],
    [1, docxArgs('+update', ['--command', 'str_replace', '--revision-id', '5', '--pattern', original, '--content', `<p>${polished}</p>`, '--dry-run']), { data: { dry_run: true } }, false],
    [1, docxArgs('+update', ['--command', 'str_replace', '--revision-id', '5', '--pattern', original, '--content', `<p>${polished}</p>`]), { data: { updated_blocks_count: 1 } }, true],
    [1, docxArgs('+fetch'), { data: { document_id: 'GedDd3EATovEz9xILmbcCTk5n4e', revision_id: 6, content: `<title>2026 年第二季度工作总结</title><p>${polished}</p>` } }, false],
    [1, ['auth', 'status', '--json', '--verify'], authStatus(), false],
  ]
  const gatewayRequests = turns.map((turn, index) => ({
    readyRunId: turn.readyRunId,
    receiptId: `gateway-${index}`,
    requestDigest: sha(`gateway-request-${index}`),
    upstreamProfileSnapshotRef: 'snapshot-ref-real',
    upstreamProfileSnapshotDigest: providerSnapshotDigest,
    inputDigest: sha(`gateway-input-${index}`),
    toolsDigest: surfaceDigest,
    responseId: `response-${index}`,
    responseTerminalDigest: sha(`response-terminal-${index}`),
    responseOutputDigest: sha(`response-output-${index}`),
    responseUsageDigest: sha(`response-usage-${index}`),
  }))
  const calls = []
  const confirmations = []
  commandSpecs.forEach(([turnIndex, args, stdout, confirmed], index) => {
    const turn = turns[turnIndex]
    const codexCallId = `call-${index}`
    const admissionArgsDigest = sha({ command: ['lark-cli', ...args].join(' ') })
    const actionResult = commandResult(args, stdout, cliIdentity)
    const actionResultDigest = digestJson(actionResult)
    const actionIdentityDigest = digestJson({
      readyAliasId: scopeId,
      codexSessionId: sessionId,
      codexThreadId: threadId,
      codexTurnId: turn.codexTurnId,
      callId: codexCallId,
      readyTaskId: turn.readyTaskId,
      readyRunId: turn.readyRunId,
      toolName: 'skill_run_shell',
      argsDigest: admissionArgsDigest,
      turnContractDigest: turn.turnContractDigest,
      surfaceSnapshotDigest,
      authorizationSnapshotDigest: turn.authorizationSnapshotDigest,
      schemaDigest: entries.find((entry) => entry.name === 'skill_run_shell').schemaDigest,
    })
    const admittedAt = iso(10 + index * 3)
    const actionUpdatedAt = iso(12 + index * 3)
    calls.push({
      readyRunId: turn.readyRunId,
      codexThreadId: threadId,
      codexTurnId: turn.codexTurnId,
      codexCallId,
      toolName: 'skill_run_shell',
      admissionArgsDigest,
      gatewayRequestReceiptId: gatewayRequests[turnIndex].receiptId,
      admittedAt,
      readyActionId: `codex-action-${actionIdentityDigest}`,
      readyAliasId: scopeId,
      codexSessionId: sessionId,
      readyTaskId: turn.readyTaskId,
      bindingArgsDigest: admissionArgsDigest,
      turnContractDigest: turn.turnContractDigest,
      surfaceSnapshotDigest,
      authorizationSnapshotDigest: turn.authorizationSnapshotDigest,
      bindingToolName: 'skill_run_shell',
      bindingToolSurfaceDigest: surfaceDigest,
      toolSchemaDigest: entries.find((entry) => entry.name === 'skill_run_shell').schemaDigest,
      bindingReceiptId: `ready-tool-receipt-${digestJson({ readyActionId: `codex-action-${actionIdentityDigest}`, resultDigest: actionResultDigest })}`,
      bindingResultDigest: actionResultDigest,
      deliveredConnectionEpoch: 'epoch-1',
      deliveredRpcId: `rpc-${index}`,
      toolResponseDigest: '',
      deliveryIntentAt: actionUpdatedAt,
      actionIdentityDigest,
      actionState: 'confirmed',
      actionReceiptId: `ready-tool-receipt-${digestJson({ readyActionId: `codex-action-${actionIdentityDigest}`, resultDigest: actionResultDigest })}`,
      actionResultDigest,
      actionResultJson: JSON.stringify(actionResult),
      actionResult,
      actionUpdatedAt,
    })
    if (confirmed) {
      const audit = {
        __audit: 'redacted',
        canonicalSha256: admissionArgsDigest,
        sha256: sha(`confirmation-${index}`),
        shape: { command: 'string' },
      }
      confirmations.push({
        id: `fc-${index}`,
        readyRunId: turn.readyRunId,
        scopeId,
        toolName: 'skill_run_shell',
        paramsJson: JSON.stringify(audit),
        createdAt: iso(10 + index * 3 + 1),
        status: 'released',
        releasedAt: iso(10 + index * 3 + 2),
        audit,
      })
    }
  })
  const responseDigests = mapReadyToolOutputDigests(calls.map((call) => call.actionResult))
  calls.forEach((call, index) => { call.toolResponseDigest = responseDigests[index] })
  turns.forEach((turn) => {
    const candidateText = `completed ${turn.readyRunId}`
    turn.engineTerminalCandidate = {
      kind: 'native_terminal',
      readyTaskId: turn.readyTaskId,
      readyRunId: turn.readyRunId,
      scopeId: turn.scopeId,
      codexThreadId: turn.codexThreadId,
      codexTurnId: turn.codexTurnId,
      engineOutcome: 'completed',
      candidateSelection: { kind: 'accepted', itemId: `final-${turn.readyRunId}` },
      candidateText,
      candidateDigest: require('node:crypto').createHash('sha256').update(candidateText).digest('hex'),
      usedToolCalls: calls.filter((call) => call.readyRunId === turn.readyRunId).map((call) => ({
        itemId: call.codexCallId,
        tool: call.toolName,
        status: 'completed',
        success: true,
        responseDigest: call.toolResponseDigest,
      })),
      actionReceiptRefs: [],
      interactionState: null,
      waitingFor: null,
      terminalReasonCandidate: 'completed',
      abortInitiator: null,
      budgetState: {},
      contextState: {},
      providerDiagnostics: {},
      recoveryCheckpointRef: null,
      browserContinuationRef: null,
      browserProofRefs: [],
      otherProofRefs: [],
      projectionPatchRefs: [],
      runtimeDiagnostics: {
        finalDeltaItemIds: [],
        commentaryItemIds: [],
        nativeTurnError: null,
      },
    }
    turn.engineTerminalCandidateJson = JSON.stringify(turn.engineTerminalCandidate)
    turn.engineTerminalCandidateDigest = digestJson(turn.engineTerminalCandidate)
    turn.publicationReceiptRefs = calls
      .filter((call) => call.readyRunId === turn.readyRunId)
      .map((call) => call.bindingReceiptId)
      .sort()
    turn.publicationReceiptRefsJson = JSON.stringify(turn.publicationReceiptRefs)
    turn.publicationReceiptDigest = digestJson({
      readyRunId: turn.readyRunId,
      engineTerminalCandidateDigest: turn.engineTerminalCandidateDigest,
      verifiedReceiptRefs: turn.publicationReceiptRefs,
    })
  })
  const gatewayCapture = gatewayRequests.map((request, index) => ({
    requestKind: 'product',
    readyRunId: request.readyRunId,
    threadId,
    turnId: turns[index].codexTurnId,
    requestDigest: request.requestDigest,
    inputDigest: request.inputDigest,
    readyResourceReferenceCount: 0,
    toolsDigest: surfaceDigest,
    toolNames: [...ALLOWED_TOOLS],
    toolCount: ALLOWED_TOOLS.length,
    proofSentinels: [
      { digest: digestJson(sheetSentinel), occurrences: 1 },
      { digest: digestJson(docxTaskMarker), occurrences: index === 0 ? 0 : 1 },
      { digest: digestJson(sheetUrl), occurrences: 1 },
      { digest: digestJson(docxUrl), occurrences: index === 0 ? 0 : 1 },
    ],
  }))
  const databaseEvidence = {
    turns,
    calls,
    confirmations,
    gatewayRequests,
    providerSnapshots: [{
      snapshotRef: 'snapshot-ref-real',
      snapshotDigest: providerSnapshotDigest,
      profileId: providerExpectation.profileId,
      credentialReferenceId: 'ai-profile:profile-real',
      snapshotJson: JSON.stringify(providerSnapshot),
      snapshot: providerSnapshot,
    }],
    sidecarLeases: [{
      processLeaseId: 'lease-real',
      pid: 5252,
      processGroupId: 5252,
      processStartIdentity: 'process-real',
      runtimeManifestDigest: sidecarRuntimeExpectation.runtimeManifestDigest,
      binarySha256: sidecarRuntimeExpectation.binarySha256,
      executablePath: sidecarRuntimeExpectation.executablePath,
      ownerMainPid: mainProcessExpectation.pid,
      ownerMainProcessStartIdentity: mainProcessExpectation.processStartIdentity,
      closedAt: iso(58),
      treeZeroAt: iso(59),
      treeZeroEvidenceDigest: sha('tree-zero'),
    }],
  }
  return {
    input: {
      cliIdentity,
      databaseEvidence,
      docxTaskMarker,
      docxUrl,
      gatewayCapture,
      protocolSchemaDigest: sha('protocol'),
      providerExpectation,
      runIds,
      runtimeManifestDigest: sidecarRuntimeExpectation.runtimeManifestDigest,
      sidecarRuntimeExpectation,
      mainProcessExpectation,
      sheetSentinel,
      sheetUrl,
    },
    databaseEvidence,
  }
}

function rebindActionResult(call) {
  const previousReceiptId = call.bindingReceiptId
  call.actionResultDigest = digestJson(call.actionResult)
  call.actionResultJson = JSON.stringify(call.actionResult)
  call.bindingResultDigest = call.actionResultDigest
  call.actionReceiptId = `ready-tool-receipt-${digestJson({
    readyActionId: call.readyActionId,
    resultDigest: call.actionResultDigest,
  })}`
  call.bindingReceiptId = call.actionReceiptId
  return previousReceiptId
}

function rebindFixtureActionResult(fixture, call) {
  const previousReceiptId = rebindActionResult(call)
  const turn = fixture.input.databaseEvidence.turns.find(
    (candidate) => candidate.readyRunId === call.readyRunId,
  )
  call.toolResponseDigest = mapReadyToolOutputDigests([call.actionResult])[0]
  const usedCall = turn.engineTerminalCandidate.usedToolCalls.find(
    (candidate) => candidate.itemId === call.codexCallId,
  )
  if (usedCall) usedCall.responseDigest = call.toolResponseDigest
  turn.engineTerminalCandidateJson = JSON.stringify(turn.engineTerminalCandidate)
  turn.engineTerminalCandidateDigest = digestJson(turn.engineTerminalCandidate)
  turn.publicationReceiptRefs = turn.publicationReceiptRefs
    .map((ref) => ref === previousReceiptId ? call.bindingReceiptId : ref)
    .sort()
  turn.publicationReceiptRefsJson = JSON.stringify(turn.publicationReceiptRefs)
  turn.publicationReceiptDigest = digestJson({
    readyRunId: turn.readyRunId,
    engineTerminalCandidateDigest: turn.engineTerminalCandidateDigest,
    verifiedReceiptRefs: turn.publicationReceiptRefs,
  })
}

function rebindFixtureTurnReceipts(fixture, readyRunId) {
  const turn = fixture.input.databaseEvidence.turns.find(
    (candidate) => candidate.readyRunId === readyRunId,
  )
  const calls = fixture.input.databaseEvidence.calls
    .filter((call) => call.readyRunId === readyRunId)
  turn.engineTerminalCandidate.usedToolCalls = calls.map((call) => ({
    itemId: call.codexCallId,
    tool: call.toolName,
    status: 'completed',
    success: true,
    responseDigest: call.toolResponseDigest,
  }))
  turn.engineTerminalCandidateJson = JSON.stringify(turn.engineTerminalCandidate)
  turn.engineTerminalCandidateDigest = digestJson(turn.engineTerminalCandidate)
  turn.publicationReceiptRefs = calls
    .map((call) => call.bindingReceiptId)
    .sort()
  turn.publicationReceiptRefsJson = JSON.stringify(turn.publicationReceiptRefs)
  turn.publicationReceiptDigest = digestJson({
    readyRunId,
    engineTerminalCandidateDigest: turn.engineTerminalCandidateDigest,
    verifiedReceiptRefs: turn.publicationReceiptRefs,
  })
}

function createNativeDatabase(databasePath, evidence) {
  const statements = [
    'CREATE TABLE codex_thread_bindings(thread_binding_id TEXT,ready_conversation_alias TEXT,codex_session_id TEXT,codex_thread_id TEXT,tool_surface_snapshot_digest TEXT,tool_surface_json TEXT);',
    'CREATE TABLE codex_turn_bindings(thread_binding_id TEXT,ready_run_id TEXT,ready_task_id TEXT,codex_turn_id TEXT,tool_surface_digest TEXT,authorization_snapshot_digest TEXT,authorization_snapshot_json TEXT,turn_contract_digest TEXT,engine_terminal_status TEXT,engine_terminal_candidate_json TEXT,engine_terminal_candidate_digest TEXT,product_terminal_digest TEXT,publication_receipt_refs_json TEXT,publication_receipt_digest TEXT,fence_release_revision INTEGER,created_at TEXT);',
    'CREATE TABLE chat_messages(conversation_id TEXT,role TEXT,meta_json TEXT);',
    'CREATE TABLE codex_tool_call_admissions(ready_run_id TEXT,codex_thread_id TEXT,codex_turn_id TEXT,codex_call_id TEXT,tool_name TEXT,args_digest TEXT,gateway_request_receipt_id TEXT,admitted_at TEXT);',
    'CREATE TABLE codex_tool_call_bindings(ready_run_id TEXT,codex_thread_id TEXT,codex_turn_id TEXT,codex_call_id TEXT,ready_action_id TEXT,ready_alias_id TEXT,codex_session_id TEXT,ready_task_id TEXT,tool_name TEXT,args_digest TEXT,turn_contract_digest TEXT,surface_snapshot_digest TEXT,tool_surface_digest TEXT,authorization_snapshot_digest TEXT,tool_schema_digest TEXT,receipt_id TEXT,result_digest TEXT,delivered_connection_epoch TEXT,delivered_rpc_id TEXT,tool_response_digest TEXT,delivery_intent_at TEXT);',
    'CREATE TABLE ready_tool_action_receipts(ready_action_id TEXT,action_identity_digest TEXT,state TEXT,receipt_id TEXT,result_digest TEXT,result_json TEXT,updated_at TEXT);',
    'CREATE TABLE pending_confirmations(id TEXT,run_id TEXT,scope_id TEXT,tool_name TEXT,params_json TEXT,created_at TEXT,status TEXT,released_at TEXT);',
    'CREATE TABLE ready_model_gateway_request_receipts(ready_run_id TEXT,receipt_id TEXT,request_digest TEXT,upstream_profile_snapshot_ref TEXT,upstream_profile_snapshot_digest TEXT,request_kind TEXT);',
    'CREATE TABLE ready_model_gateway_exchange_events(gateway_request_receipt_id TEXT,event_kind TEXT,input_digest TEXT,tools_digest TEXT,response_id TEXT,terminal_digest TEXT,output_digest TEXT,usage_digest TEXT,event_sequence INTEGER);',
    'CREATE TABLE ready_model_gateway_profile_snapshots(snapshot_ref TEXT,snapshot_digest TEXT,profile_id TEXT,credential_reference_id TEXT,snapshot_json TEXT,created_at TEXT);',
    'CREATE TABLE codex_sidecar_process_leases(process_lease_id TEXT,pid INTEGER,process_group_id INTEGER,process_start_identity TEXT,runtime_manifest_digest TEXT,binary_sha256 TEXT,executable_path TEXT,owner_main_pid INTEGER,owner_main_process_start_identity TEXT,closed_at TEXT,tree_zero_at TEXT,tree_zero_evidence_digest TEXT,spawn_intent_at TEXT);',
  ]
  evidence.turns.forEach((turn, index) => {
    statements.push(insertSql('codex_thread_bindings', {
      thread_binding_id: `binding-${index}`,
      ready_conversation_alias: turn.scopeId,
      codex_session_id: turn.codexSessionId,
      codex_thread_id: turn.codexThreadId,
      tool_surface_snapshot_digest: turn.toolSurfaceSnapshotDigest,
      tool_surface_json: turn.toolSurfaceJson,
    }))
    statements.push(insertSql('codex_turn_bindings', {
      thread_binding_id: `binding-${index}`,
      ready_run_id: turn.readyRunId,
      ready_task_id: turn.readyTaskId,
      codex_turn_id: turn.codexTurnId,
      tool_surface_digest: turn.toolSurfaceDigest,
      authorization_snapshot_digest: turn.authorizationSnapshotDigest,
      authorization_snapshot_json: turn.authorizationSnapshotJson,
      turn_contract_digest: turn.turnContractDigest,
      engine_terminal_status: turn.engineTerminalStatus,
      engine_terminal_candidate_json: turn.engineTerminalCandidateJson,
      engine_terminal_candidate_digest: turn.engineTerminalCandidateDigest,
      product_terminal_digest: turn.productTerminalDigest,
      publication_receipt_refs_json: turn.publicationReceiptRefsJson,
      publication_receipt_digest: turn.publicationReceiptDigest,
      fence_release_revision: turn.fenceReleaseRevision,
      created_at: turn.createdAt,
    }))
    statements.push(insertSql('chat_messages', {
      conversation_id: turn.scopeId,
      role: 'assistant',
      meta_json: JSON.stringify({ runId: turn.readyRunId }),
    }))
  })
  evidence.calls.forEach((call) => {
    statements.push(insertSql('codex_tool_call_admissions', {
      ready_run_id: call.readyRunId,
      codex_thread_id: call.codexThreadId,
      codex_turn_id: call.codexTurnId,
      codex_call_id: call.codexCallId,
      tool_name: call.toolName,
      args_digest: call.admissionArgsDigest,
      gateway_request_receipt_id: call.gatewayRequestReceiptId,
      admitted_at: call.admittedAt,
    }))
    statements.push(insertSql('codex_tool_call_bindings', {
      ready_run_id: call.readyRunId,
      codex_thread_id: call.codexThreadId,
      codex_turn_id: call.codexTurnId,
      codex_call_id: call.codexCallId,
      ready_action_id: call.readyActionId,
      ready_alias_id: call.readyAliasId,
      codex_session_id: call.codexSessionId,
      ready_task_id: call.readyTaskId,
      tool_name: call.bindingToolName,
      args_digest: call.bindingArgsDigest,
      turn_contract_digest: call.turnContractDigest,
      surface_snapshot_digest: call.surfaceSnapshotDigest,
      tool_surface_digest: call.bindingToolSurfaceDigest,
      authorization_snapshot_digest: call.authorizationSnapshotDigest,
      tool_schema_digest: call.toolSchemaDigest,
      receipt_id: call.bindingReceiptId,
      result_digest: call.bindingResultDigest,
      delivered_connection_epoch: call.deliveredConnectionEpoch,
      delivered_rpc_id: call.deliveredRpcId,
      tool_response_digest: call.toolResponseDigest,
      delivery_intent_at: call.deliveryIntentAt,
    }))
    statements.push(insertSql('ready_tool_action_receipts', {
      ready_action_id: call.readyActionId,
      action_identity_digest: call.actionIdentityDigest,
      state: call.actionState,
      receipt_id: call.actionReceiptId,
      result_digest: call.actionResultDigest,
      result_json: call.actionResultJson,
      updated_at: call.actionUpdatedAt,
    }))
  })
  evidence.confirmations.forEach((row) => statements.push(insertSql('pending_confirmations', {
    id: row.id,
    run_id: row.readyRunId,
    scope_id: row.scopeId,
    tool_name: row.toolName,
    params_json: row.paramsJson,
    created_at: row.createdAt,
    status: row.status,
    released_at: row.releasedAt,
  })))
  evidence.gatewayRequests.forEach((row, index) => {
    statements.push(insertSql('ready_model_gateway_request_receipts', {
      ready_run_id: row.readyRunId,
      receipt_id: row.receiptId,
      request_digest: row.requestDigest,
      upstream_profile_snapshot_ref: row.upstreamProfileSnapshotRef,
      upstream_profile_snapshot_digest: row.upstreamProfileSnapshotDigest,
      request_kind: 'product',
    }))
    statements.push(insertSql('ready_model_gateway_exchange_events', {
      gateway_request_receipt_id: row.receiptId,
      event_kind: 'request_admitted',
      input_digest: row.inputDigest,
      tools_digest: row.toolsDigest,
      response_id: null,
      terminal_digest: null,
      output_digest: null,
      usage_digest: null,
      event_sequence: index * 2,
    }))
    statements.push(insertSql('ready_model_gateway_exchange_events', {
      gateway_request_receipt_id: row.receiptId,
      event_kind: 'response_completed',
      input_digest: null,
      tools_digest: null,
      response_id: row.responseId,
      terminal_digest: row.responseTerminalDigest,
      output_digest: row.responseOutputDigest,
      usage_digest: row.responseUsageDigest,
      event_sequence: index * 2 + 1,
    }))
  })
  const provider = evidence.providerSnapshots[0]
  statements.push(insertSql('ready_model_gateway_profile_snapshots', {
    snapshot_ref: provider.snapshotRef,
    snapshot_digest: provider.snapshotDigest,
    profile_id: provider.profileId,
    credential_reference_id: provider.credentialReferenceId,
    snapshot_json: provider.snapshotJson,
    created_at: iso(0),
  }))
  const lease = evidence.sidecarLeases[0]
  statements.push(insertSql('codex_sidecar_process_leases', {
    process_lease_id: lease.processLeaseId,
    pid: lease.pid,
    process_group_id: lease.processGroupId,
    process_start_identity: lease.processStartIdentity,
    runtime_manifest_digest: lease.runtimeManifestDigest,
    binary_sha256: lease.binarySha256,
    executable_path: lease.executablePath,
    owner_main_pid: lease.ownerMainPid,
    owner_main_process_start_identity: lease.ownerMainProcessStartIdentity,
    closed_at: lease.closedAt,
    tree_zero_at: lease.treeZeroAt,
    tree_zero_evidence_digest: lease.treeZeroEvidenceDigest,
    spawn_intent_at: iso(0),
  }))
  execFileSync('/usr/bin/sqlite3', [databasePath, statements.join('\n')])
}

if (SHOULD_REGISTER_TESTS) test('native SQLite evidence closes the ordinary two-resource E6 proof chain', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ready-e6-user-evidence-'))
  try {
    const fixture = createFixture()
    const databasePath = join(fixtureRoot, 'ready.db')
    createNativeDatabase(databasePath, fixture.databaseEvidence)
    fixture.input.databaseEvidence = readE6UserScenarioDatabase(
      databasePath, fixture.input.runIds, sqliteJson,
    )
    const bundle = buildE6UserScenarioEvidenceBundle(fixture.input)
    const result = bundle.evidence
    assert.equal(result.runCount, 2)
    assert.equal(result.confirmationCount, 3)
    assert.equal(result.cliAuthIdentity.principalDigest.length, 64)
    assert.equal(result.providerIdentity.endpointClass, 'trusted_public_https')
    assert.equal(bundle.relationalLedger.turns[0].calls.length, 19)
    assert.equal(bundle.relationalLedger.turns[1].calls.length, 13)
    assert.equal(bundle.relationalLedger.evidenceDigest, digestJson(result))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

if (SHOULD_REGISTER_TESTS) test('terminal evidence rejects fake shapes, digest drift, and missing tool results', () => {
  const fakeShape = createFixture()
  const fakeTurn = fakeShape.input.databaseEvidence.turns[0]
  fakeTurn.engineTerminalCandidate = { status: 'completed' }
  fakeTurn.engineTerminalCandidateDigest = digestJson(fakeTurn.engineTerminalCandidate)
  assert.throws(() => assertE6UserScenarioEvidence(fakeShape.input),
    /e6_user_scenario_terminal_invalid/)

  const digestDrift = createFixture()
  digestDrift.input.databaseEvidence.turns[0].engineTerminalCandidateDigest = sha('forged')
  assert.throws(() => assertE6UserScenarioEvidence(digestDrift.input),
    /e6_user_scenario_terminal_invalid/)

  const missingCall = createFixture()
  const missingTurn = missingCall.input.databaseEvidence.turns[0]
  missingTurn.engineTerminalCandidate.usedToolCalls.shift()
  missingTurn.engineTerminalCandidateDigest = digestJson(missingTurn.engineTerminalCandidate)
  assert.throws(() => assertE6UserScenarioEvidence(missingCall.input),
    /e6_user_scenario_terminal_tool_result_invalid/)

  const responseDrift = createFixture()
  const responseTurn = responseDrift.input.databaseEvidence.turns[0]
  responseTurn.engineTerminalCandidate.usedToolCalls[0].responseDigest = sha('wrong-response')
  responseTurn.engineTerminalCandidateDigest = digestJson(responseTurn.engineTerminalCandidate)
  assert.throws(() => assertE6UserScenarioEvidence(responseDrift.input),
    /e6_user_scenario_terminal_tool_result_invalid/)
})

if (SHOULD_REGISTER_TESTS) test('ordinary evidence rejects provider/admission drift, auth drift, and marker writes', () => {
  const fixture = createFixture()
  fixture.input.databaseEvidence.calls[0].gatewayRequestReceiptId = 'missing-receipt'
  assert.throws(() => assertE6UserScenarioEvidence(fixture.input),
    /e6_user_scenario_gateway_admission_binding_invalid/)

  const authDrift = createFixture()
  authDrift.input.databaseEvidence.calls.at(-1).actionResult.data.stdout = `${JSON.stringify({
    ...authStatus(),
    identities: { user: { ...authStatus().identities.user, openId: 'ou_other' } },
  })}\n`
  rebindFixtureActionResult(authDrift, authDrift.input.databaseEvidence.calls.at(-1))
  assert.throws(() => assertE6UserScenarioEvidence(authDrift.input),
    /e6_user_scenario_auth_identity_drift/)

  const providerDrift = createFixture()
  providerDrift.input.databaseEvidence.gatewayRequests[0].upstreamProfileSnapshotDigest = sha('other')
  assert.throws(() => assertE6UserScenarioEvidence(providerDrift.input),
    /e6_user_scenario_provider_request_binding_invalid/)

  const markerWrite = createFixture()
  const update = markerWrite.input.databaseEvidence.calls.find((call) => (
    call.actionResult.data.command.args[0] === 'docs'
      && call.actionResult.data.command.args[1] === '+update'
  ))
  const contentIndex = update.actionResult.data.command.args.indexOf('--content') + 1
  update.actionResult.data.command.args[contentIndex] = `<p>${markerWrite.input.docxTaskMarker} 足够长的新句子内容</p>`
  rebindFixtureActionResult(markerWrite, update)
  assert.throws(() => assertE6UserScenarioEvidence(markerWrite.input),
    /e6_user_scenario_docx_(?:preview|write)_invalid/)

  const unrelatedEdit = createFixture()
  const afterFetch = unrelatedEdit.input.databaseEvidence.calls.find((call) => {
    const args = call.actionResult.data.command.args
    return args[0] === 'docs' && args[1] === '+fetch'
      && call.actionResult.data.stdout.includes('revision_id":6')
  })
  const parsedAfter = JSON.parse(afterFetch.actionResult.data.stdout)
  parsedAfter.data.content += '<p>这是一处不属于目标句子的额外改动。</p>'
  afterFetch.actionResult.data.stdout = `${JSON.stringify(parsedAfter)}\n`
  rebindFixtureActionResult(unrelatedEdit, afterFetch)
  assert.throws(() => assertE6UserScenarioEvidence(unrelatedEdit.input),
    /e6_user_scenario_docx_readback_invalid/)

  const structuralEdit = createFixture()
  const structuralAfter = structuralEdit.input.databaseEvidence.calls.find((call) => {
    const args = call.actionResult.data.command.args
    return args[0] === 'docs' && args[1] === '+fetch'
      && call.actionResult.data.stdout.includes('revision_id":6')
  })
  const structuralJson = JSON.parse(structuralAfter.actionResult.data.stdout)
  structuralJson.data.content = structuralJson.data.content
    .replace('<p>本季度工作逐步沉淀为', '<h1>本季度工作逐步沉淀为')
    .replace('形成阶段性能力。</p>', '形成阶段性能力。</h1><image token="foreign"/>')
  structuralAfter.actionResult.data.stdout = `${JSON.stringify(structuralJson)}\n`
  rebindFixtureActionResult(structuralEdit, structuralAfter)
  assert.throws(() => assertE6UserScenarioEvidence(structuralEdit.input),
    /e6_user_scenario_docx_readback_invalid/)

  const missingIntermediateRead = createFixture()
  missingIntermediateRead.input.databaseEvidence.calls = missingIntermediateRead.input
    .databaseEvidence.calls.filter((call) => {
      const args = call.actionResult.data.command.args
      if (call.readyRunId !== 'run-sheet') return true
      const insertIndex = Number(call.codexCallId.slice('call-'.length))
      return !(insertIndex === 11 || insertIndex === 12)
    })
  rebindFixtureTurnReceipts(missingIntermediateRead, 'run-sheet')
  assert.throws(() => assertE6UserScenarioEvidence(missingIntermediateRead.input),
    /e6_user_scenario_sheet_readback_missing/)
})

module.exports = { createFixture }
