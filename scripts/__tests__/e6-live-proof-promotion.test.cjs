'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve } = require('node:path')
const test = require('node:test')

const { digestFile, digestJson } = require('../codex-runtime/contract-lib.cjs')
const {
  assertE6LiveProofPromotion,
} = require('../codex-runtime/e6-live-proof-promotion.cjs')
const {
  assertE6UserScenarioRelationalLedger,
  buildE6UserScenarioEvidenceBundle,
} = require('../codex-runtime/e6-user-scenario-evidence.cjs')
const {
  createFixture: createUserEvidenceFixture,
} = require('./e6-user-scenario-evidence.test.cjs')
const {
  EXPECTED_DOCX_URL,
  EXPECTED_SHEET_URL,
  docxTaskMarkerForProofId,
  sheetSentinelForProofId,
} = require('../codex-runtime/e6-user-scenario-authority.cjs')

const sha = (value) => createHash('sha256').update(value).digest('hex')

function sourceManifest() {
  const files = [{ path: 'src/frozen.ts', bytes: 7, sha256: sha('frozen\n') }]
  return {
    version: 1,
    head: '29dcede162710f2278b20ee7421eaabe67c1c79b',
    branch: 'codex/cod-ready',
    appVersion: '2.1.3',
    digest: sha(files.map((file) => (
      `${file.path}\0${file.bytes}\0${file.sha256}\n`
    )).join('')),
    files,
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function createTestLeaseAuthority() {
  let held = false
  return {
    get held() { return held },
    async acquire() {
      if (held) return { acquired: false, code: 'e6_global_lease_busy' }
      held = true
      return { acquired: true }
    },
    async release(lease) {
      assert.equal(lease?.acquired, true)
      assert.equal(held, true)
      held = false
    },
  }
}

function createFixture(mutate) {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ready-e6-promotion-'))
  const proofId = 'a'.repeat(40)
  const proofRoot = resolve(fixtureRoot, 'outputs/codex-runtime-e6', proofId)
  mkdirSync(proofRoot, { recursive: true })
  const trustedRoot = resolve(fixtureRoot, 'trusted')
  mkdirSync(trustedRoot)
  const nodePath = resolve(trustedRoot, 'node')
  const npmCliPath = resolve(trustedRoot, 'npm-cli.js')
  const electronPath = resolve(trustedRoot, 'Electron')
  const pythonPath = resolve(trustedRoot, 'python')
  writeFileSync(nodePath, 'trusted node')
  writeFileSync(npmCliPath, 'trusted npm')
  writeFileSync(electronPath, 'trusted electron')
  writeFileSync(pythonPath, 'trusted python')
  const authorityRoot = resolve(fixtureRoot, 'e6-authority')
  mkdirSync(authorityRoot, { mode: 0o700 })
  writeFileSync(resolve(authorityRoot, 'lease.lock'), '', { mode: 0o600 })
  const sensitiveRoot = resolve(authorityRoot, `ready-codex-e6-${proofId}`)
  const sidecarExecutablePath = resolve(fixtureRoot, 'build/codex/test-triple/codex')
  mkdirSync(resolve(fixtureRoot, 'build/codex/test-triple'), { recursive: true })
  writeFileSync(sidecarExecutablePath, 'trusted sidecar')
  const runtimeManifest = {
    binarySha256: digestFile(sidecarExecutablePath),
    stableV2SchemaSha256: 'b'.repeat(64),
    targetTriple: 'test-triple',
  }
  const recordedSource = sourceManifest()
  const outputManifest = { digest: 'c'.repeat(64) }
  const leaseAuthority = createTestLeaseAuthority()
  const runs = Array.from({ length: 6 }, (_, index) => {
    const kind = index < 3 ? 'feishu_typed_read' : 'lark_cli_read'
    return {
      kind,
      scopeIdDigest: digestJson(`scope-${index}`),
      threadIdDigest: digestJson(`thread-${index}`),
      turnIdDigest: digestJson(`turn-${index}`),
      toolSurfaceDigest: digestJson(`surface-${kind}`),
      methodConstraintDigest: digestJson(`method-${kind}`),
      dependencySnapshotDigest: digestJson(`dependency-${kind}`),
      toolCallCount: kind === 'feishu_typed_read' ? 1 : 4,
      providerRequestCount: kind === 'feishu_typed_read' ? 2 : 5,
    }
  })
  const gatewayCapture = runs.flatMap((run, index) => Array.from(
    { length: run.providerRequestCount },
    (_, requestIndex) => ({
      requestKind: 'product',
      readyRunId: `ready-run-${index}`,
      threadId: `thread-${index}`,
      turnId: `turn-${index}`,
      requestDigest: digestJson(`request-${index}-${requestIndex}`),
      inputDigest: digestJson(`input-${run.kind}-${requestIndex}`),
      readyResourceReferenceCount: 1,
      toolsDigest: run.toolSurfaceDigest,
      toolNames: run.kind === 'feishu_typed_read'
        ? ['feishu_doc_read', 'safe_other_read']
        : ['skill_read_artifact', 'skill_run_shell', 'safe_other_read'],
      toolCount: run.kind === 'feishu_typed_read' ? 2 : 3,
      proofSentinels: [
        {
          digest: 'd'.repeat(64),
          occurrences: run.kind === 'feishu_typed_read'
            && requestIndex === run.providerRequestCount - 1 ? 1 : 0,
        },
        {
          digest: 'e'.repeat(64),
          occurrences: run.kind === 'lark_cli_read'
            && requestIndex === run.providerRequestCount - 1 ? 1 : 0,
        },
        { digest: 'f'.repeat(64), occurrences: run.kind === 'lark_cli_read' ? 1 : 0 },
      ],
    }),
  ))
  const evidence = {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: 'typed-and-cli-3-plus-3',
    runCount: 6,
    toolCallCount: runs.reduce((total, run) => total + run.toolCallCount, 0),
    providerRequestCount: gatewayCapture.length,
    ignoredUnstartedThreadCount: 1,
    sidecarLeaseCount: 1,
    runtimeManifestDigest: digestJson(runtimeManifest),
    protocolSchemaDigest: runtimeManifest.stableV2SchemaSha256,
    providerIdentity: {
      providerId: 'openai-compatible',
      modelDigest: '4'.repeat(64),
      endpointClass: 'trusted_public_https',
      endpointOriginDigest: '5'.repeat(64),
      snapshotDigest: '6'.repeat(64),
    },
    runs,
  }
  const shutdown = {
    gracefulQuitAccepted: true,
    forcedMainShutdown: false,
    mainExitCode: 0,
    mainSignalCode: null,
    forcedTreeCleanup: false,
    cleanupObservationFailed: false,
    leaseTreeZeroConfirmed: true,
    processGroupsZeroConfirmed: true,
    leaseProcessesZeroConfirmed: true,
    sensitiveCleanupConfirmed: true,
    recordedProcessCount: 3,
    recordedProcessIdentityDigest: '1'.repeat(64),
  }
  const credentialSafety = {
    isolatedChannelConfigScrubbed: true,
    rawRuntimeArtifactsDestroyed: true,
    sensitiveFieldsEmitted: [],
  }
  const buildProvenance = {
    packageLockSha256: '7'.repeat(64),
    dependencyTreeDigest: '8'.repeat(64),
    dependencyEntryCount: 10,
    dependencyFileBytes: 100,
    electronExecutablePath: electronPath,
    electronExecutableSha256: digestFile(electronPath),
  }
  const sidecarPythonProvenance = {
    path: pythonPath,
    sha256: digestFile(pythonPath),
    runtimeRoot: trustedRoot,
    runtimeDigest: '9'.repeat(64),
    runtimeEntryCount: 10,
    runtimeFileBytes: 100,
    version: 'Python 3.11.15',
    sslVersion: 'OpenSSL test',
  }
  const sidecarEnvironmentProvenance = {
    sourceRoot: trustedRoot,
    digest: '0'.repeat(64),
    entryCount: 10,
    fileBytes: 100,
    requirementsSha256: '1'.repeat(64),
    requirementsInstallDigest: '1237553332',
  }
  const electronGypProvenance = {
    root: trustedRoot,
    digest: '2'.repeat(64),
    entryCount: 10,
    fileBytes: 100,
  }
  const buildToolchainProvenance = {
    binPath: resolve(sensitiveRoot, 'build-home/trusted-bin'),
    nodePath,
    nodeSha256: digestFile(nodePath),
    npmCliPath,
    npmCliSha256: digestFile(npmCliPath),
    npmWrapperSha256: '3'.repeat(64),
  }
  const fingerprint = [
    { kind: 'main', bytes: 100, mtimeMs: 1, sha256: '4'.repeat(64) },
    { kind: 'wal', bytes: 0, sha256: null },
    { kind: 'shm', bytes: 0, sha256: null },
    { kind: 'journal', bytes: 0, sha256: null },
  ]
  const sourceDatabase = {
    pathDigest: '5'.repeat(64),
    fingerprintBefore: fingerprint,
    fingerprintAfter: JSON.parse(JSON.stringify(fingerprint)),
    unchanged: true,
  }
  const handshake = {
    ok: true,
    proofNonce: '6'.repeat(48),
    execPath: electronPath,
    execSha256: buildProvenance.electronExecutableSha256,
    asarPath: null,
    asarSha256: null,
    sourceManifestDigest: recordedSource.digest,
    appPath: fixtureRoot,
    runtimeOutputManifestDigest: outputManifest.digest,
    userDataPath: resolve(sensitiveRoot, 'profile'),
    databasePath: resolve(sensitiveRoot, 'profile/ready.db'),
    appVersion: recordedSource.appVersion,
  }
  const gatewayPath = resolve(proofRoot, 'e6-gateway-capture.ndjson')
  const redactedPath = resolve(proofRoot, 'e6-redacted-evidence.json')
  const relationalLedgerPath = resolve(proofRoot, 'e6-relational-ledger.json')
  const completionPath = resolve(proofRoot, 'e6-runtime-completion.json')
  const reportPath = resolve(proofRoot, 'e6-live-proof-report.json')
  const relationalLedger = {
    schemaVersion: 1,
    proofMode: 'typed-and-cli-3-plus-3',
  }
  const artifactHashes = {
    rawEvidenceDatabaseSha256: '2'.repeat(64),
    rawEvidenceDatabaseRetained: false,
    gatewayCaptureSha256: null,
    redactedEvidenceSha256: null,
    relationalLedgerSha256: null,
  }
  const completion = {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: 'typed-and-cli-3-plus-3',
    proofId,
    completedAt: '2026-08-08T00:00:00.000Z',
    validatedPlanDigest: '3'.repeat(64),
    sourceManifestDigest: recordedSource.digest,
    outputManifestDigest: outputManifest.digest,
    buildProvenance,
    sidecarPythonProvenance,
    sidecarEnvironmentProvenance,
    electronGypProvenance,
    buildToolchainProvenance,
    handshake,
    sourceDatabase,
    artifacts: artifactHashes,
    shutdown,
    credentialSafety,
  }
  const report = {
    ok: true,
    schemaVersion: 1,
    phase: 'E6',
    proofMode: 'typed-and-cli-3-plus-3',
    runtimeMode: 'built-development-app',
    generatedAt: '2026-08-08T00:00:01.000Z',
    proofId,
    validatedPlanDigest: completion.validatedPlanDigest,
    sourceManifest: recordedSource,
    handshake: completion.handshake,
    evidence,
    sourceDatabaseUnchanged: true,
    shutdown,
    credentialSafety,
    artifacts: {
      completionMarkerPath: completionPath,
      completionMarkerSha256: null,
      redactedEvidencePath: redactedPath,
      redactedEvidenceSha256: artifactHashes.redactedEvidenceSha256,
      relationalLedgerPath,
      relationalLedgerSha256: artifactHashes.relationalLedgerSha256,
      gatewayCapturePath: gatewayPath,
      gatewayCaptureSha256: artifactHashes.gatewayCaptureSha256,
      rawEvidenceDatabaseSha256: artifactHashes.rawEvidenceDatabaseSha256,
      rawEvidenceDatabaseRetained: false,
    },
  }
  if (mutate) mutate({
    authorityRoot,
    completion,
    evidence,
    fixtureRoot,
    gatewayCapture,
    relationalLedger,
    report,
    runtimeManifest,
    sidecarExecutablePath,
    sensitiveRoot,
    shutdown,
  })
  writeFileSync(gatewayPath, `${gatewayCapture.map((row) => JSON.stringify(row)).join('\n')}\n`)
  writeJson(redactedPath, evidence)
  writeJson(relationalLedgerPath, relationalLedger)
  artifactHashes.gatewayCaptureSha256 = digestFile(gatewayPath)
  artifactHashes.redactedEvidenceSha256 = digestFile(redactedPath)
  artifactHashes.relationalLedgerSha256 = digestFile(relationalLedgerPath)
  report.artifacts.gatewayCaptureSha256 = artifactHashes.gatewayCaptureSha256
  report.artifacts.redactedEvidenceSha256 = artifactHashes.redactedEvidenceSha256
  report.artifacts.relationalLedgerSha256 = artifactHashes.relationalLedgerSha256
  writeJson(completionPath, completion)
  report.artifacts.completionMarkerSha256 = digestFile(completionPath)
  writeJson(reportPath, report)
  const phaseReport = {
    phase: 'E6',
    status: 'PASS',
    failureCode: null,
    nextPhase: 'E7',
    nextPhaseAllowed: true,
    liveProof: {
      proofId,
      reportPath: `outputs/codex-runtime-e6/${proofId}/e6-live-proof-report.json`,
      reportSha256: digestFile(reportPath),
      sourceManifestDigest: recordedSource.digest,
      runtimeManifestDigest: digestJson(runtimeManifest),
    },
  }
  return {
    fixtureRoot,
    leaseAuthority,
    sensitiveRoot,
    options: {
      repoRoot: fixtureRoot,
      phaseReport,
      currentRuntimeManifest: runtimeManifest,
      currentSourceManifest: sourceManifest(),
      currentOutputManifest: outputManifest,
      currentProvenance: {
        buildProvenance,
        sidecarPythonProvenance,
        sidecarEnvironmentProvenance,
        electronGypProvenance,
      },
      authorityRoot,
      leaseAuthority,
      allowHistoricalProofModeForTests: true,
    },
  }
}

function createUserScenarioFixture(mutate) {
  const proofId = 'a'.repeat(40)
  const sheetSentinel = sheetSentinelForProofId(proofId)
  const docxTaskMarker = docxTaskMarkerForProofId(proofId)
  const evidenceFixture = createUserEvidenceFixture({ sheetSentinel, docxTaskMarker })
  const cliIdentity = evidenceFixture.input.cliIdentity
  const fixture = createFixture((state) => {
    const mainProcessStartIdentity = 'main-process-real'
    const sidecarRuntimeExpectation = {
      runtimeManifestDigest: digestJson(state.runtimeManifest),
      binarySha256: state.runtimeManifest.binarySha256,
      executablePath: state.sidecarExecutablePath,
    }
    const lease = evidenceFixture.input.databaseEvidence.sidecarLeases[0]
    Object.assign(lease, {
      runtimeManifestDigest: sidecarRuntimeExpectation.runtimeManifestDigest,
      binarySha256: sidecarRuntimeExpectation.binarySha256,
      executablePath: sidecarRuntimeExpectation.executablePath,
      ownerMainPid: 4242,
      ownerMainProcessStartIdentity: mainProcessStartIdentity,
    })
    Object.assign(evidenceFixture.input, {
      runtimeManifestDigest: sidecarRuntimeExpectation.runtimeManifestDigest,
      protocolSchemaDigest: state.runtimeManifest.stableV2SchemaSha256,
      sidecarRuntimeExpectation,
      mainProcessExpectation: {
        pid: 4242,
        processStartIdentity: mainProcessStartIdentity,
      },
    })
    const bundle = buildE6UserScenarioEvidenceBundle(evidenceFixture.input)
    for (const key of Object.keys(state.evidence)) delete state.evidence[key]
    Object.assign(state.evidence, bundle.evidence)
    for (const key of Object.keys(state.relationalLedger)) delete state.relationalLedger[key]
    Object.assign(state.relationalLedger, bundle.relationalLedger)
    state.gatewayCapture.splice(
      0, state.gatewayCapture.length, ...evidenceFixture.input.gatewayCapture,
    )
    state.completion.proofMode = bundle.evidence.proofMode
    state.report.proofMode = bundle.evidence.proofMode
    state.completion.completedAt = '2026-08-10T02:00:00.000Z'
    state.report.generatedAt = '2026-08-10T02:00:01.000Z'
    state.completion.handshake.pid = 4242
    state.completion.handshake.processStartIdentityDigest = sha(mainProcessStartIdentity)
    const validatedPlanDigest = digestJson({
      schemaVersion: 1,
      proofMode: bundle.evidence.proofMode,
      sourceManifestDigest: state.report.sourceManifest.digest,
      outputManifestDigest: state.completion.outputManifestDigest,
      cliIdentity,
      sheetReferenceDigest: digestJson(EXPECTED_SHEET_URL),
      docxReferenceDigest: digestJson(EXPECTED_DOCX_URL),
      sheetSentinelDigest: digestJson(sheetSentinel),
      docxTaskMarkerDigest: digestJson(docxTaskMarker),
    })
    state.completion.validatedPlanDigest = validatedPlanDigest
    state.report.validatedPlanDigest = validatedPlanDigest
    mutate?.(state)
  })
  fixture.options.currentCliAuthority = cliIdentity
  return fixture
}

test('a complete, internally bound E6 3+3 proof can be promoted', async () => {
  const fixture = createFixture()
  try {
    const result = await assertE6LiveProofPromotion(fixture.options)
    assert.equal(result.proofId, 'a'.repeat(40))
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('the historical 3+3 read proof cannot promote the current E6 phase', async () => {
  const fixture = createFixture()
  try {
    delete fixture.options.allowHistoricalProofModeForTests
    await assert.rejects(assertE6LiveProofPromotion(fixture.options),
      /e6_promotion_report_contract_invalid/)
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a strongly bound ordinary Ready Agent write/readback proof can be promoted', async () => {
  const fixture = createUserScenarioFixture()
  try {
    const result = await assertE6LiveProofPromotion(fixture.options)
    assert.equal(result.proofId, 'a'.repeat(40))
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('ordinary scenario promotion rejects reused confirmations and fake polish readback', async () => {
  for (const mutate of [
    ({ evidence }) => { evidence.confirmations[2].argsDigest = evidence.confirmations[1].argsDigest },
    ({ evidence }) => {
      evidence.resources.docx.readbackContentDigest = evidence.resources.docx.preReadContentDigest
    },
  ]) {
    const fixture = createUserScenarioFixture(mutate)
    try {
      await assert.rejects(assertE6LiveProofPromotion(fixture.options))
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true })
    }
  }
})

test('ordinary scenario promotion rejects a forged proof marker or plan digest', async () => {
  for (const [mutate, expected] of [
    [({ evidence }) => { evidence.resources.sheet.sentinelDigest = sha('forged-sentinel') },
      /e6_user_scenario_relational_ledger_invalid/],
    [({ completion, report }) => {
      completion.validatedPlanDigest = sha('forged-plan')
      report.validatedPlanDigest = completion.validatedPlanDigest
    }, /e6_promotion_user_plan_identity_invalid/],
  ]) {
    const fixture = createUserScenarioFixture(mutate)
    try {
      await assert.rejects(
        assertE6LiveProofPromotion(fixture.options),
        expected,
      )
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true })
    }
  }
})

test('a later commit may change HEAD when every stable source file is identical', async () => {
  const fixture = createFixture()
  fixture.options.currentSourceManifest.head = 'b'.repeat(40)
  try {
    await assertE6LiveProofPromotion(fixture.options)
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('promotion rejects while another E6 owner holds the global lease', async () => {
  const fixture = createFixture()
  const ownerLease = await fixture.leaseAuthority.acquire()
  try {
    await assert.rejects(
      assertE6LiveProofPromotion(fixture.options),
      /e6_promotion_global_lease_busy/,
    )
  } finally {
    await fixture.leaseAuthority.release(ownerLease)
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('promotion holds the global lease until every asynchronous check completes', async () => {
  const fixture = createFixture()
  const originalProvenance = fixture.options.currentProvenance
  let releaseProvenance
  fixture.options.currentProvenance = new Promise((resolveProvenance) => {
    releaseProvenance = () => resolveProvenance(originalProvenance)
  })
  const promotion = assertE6LiveProofPromotion(fixture.options)
  try {
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    assert.equal(fixture.leaseAuthority.held, true)
    assert.deepEqual(await fixture.leaseAuthority.acquire(), {
      acquired: false,
      code: 'e6_global_lease_busy',
    })
    releaseProvenance()
    await promotion
    assert.equal(fixture.leaseAuthority.held, false)
  } finally {
    releaseProvenance()
    await promotion.catch(() => {})
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('a hand-edited PASS report without a live artifact cannot be promoted', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ready-e6-fake-pass-'))
  try {
    await assert.rejects(assertE6LiveProofPromotion({
      repoRoot: fixtureRoot,
      leaseAuthority: createTestLeaseAuthority(),
      phaseReport: {
        phase: 'E6',
        status: 'PASS',
        failureCode: null,
        nextPhase: 'E7',
        nextPhaseAllowed: true,
        liveProof: {
          proofId: 'a'.repeat(40),
          reportPath: `outputs/codex-runtime-e6/${'a'.repeat(40)}/e6-live-proof-report.json`,
          reportSha256: '1'.repeat(64),
          sourceManifestDigest: '2'.repeat(64),
          runtimeManifestDigest: '3'.repeat(64),
        },
      },
    }), /e6_promotion_success_report_not_unique/)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

for (const [name, mutate, expected] of [
  ['unclean shutdown', ({ shutdown }) => { shutdown.processGroupsZeroConfirmed = false },
    /e6_promotion_shutdown_invalid/],
  ['retained raw database', ({ completion, report }) => {
    completion.artifacts.rawEvidenceDatabaseRetained = true
    report.artifacts.rawEvidenceDatabaseRetained = true
  }, /e6_promotion_artifact_hash_invalid/],
  ['forged run count', ({ evidence }) => { evidence.runCount = 5 },
    /e6_promotion_evidence_invalid/],
  ['forged run order', ({ evidence }) => {
    ;[evidence.runs[0], evidence.runs[3]] = [evidence.runs[3], evidence.runs[0]]
  }, /e6_promotion_run_cardinality_invalid/],
  ['run ids mixed across one thread and turn', ({ gatewayCapture }) => {
    gatewayCapture[0].readyRunId = 'ready-run-1'
  }, /e6_promotion_gateway_run_binding_invalid/],
  ['a mock provider identity', ({ evidence }) => {
    evidence.providerIdentity.providerId = 'mock-fixture'
    evidence.providerIdentity.endpointClass = 'local_test_http'
  }, /e6_promotion_evidence_invalid/],
  ['a missing source database represented as an all-zero fingerprint', ({ completion }) => {
    const absent = ['main', 'wal', 'shm', 'journal'].map((kind) => ({
      kind,
      bytes: 0,
      sha256: null,
    }))
    completion.sourceDatabase.fingerprintBefore = absent
    completion.sourceDatabase.fingerprintAfter = JSON.parse(JSON.stringify(absent))
  }, /e6_promotion_source_database_invalid/],
  ['an ambient sensitive root outside the fixed authority root', ({
    completion, fixtureRoot,
  }) => {
    const ambientRoot = resolve(fixtureRoot, `ambient/ready-codex-e6-${'a'.repeat(40)}`)
    completion.handshake.userDataPath = resolve(ambientRoot, 'profile')
    completion.handshake.databasePath = resolve(ambientRoot, 'profile/ready.db')
    completion.buildToolchainProvenance.binPath = resolve(ambientRoot, 'build-home/trusted-bin')
  }, /e6_promotion_sensitive_root_identity_invalid/],
  ['an abandoned staging directory in the fixed authority root', ({ authorityRoot }) => {
    mkdirSync(resolve(authorityRoot, `ready-codex-e6-staging-${'b'.repeat(40)}-123`), {
      mode: 0o700,
    })
  }, /e6_promotion_authority_root_not_clean/],
  ['a secret-shaped retained field', ({ completion, report }) => {
    completion.handshake.body = 'retained body'
    report.handshake.body = 'retained body'
  }, /e6_promotion_sensitive_payload_retained/],
  ['an incomplete provider identity', ({ evidence }) => {
    delete evidence.providerIdentity.snapshotDigest
  }, /e6_promotion_evidence_invalid/],
  ['an incomplete build provenance', ({ completion }) => {
    delete completion.buildProvenance.packageLockSha256
  }, /e6_promotion_provenance_invalid/],
]) {
  test(`promotion rejects ${name}`, async () => {
    const fixture = createFixture(mutate)
    try {
      await assert.rejects(assertE6LiveProofPromotion(fixture.options), expected)
    } finally {
      rmSync(fixture.fixtureRoot, { recursive: true, force: true })
    }
  })
}

test('promotion rejects sensitive fields added to the PASS phase report itself', async () => {
  const fixture = createFixture()
  fixture.options.phaseReport.apiKey = 'phase-report-secret-canary'
  try {
    await assert.rejects(
      assertE6LiveProofPromotion(fixture.options),
      /e6_promotion_sensitive_payload_retained/,
    )
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})

test('promotion rejects a retained sensitive runtime root', async () => {
  const fixture = createFixture()
  mkdirSync(fixture.sensitiveRoot)
  try {
    await assert.rejects(
      assertE6LiveProofPromotion(fixture.options),
      /e6_promotion_sensitive_root_retained/,
    )
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true })
  }
})
