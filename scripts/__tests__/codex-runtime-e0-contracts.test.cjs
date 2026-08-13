const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  assetRoot,
  auditRoot,
  buildRuntimeManifest,
  digestFile,
  loadSources,
  readJson,
  repoRoot
} = require('../codex-runtime/contract-lib.cjs')
const {
  assertExactKeys,
  buildChildEnv,
  reserveStartIdentitySet,
  resolveStartDelivery,
  selectAgentMessageCandidate,
  stableZeroSatisfied,
  validateTurnIngress
} = require('../codex-runtime/e0-contract-model.cjs')

const fixtures = readJson(path.join(assetRoot, 'fixtures/e0-contract-fixtures.json'))
const {
  contracts,
  bindingSchema,
  experimentContract,
  experimentReportSchema,
  exitMatrix
} = loadSources()
const applicationCapture = readJson(
  path.join(assetRoot, 'fixtures/native-protocol-capture-application-context.json')
)
const untrustedCapture = readJson(
  path.join(assetRoot, 'fixtures/native-protocol-capture.json')
)

test('runtime manifest is a deterministic projection of the pinned sources and contracts', () => {
  const checkedIn = readJson(path.join(assetRoot, 'runtime-manifest.json'))
  assert.deepEqual(checkedIn, buildRuntimeManifest())
})

test('pinned schema exposes the required identity, context, phase and fixed thread tool fields', () => {
  const schema = readJson(
    path.join(assetRoot, 'schemas/experimental/codex_app_server_protocol.v2.schemas.json')
  )
  const definitions = schema.definitions
  const threadStart = definitions.ThreadStartParams.properties
  const threadResume = definitions.ThreadResumeParams.properties
  const turnStart = definitions.TurnStartParams.properties
  assert.ok(threadStart.dynamicTools)
  assert.ok(threadStart.runtimeWorkspaceRoots)
  assert.ok(threadStart.environments)
  assert.ok(threadStart.allowProviderModelFallback)
  assert.equal(threadResume.dynamicTools, undefined)
  for (const field of [
    'clientUserMessageId',
    'environments',
    'input',
    'additionalContext',
    'responsesapiClientMetadata',
  ]) {
    assert.ok(turnStart[field], `turn/start is missing ${field}`)
  }
  const itemVariants = definitions.ThreadItem.oneOf.map((variant) => variant.properties)
  const userMessage = itemVariants.find((properties) => properties.type.enum[0] === 'userMessage')
  const agentMessage = itemVariants.find((properties) => properties.type.enum[0] === 'agentMessage')
  assert.ok(userMessage.clientId)
  assert.ok(agentMessage.phase)
  assert.ok(itemVariants.some((properties) => properties.type.enum[0] === 'contextCompaction'))
  assert.deepEqual(definitions.AdditionalContextKind.enum.sort(), ['application', 'untrusted'])
})

test('thread start contract matches the production context-window override', () => {
  const threadStart = contracts.outboundRpcContract.threadStart
  assert.equal(threadStart.required.includes('config'), true)
  assert.equal(threadStart.mustBeOmitted.includes('config'), false)
  assert.deepEqual(threadStart.config, {
    nullable: true,
    exactKeysWhenPresent: ['model_context_window'],
    modelContextWindow: 'positive_safe_integer'
  })
})

test('real pinned app-server capture freezes native identity, isolation and exact tool surfaces', () => {
  assert.equal(untrustedCapture.threads.first.source, 'vscode')
  assert.equal(untrustedCapture.threads.instructionSourcesEmpty, true)
  assert.equal(untrustedCapture.threads.rootMetadataValid, true)
  assert.equal(untrustedCapture.threads.list.data.length, 1)
  assert.equal(untrustedCapture.threads.list.data[0].id, untrustedCapture.threads.first.id)
  assert.deepEqual(
    untrustedCapture.childEnvironment.keys,
    contracts.childEnvAllowlist.allowedKeys
  )
  assert.equal(untrustedCapture.invariants.userClientIdReadback, true)
  assert.equal(untrustedCapture.invariants.nonUserSuccessorIdentitySupported, false)
  assert.equal(untrustedCapture.invariants.trueRootConcurrency, true)
  assert.equal(untrustedCapture.appServer.dynamicToolServerRequests.length, 1)

  for (const request of untrustedCapture.provider.requests) {
    const metadata = JSON.parse(request.summary.clientMetadata['x-codex-turn-metadata'])
    const expectedTools = metadata.request_kind === 'compaction' ? [] : ['ready_read_probe']
    assert.deepEqual(request.summary.toolNames, expectedTools)
    if (metadata.request_kind === 'turn') {
      assert.deepEqual(
        Object.keys(metadata)
          .filter((key) => contracts.outboundRpcContract.turnStart.metadataKeys.includes(key))
          .sort(),
        [...contracts.outboundRpcContract.turnStart.metadataKeys].sort()
      )
    }
  }
})

test('both schema-defined additionalContext roles retain the superseded resource value', () => {
  assert.equal(applicationCapture.runtime.resourceContextKind, 'application')
  assert.equal(untrustedCapture.runtime.resourceContextKind, 'untrusted')
  for (const capture of [applicationCapture, untrustedCapture]) {
    const secondRequest = capture.provider.requests.find(
      (request) => request.summary.inputContains.resourceV2
    )
    assert.ok(secondRequest)
    assert.equal(secondRequest.summary.inputContains.resourceV1, true)
    assert.equal(secondRequest.summary.inputContains.resourceV2, true)
    assert.equal(
      capture.invariants.resourceV2DoesNotRetainResourceV1InCurrentContext,
      false
    )
  }
  assert.equal(contracts.resourceAdditionalContextContract.pinnedVersionVerdict, 'fail')
  assert.equal(contracts.resourceAdditionalContextContract.nextPhaseAllowed, false)
})

test('experiment contract and report schema keep the E0 stop rule machine-readable', () => {
  assert.deepEqual(experimentContract.legalVerdicts, ['PASS', 'FAIL', 'BLOCKED'])
  assert.equal(experimentContract.phaseAdvanceRule, 'previous_phase_must_pass')
  assert.equal(experimentContract.e0.productCodeChangesAllowed, false)
  assert.equal(experimentContract.e0.nextPhaseBlockedWhenResourceReplacementFails, true)
  for (const field of experimentReportSchema.required) {
    assert.ok(experimentReportSchema.properties[field], `report schema missing ${field}`)
  }
  assert.deepEqual(experimentReportSchema.properties.verdict.properties.status.enum, [
    'PASS',
    'FAIL',
    'BLOCKED'
  ])
})

test('E0 failure report matches its evidence and cannot authorize E1', () => {
  const report = readJson(
    path.join(auditRoot, '2026-08-06-codex-runtime-e0-failure-report.json')
  )
  for (const field of experimentReportSchema.required) {
    assert.ok(report[field] !== undefined, `failure report missing ${field}`)
  }
  assert.equal(report.verdict.status, 'FAIL')
  assert.equal(report.verdict.failureCode, 'codex_additional_context_previous_value_retained')
  assert.equal(report.verdict.nextPhaseAllowed, false)
  assert.equal(report.productImplementation.started, false)
  assert.deepEqual(report.productImplementation.changedProductPaths, [])
  assert.equal(report.review.identity, '/root/e0_adversarial_reviewer')
  assert.equal(report.review.verdict, 'PASS')

  const evidence = report.protocol.evidenceDigests
  assert.equal(
    evidence.runtimeManifest,
    digestFile(path.join(assetRoot, 'evidence/e0-runtime-manifest.json'))
  )
  assert.equal(
    evidence.applicationContextCapture,
    digestFile(path.join(assetRoot, 'fixtures/native-protocol-capture-application-context.json'))
  )
  assert.equal(
    evidence.untrustedContextCapture,
    digestFile(path.join(assetRoot, 'fixtures/native-protocol-capture.json'))
  )
  assert.equal(
    evidence.exitAuthorityMatrix,
    digestFile(
      path.join(auditRoot, '2026-08-06-codex-runtime-exit-authority-matrix.json')
    )
  )
  const protocolGate = report.commands.find(
    (entry) => entry.command === 'npm run verify:codex-runtime-protocol'
  )
  assert.deepEqual(
    { exitCode: protocolGate?.exitCode, status: protocolGate?.status },
    { exitCode: 1, status: 'FAIL' }
  )
})

test('turn ingress is a closed tagged union with no history-shaped third form', () => {
  const user = validateTurnIngress({
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-1',
    canonicalCurrentInputRef: { type: 'text', text: 'hello' },
    explicitResourceEnvelope: [],
    resourceAdditionalContext: { kind: 'ready_resources', resources: [] }
  })
  assert.equal(user.ok, true)
  assert.deepEqual(user.turnStartInput, [{ type: 'text', text: 'hello' }])

  const successor = validateTurnIngress({
    kind: 'non_user_successor',
    attemptKind: 'recovery_successor',
    originUserMessageId: 'message-1',
    predecessorRunId: 'run-1',
    turnStartInput: [],
    signedContinuationContextRef: 'context-1',
    historyParityEvidenceDigest: 'a',
    currentThreadReadEvidenceDigest: 'b',
    continuationContractDigest: 'c'
  })
  assert.equal(successor.ok, true)
  assert.deepEqual(successor.turnStartInput, [])

  assert.deepEqual(
    validateTurnIngress({
      kind: 'non_user_successor',
      attemptKind: 'explicit_retry',
      originUserMessageId: 'message-1',
      predecessorRunId: 'run-1',
      turnStartInput: [{ type: 'text', text: 'replay' }],
      signedContinuationContextRef: 'context-1',
      historyParityEvidenceDigest: 'a',
      currentThreadReadEvidenceDigest: 'b',
      continuationContractDigest: 'c'
    }),
    { ok: false, code: 'successor_input_must_be_empty' }
  )
})

test('response selection fixtures enforce exact completed body and fail closed', () => {
  for (const fixture of fixtures.responseSelection) {
    assert.deepEqual(selectAgentMessageCandidate(fixture), fixture.expected, fixture.id)
  }
})

test('failed native turns retire an unproven history instead of continuing it', () => {
  assert.equal(
    contracts.historyPublicationParityContract.failureClasses.engine_failed,
    'retire_publication_diverged'
  )
  assert.equal(
    contracts.historyPublicationParityContract.failureClasses.provider_failed,
    'retire_publication_diverged'
  )
})

test('start delivery is one three-way table independent of write-confirmed state', () => {
  for (const fixture of fixtures.startDelivery) {
    assert.equal(resolveStartDelivery(fixture.evidence), fixture.expected, fixture.id)
  }
  const base = fixtures.startDelivery.find((fixture) => fixture.id === 'accepted-before-write-callback').evidence
  assert.equal(resolveStartDelivery({ ...base, writeConfirmed: true }), 'accepted')
})

test('start identity capacity reserves complete sets before product persistence', () => {
  for (const fixture of fixtures.reservationSets) {
    const result = reserveStartIdentitySet(fixture)
    assert.equal(result.accepted, fixture.expected.accepted, fixture.id)
    assert.equal(result.reserved, fixture.expected.reserved, fixture.id)
  }
})

test('process lease requires a complete post-deadline stable-zero window', () => {
  for (const fixture of fixtures.stableZeroSamples) {
    assert.equal(
      stableZeroSatisfied(fixture, contracts.processLeaseContract.stableZero),
      fixture.expected,
      fixture.id
    )
  }
  assert.equal(contracts.processLeaseContract.matcherModesMutuallyExclusive, true)
})

test('child environment is built from an exact allowlist and excludes host secret canaries', () => {
  const child = buildChildEnv(
    {
      tmpDir: '/tmp/ready-codex',
      home: '/tmp/ready-codex/home',
      codexHome: '/tmp/ready-codex/codex-home',
      gatewayUrl: 'http://127.0.0.1:1234/v1',
      gatewayToken: 'short-lived-token',
      processLeaseId: 'lease-1',
      sidecarSpawnInstanceId: 'spawn-1',
      connectionEpoch: 'epoch-1',
      stateDir: '/tmp/ready-codex/state',
      READY_PROVIDER_SECRET_CANARY: 'must-not-leak'
    },
    contracts.childEnvAllowlist
  )
  assert.deepEqual(Object.keys(child), contracts.childEnvAllowlist.allowedKeys)
  assert.equal(child.READY_PROVIDER_SECRET_CANARY, undefined)
  assert.equal(Object.values(child).includes('must-not-leak'), false)
})

test('outbound RPC contract rejects an extra metadata key before child bytes', () => {
  const exactMetadata = {
    readyRunId: 'run-1',
    toolSurfaceDigest: 'tools',
    turnContractDigest: 'turn',
    upstreamProfileSnapshotDigest: 'profile'
  }
  assert.deepEqual(
    assertExactKeys(exactMetadata, contracts.outboundRpcContract.turnStart.metadataKeys),
    { ok: true }
  )
  assert.deepEqual(
    assertExactKeys(
      { ...exactMetadata, callerControlled: 'forbidden' },
      contracts.outboundRpcContract.turnStart.metadataKeys
    ),
    { ok: false, code: 'outbound_params_not_exact', childBytes: 0 }
  )
})

test('tool bridge contract freezes one Ready execution path and conservative action recovery', () => {
  const bridge = contracts.toolBridgeContract
  const bridgeSource = fs.readFileSync(path.join(
    repoRoot,
    'src/main/modules/agent-control/codex-runtime/codex-tool-bridge.ts'
  ), 'utf8')
  assert.equal(bridge.executionPath, 'Ready_executeToolCall_only')
  assert.equal(bridge.directProductDomainCalls, false)
  assert.equal(bridge.journalBeforeExecution, true)
  assert.equal(bridge.pendingAfterRestart, 'effect_unknown')
  assert.equal(bridge.sameActionIdentityReplay, false)
  assert.equal(bridge.deadJsonRpcReplay, false)
  assert.equal(bridge.persistenceBoundary.callBindingResultBody, false)
  assert.equal(bridge.persistenceBoundary.readyActionJournalResultBody, true)
  assert.match(bridge.argumentValidation, /after_lazy_executor_load/)
  assert.match(bridge.preEffectAuthority, /active_owner_fence/)
  assert.match(bridge.preEffectAuthority, /effect_start_after_confirmation/)
  assert.match(bridge.timeoutPolicy, /effect_start_end/)
  assert.match(bridge.connectionClosePolicy, /abort_signal/)
  assert.match(bridge.connectionClosePolicy, /sidecar_transport_owned/)
  assert.match(bridge.abortPolicy.authorityMissing, /rejects_before_call_binding/)
  assert.match(bridge.deliveryPolicy, /exact_frozen_action_identity/)
  assert.equal(bridge.confirmedResponseRecovery.requiresConfirmedActionReceipt, true)
  assert.equal(bridge.confirmedResponseRecovery.requiresEveryPriorConnectionDead, true)
  assert.equal(bridge.confirmedResponseRecovery.reexecutesReadyAction, false)
  assert.equal(bridge.confirmedResponseRecovery.sameLiveRpcDuplicateResponse, false)
  assert.equal(
    bridge.persistenceBoundary.transportWriteAckBoundary,
    'actual_write_callback_success'
  )
  assert.match(bridge.resultMapping.success, /legacy_data_errorKind_or_ok_false/)
  assert.equal(
    bridge.budgetPolicy.maxToolCalls,
    'durable_call_binding_admission_counted_per_ready_run_before_effect'
  )
  assert.match(bridge.budgetPolicy.maxIterations, /E5_gateway_gate_required/)
  assert.match(bridge.budgetPolicy.maxParallelToolGroups, /E5_collector_gate_required/)
  assert.equal(
    bindingSchema.tables.codex_tool_call_bindings.columns.includes('result_json'),
    false
  )
  assert.equal(
    bindingSchema.tables.ready_tool_action_receipts.columns.includes('result_json'),
    true
  )
  assert.equal(
    bindingSchema.tables.codex_turn_bindings.columns.includes('product_budget_seed_json'),
    true
  )
  assert.deepEqual(bridge.journalStates, [
    'pending',
    'confirmed',
    'proven_absent',
    'indeterminate'
  ])
  assert.deepEqual(bridge.recovery.sameThreadSuccessorRequires, [
    'history_publication_parity',
    'current_thread_readback',
    'non_user_continuation_gate'
  ])
  assert.match(bridgeSource, /await import\('\.\.\/\.\.\/tools\/tool-executor'\)/)
  for (const forbidden of [
    '/browser-engine/',
    '/domain-adapters/',
    '/document/',
    '/mcp/',
    '/shell/'
  ]) assert.doesNotMatch(bridgeSource, new RegExp(forbidden.replaceAll('/', '\\/')))
})

test('all binding tables and critical cross-table invariants are frozen', () => {
  const codexTables = Object.keys(bindingSchema.tables)
    .filter((name) => name.startsWith('codex_'))
    .sort()
  assert.deepEqual(codexTables, [
    'codex_fence_owner_transfers',
    'codex_manual_compaction_bindings',
    'codex_manual_compaction_dispatch_attempts',
    'codex_sidecar_process_leases',
    'codex_thread_bindings',
    'codex_thread_dispatch_fences',
    'codex_thread_resume_evidence',
    'codex_tool_call_bindings',
    'codex_tool_response_delivery_attempts',
    'codex_turn_bindings'
  ])
  assert.equal(bindingSchema.sqliteForeignKeysAssumed, false)
  assert.equal(bindingSchema.singleWriterModule['codex_*'], 'CodexBindingRepository')
  assert.ok(bindingSchema.crossTableInvariants.includes('thread_turn_call_parent_identity_exact'))
  assert.deepEqual(bindingSchema.tables.codex_thread_resume_evidence.unique, [
    ['thread_binding_id', 'connection_epoch'],
    ['evidence_digest']
  ])
  assert.equal(bindingSchema.tables.codex_thread_resume_evidence.immutable, true)
  assert.equal(bindingSchema.tables.codex_thread_resume_evidence.deleteForbidden, true)
  assert.equal(bindingSchema.tables.codex_tool_response_delivery_attempts.immutable, true)
  assert.equal(bindingSchema.tables.codex_tool_response_delivery_attempts.deleteForbidden, true)
  assert.ok(bindingSchema.crossTableInvariants.includes(
    'publication_recomputes_candidate_response_digest_from_any_exact_delivery_attempt'
  ))
  assert.ok(bindingSchema.crossTableInvariants.includes(
    'existing_thread_resume_requires_same_live_client_epoch_thread_read_evidence_before_resume'
  ))
  assert.ok(bindingSchema.crossTableInvariants.includes(
    'thread_resume_evidence_parent_requires_connection_opened_and_closed_at_tree_zero_null'
  ))
  assert.deepEqual(contracts.outboundRpcContract.existingThreadResume.requiredOrder, [
    'thread/read',
    'thread/resume'
  ])
  assert.equal(contracts.outboundRpcContract.existingThreadResume.sameConnectionEpoch, true)
  assert.equal(contracts.outboundRpcContract.existingThreadResume.sameClientInstance, true)
  assert.equal(contracts.outboundRpcContract.existingThreadResume.connectionMustRemainOpen, true)
  assert.equal(
    bindingSchema.tables.codex_manual_compaction_dispatch_attempts.retryPolicy,
    'only_after_exact_write_not_attempted_proof'
  )
  assert.deepEqual(
    Object.keys(bindingSchema.tables).filter((name) => name.startsWith('ready_model_gateway_')).sort(),
    [
      'ready_model_gateway_exchange_events',
      'ready_model_gateway_profile_snapshots',
      'ready_model_gateway_request_receipts'
    ]
  )
  assert.equal(
    bindingSchema.singleWriterModule['ready_model_gateway_*'],
    'CodexModelGatewayRepository'
  )
  assert.equal(
    bindingSchema.singleWriterModule.ready_tool_action_receipts,
    'CodexToolActionJournal'
  )
  assert.deepEqual(
    bindingSchema.tables.ready_tool_action_receipts.closedEnums.state,
    ['pending', 'confirmed', 'proven_absent', 'indeterminate']
  )
})

test('exit authority matrix has no undecided row and covers every current terminal reason', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'src/main/modules/agent-control/runtime-core/turn-frame.ts'),
    'utf8'
  )
  const block = source.match(/TURN_TERMINAL_REASONS = \[([\s\S]*?)\] as const/)
  assert.ok(block)
  const reasons = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(Object.keys(exitMatrix.terminalReasonCoverage).sort(), reasons.sort())
  const allowed = new Set(['preserve', 'migrate', 'unsupported', 'retire'])
  for (const row of exitMatrix.rows) {
    assert.ok(allowed.has(row.disposition), row.id)
    for (const field of ['targetDecisionPoint', 'candidatePolicy', 'publicationPolicy', 'fixture', 'behaviorGate']) {
      assert.ok(row[field], `${row.id} is missing ${field}`)
    }
  }
})
