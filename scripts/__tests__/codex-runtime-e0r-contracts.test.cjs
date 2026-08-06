const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { assetRoot, auditRoot, readJson } = require('../codex-runtime/contract-lib.cjs')
const {
  buildReport,
  evaluateE0rEvidence,
  exactKeys,
  validDenial
} = require('../codex-runtime/check-e0r-resource-authority.cjs')

const fixture = readJson(
  path.join(assetRoot, 'fixtures/e0r-resource-authority-capture.json')
)
const contract = readJson(
  path.join(assetRoot, 'contracts/e0r-resource-authority-contract.json')
)
const runtimeManifest = readJson(path.join(assetRoot, 'runtime-manifest.json'))
const oldReport = readJson(
  path.join(auditRoot, '2026-08-06-codex-runtime-e0-failure-report.json')
)

function inputs(overrides = {}) {
  return {
    fixture: structuredClone(fixture),
    contract: structuredClone(contract),
    runtimeManifest: structuredClone(runtimeManifest),
    oldReport: structuredClone(oldReport),
    paths: [],
    review: null,
    ...overrides
  }
}

test('E0-R contract keeps the old failure immutable and E1 fail closed', () => {
  assert.equal(contract.phase, 'E0-R')
  assert.equal(contract.baseE0Failure.immutable, true)
  assert.equal(contract.scope.productCodeChangesAllowed, false)
  assert.equal(contract.resourceReference.resourceBodyAllowed, false)
  assert.equal(contract.authority.publicationRequiresCurrentReadReceipt, true)
  assert.equal(
    contract.authority.mcpReceiptReconciliation.providerAndNativeCallIdsMustMatch,
    true
  )
  assert.equal(
    contract.authority.mcpReceiptReconciliation.rawRequestAndResultMustBeRecomputed,
    true
  )
  assert.equal(
    contract.authority.publicationReceiptMustJoinExactCaseThreadTurnCall,
    true
  )
  assert.equal(contract.nativeCompactionEvidence.compactPromptOverrideAllowed, false)
  assert.equal(
    contract.nativeCompactionEvidence
      .manualRequiresBoundThreadTurnItemProviderAndReadback,
    true
  )
  assert.equal(
    contract.nativeCompactionEvidence.resumeManualAndRestartTurnIdsMustMatchReadback,
    true
  )
  assert.equal(contract.agentMatrix.nativeTurnCompletedAndReadbackRequired, true)
  assert.equal(contract.phaseAdvance.allowedOnlyWhenAllRequiredGatesPass, true)
  assert.equal(contract.phaseAdvance.partialPassAllowed, false)
})

test('captured references are exact non-semantic version pointers', () => {
  const dispatches = fixture.dispatches.filter(
    (dispatch) => dispatch.caseId !== 'E0R_CASE_AUTO_SEED'
  )
  assert.ok(dispatches.length > 0)
  for (const dispatch of dispatches) {
    assert.ok(exactKeys(dispatch.additionalContext, ['ready_resource_ref']))
    const entry = dispatch.additionalContext.ready_resource_ref
    assert.equal(entry.kind, 'application')
    const reference = JSON.parse(entry.value)
    assert.ok(exactKeys(reference, contract.resourceReference.additionalContextFields))
    assert.equal(entry.value.includes('E0R_RESOURCE_'), false)
    assert.equal(entry.value.includes('policy says'), false)
  }
})

test('real pinned capture passes every evidence gate before independent review', () => {
  const evaluation = evaluateE0rEvidence(inputs())
  assert.equal(evaluation.status, 'BLOCKED')
  assert.equal(evaluation.nextPhaseAllowed, false)
  const notPassing = evaluation.gates.filter((gate) => gate.status !== 'PASS')
  assert.deepEqual(
    notPassing.map((gate) => ({ id: gate.id, status: gate.status })),
    [{ id: 'independent_review', status: 'BLOCKED' }]
  )
})

test('stale reads and writes fail closed with no body, receipt, identity or effect', () => {
  const staleReads = [
    fixture.authority.dynamicAudit.find(
      (entry) =>
        entry.kind === 'stale_read_denied' &&
        entry.frame.threadId === fixture.agents.root.threadId
    ),
    fixture.authority.mcpAudit.find(
      (entry) =>
        entry.kind === 'stale_read_denied' &&
        entry.metadata?.thread_id === fixture.agents.noHistoryChild.threadId
    ),
    fixture.authority.dynamicAudit.find(
      (entry) =>
        entry.kind === 'stale_read_denied' &&
        entry.frame.threadId === fixture.agents.historyChild.threadId
    )
  ]
  assert.ok(
    staleReads.every((entry) =>
      validDenial(entry, contract.authority.staleRead.errorCode)
    )
  )
  const staleWrites = fixture.authority.dynamicAudit.filter(
    (entry) => entry.kind === 'stale_write_denied'
  )
  assert.equal(staleWrites.length, 2)
  assert.ok(staleWrites.every((entry) => entry.effectIdentityCreated === false))
  assert.ok(staleWrites.every((entry) => entry.effectCountAfter === 0))
  assert.deepEqual(fixture.authority.effects, [])
})

test('missing current receipt and a leaked external effect each turn the phase FAIL', () => {
  const missingReceiptFixture = structuredClone(fixture)
  missingReceiptFixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT.allowed = true
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: missingReceiptFixture })).gates.find(
      (gate) => gate.id === 'publication_receipts'
    ).status,
    'FAIL'
  )

  const effectFixture = structuredClone(fixture)
  effectFixture.authority.effects.push({ effectId: 'forbidden' })
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: effectFixture })).gates.find(
      (gate) => gate.id === 'stale_mutation_zero_effect'
    ).status,
    'FAIL'
  )
})

test('default child uses the one-tool MCP fallback without claiming dynamic inheritance', () => {
  assert.equal(fixture.agents.noHistoryChild.dynamicReadAvailable, false)
  assert.equal(fixture.agents.noHistoryChild.mcpReadAvailable, true)
  assert.equal(fixture.agents.noHistoryChild.mutationToolAvailable, false)
  assert.equal(fixture.agents.noHistoryChild.publication.allowed, true)
  const childRequests = fixture.provider.captures.filter((capture) =>
    capture.marker.startsWith('E0R_CHILD_NONE_TASK')
  )
  assert.ok(childRequests.every((capture) => capture.summary.inputContains.v2Ref))
  assert.ok(childRequests.every((capture) => !capture.summary.inputContains.v1Body))
  assert.equal(fixture.agents.noHistoryChild.native.terminalStatus, 'completed')
  assert.equal(fixture.agents.noHistoryChild.native.readbackTurnFound, true)
  assert.equal(fixture.agents.noHistoryChild.native.mcpToolCalls.length, 2)
  const exposed = new Set(
    fixture.provider.captures.flatMap((capture) =>
      capture.summary.toolSurface
        .filter((tool) => tool.namespace === 'mcp__ready_resource')
        .map((tool) => tool.name)
    )
  )
  assert.deepEqual([...exposed], ['read_current_resource'])
})

test('automatic compaction and process restart are native observed events, not substitutes', () => {
  assert.equal(fixture.continuity.manualCompaction.item.type, 'contextCompaction')
  assert.equal(fixture.continuity.automaticCompaction.item.type, 'contextCompaction')
  assert.equal(fixture.continuity.automaticCompaction.providerRequests.length, 1)
  assert.equal(
    fixture.continuity.automaticCompaction.providerRequests[0].summary.turnMetadata.turn_id,
    fixture.continuity.automaticCompaction.v2TurnId
  )
  assert.equal(
    fixture.continuity.automaticCompaction.readbackTurn.itemTypes.includes(
      'contextCompaction'
    ),
    true
  )
  assert.equal(
    fixture.continuity.processRestart.originalThreadId,
    fixture.continuity.processRestart.resumedThreadId
  )
  assert.equal(fixture.publicationDecisions.E0R_CASE_AUTOMATIC_V2.allowed, true)
  assert.equal(fixture.publicationDecisions.E0R_CASE_RESTART_V2.allowed, true)
  assert.equal(
    fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT.canonicalBody,
    null
  )
})

test('MCP publication rejects forged receipt and Provider call identities', () => {
  const forged = structuredClone(fixture)
  const binding = forged.authority.mcpBindings.find(
    (entry) => entry.kind === 'current_read'
  )
  const receipt = forged.authority.receipts.find(
    (entry) => entry.receiptId === binding.receipt.receiptId
  )
  binding.providerCallId = 'forged-call'
  binding.nativeCallId = 'forged-call'
  binding.receipt.callId = 'forged-call'
  receipt.callId = 'forged-call'
  forged.agents.noHistoryChild.publication.receiptId = binding.receipt.receiptId
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: forged })).gates.find(
      (gate) => gate.id === 'publication_receipts'
    ).status,
    'FAIL'
  )
})

test('publication receipts cannot be borrowed from another valid turn or thread', () => {
  const borrowedReceipt = structuredClone(fixture)
  const resumeReceiptId =
    borrowedReceipt.publicationDecisions.E0R_CASE_RESUME_V2.receiptId
  borrowedReceipt.publicationDecisions.E0R_CASE_ROOT_V2.receiptId = resumeReceiptId
  borrowedReceipt.agents.root.publication.receiptId = resumeReceiptId
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: borrowedReceipt })).gates.find(
      (gate) => gate.id === 'publication_receipts'
    ).status,
    'FAIL'
  )

  const borrowedCall = structuredClone(fixture)
  const rootAudit = borrowedCall.authority.dynamicAudit.find(
    (entry) =>
      entry.kind === 'current_read' &&
      entry.frame.threadId === borrowedCall.agents.root.threadId &&
      entry.receipt.version === 'v2'
  )
  const rootReceipt = borrowedCall.authority.receipts.find(
    (entry) => entry.receiptId === rootAudit.receipt.receiptId
  )
  const resumeCallId = borrowedCall.authority.dynamicAudit.find(
    (entry) =>
      entry.kind === 'current_read' &&
      entry.receipt.receiptId ===
        borrowedCall.publicationDecisions.E0R_CASE_RESUME_V2.receiptId
  ).frame.callId
  rootAudit.frame.callId = resumeCallId
  rootAudit.receipt.callId = resumeCallId
  rootReceipt.callId = resumeCallId
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: borrowedCall })).gates.find(
      (gate) => gate.id === 'publication_receipts'
    ).status,
    'FAIL'
  )
})

test('MCP binding is recomputed from raw request, native result and Provider call', () => {
  const mutations = [
    (forged) => {
      forged.agents.noHistoryChild.native.mcpToolCalls.find(
        (entry) => entry.arguments.version === 'v2'
      ).arguments.version = 'v1'
    },
    (forged) => {
      forged.authority.mcpAudit.find(
        (entry) => entry.kind === 'current_read'
      ).requested.version = 'v1'
    },
    (forged) => {
      const item = forged.agents.noHistoryChild.native.mcpToolCalls.find(
        (entry) => entry.arguments.version === 'v2'
      )
      const result = JSON.parse(item.result.content[0].text)
      result.body = 'E0R_RESOURCE_V1_BODY: policy says ALPHA only.'
      item.result.content[0].text = JSON.stringify(result)
    },
    (forged) => {
      forged.agents.noHistoryChild.native.mcpToolCalls.find(
        (entry) => entry.arguments.version === 'v2'
      ).result.structuredContent = {
        body: 'E0R_RESOURCE_V1_BODY: policy says ALPHA only.'
      }
    }
  ]
  for (const mutate of mutations) {
    const forged = structuredClone(fixture)
    mutate(forged)
    const evaluation = evaluateE0rEvidence(inputs({ fixture: forged }))
    assert.equal(
      evaluation.gates.find((gate) => gate.id === 'publication_receipts').status,
      'FAIL'
    )
    assert.equal(
      evaluation.gates.find((gate) => gate.id === 'no_history_child_mcp_fallback')
        .status,
      'FAIL'
    )
  }
})

test('stale write and denial evidence is bound to each exact agent and resource', () => {
  const missingHistoryWrite = structuredClone(fixture)
  const rootResult = missingHistoryWrite.turnResults.find(
    (entry) => entry.caseId === 'E0R_CASE_ROOT_V2'
  )
  const historyWrite = missingHistoryWrite.authority.dynamicAudit.find(
    (entry) =>
      entry.kind === 'stale_write_denied' &&
      entry.frame.threadId === missingHistoryWrite.agents.historyChild.threadId
  )
  historyWrite.frame.threadId = rootResult.threadId
  historyWrite.frame.turnId = rootResult.turnId
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: missingHistoryWrite })).gates.find(
      (gate) => gate.id === 'stale_mutation_zero_effect'
    ).status,
    'FAIL'
  )

  const wrongResource = structuredClone(fixture)
  const rootRead = wrongResource.authority.dynamicAudit.find(
    (entry) =>
      entry.kind === 'stale_read_denied' &&
      entry.frame.threadId === wrongResource.agents.root.threadId
  )
  rootRead.frame.arguments.logicalResourceId = 'different-resource'
  rootRead.denial.logicalResourceId = 'different-resource'
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: wrongResource })).gates.find(
      (gate) => gate.id === 'stale_reads_denied'
    ).status,
    'FAIL'
  )
})

test('resume, manual compaction and restart identities bind to their real turns', () => {
  for (const field of ['readThenResume', 'manualCompaction', 'processRestart']) {
    const forged = structuredClone(fixture)
    forged.continuity[field].v2TurnId = 'forged-turn'
    assert.equal(
      evaluateE0rEvidence(inputs({ fixture: forged })).gates.find(
        (gate) => gate.id === 'native_continuity'
      ).status,
      'FAIL'
    )
  }

  const forgedManualNotification = structuredClone(fixture)
  forgedManualNotification.continuity.manualCompaction.notification.turnId =
    'forged-manual-turn'
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: forgedManualNotification })).gates.find(
      (gate) => gate.id === 'native_continuity'
    ).status,
    'FAIL'
  )
})

test('root visibility and thin references are recomputed from raw Provider captures', () => {
  for (const body of ['v1', 'v2']) {
    const erased = structuredClone(fixture)
    for (const capture of erased.provider.captures.filter(
      (entry) => entry.marker === 'E0R_CASE_ROOT_V2'
    )) {
      capture.summary.inputContains[`${body}Body`] = false
      capture.summary.occurrenceCounts[`${body}Body`] = 0
      for (const item of capture.summary.inputItemDigests) {
        item[`contains${body.toUpperCase()}Body`] = false
      }
    }
    assert.equal(
      evaluateE0rEvidence(inputs({ fixture: erased })).gates.find(
        (gate) => gate.id === 'v1_visible_v2_authoritative'
      ).status,
      'FAIL'
    )
  }

  const forgedDispatch = structuredClone(fixture)
  const dispatch = forgedDispatch.dispatches.find(
    (entry) => entry.caseId === 'E0R_CASE_ROOT_V2'
  )
  const reference = JSON.parse(dispatch.additionalContext.ready_resource_ref.value)
  reference.currentVersion = 'v1'
  reference.currentDigest = 'forged-digest'
  reference.policyEpoch = 1
  dispatch.additionalContext.ready_resource_ref.value = JSON.stringify(reference)
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: forgedDispatch })).gates.find(
      (gate) => gate.id === 'thin_non_semantic_references'
    ).status,
    'FAIL'
  )

  const forgedProviderReference = structuredClone(fixture)
  for (const capture of forgedProviderReference.provider.captures.filter(
    (entry) => entry.marker === 'E0R_CASE_ROOT_V2'
  )) {
    for (const ref of capture.summary.readyResourceRefs) {
      if (ref.currentVersion === 'v2') ref.currentVersion = 'v1'
    }
  }
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: forgedProviderReference })).gates.find(
      (gate) => gate.id === 'thin_non_semantic_references'
    ).status,
    'FAIL'
  )
})

test('child reference, full tool surface and native terminal gates reject drift', () => {
  const extraTool = structuredClone(fixture)
  extraTool.provider.captures
    .find((capture) => capture.marker.startsWith('E0R_CHILD_NONE_TASK'))
    .summary.toolSurface.push({ namespace: 'mcp__other_server', name: 'dangerous_mutation' })
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: extraTool })).gates.find(
      (gate) => gate.id === 'no_history_child_mcp_fallback'
    ).status,
    'FAIL'
  )

  const wrongReference = structuredClone(fixture)
  wrongReference.provider.captures
    .find((capture) => capture.marker.startsWith('E0R_CHILD_NONE_TASK'))
    .summary.readyResourceRefs[0].currentVersion = 'v1'
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: wrongReference })).gates.find(
      (gate) => gate.id === 'no_history_child_mcp_fallback'
    ).status,
    'FAIL'
  )

  const noTerminal = structuredClone(fixture)
  noTerminal.agents.historyChild.native.terminalStatus = null
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: noTerminal })).gates.find(
      (gate) => gate.id === 'history_child_authority'
    ).status,
    'FAIL'
  )
})

test('compaction and hard-isolation bindings reject self-asserted booleans', () => {
  const wrongCompaction = structuredClone(fixture)
  wrongCompaction.continuity.automaticCompaction.v2TurnId = 'forged-turn'
  wrongCompaction.continuity.automaticCompaction.item.id = 'forged-item'
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: wrongCompaction })).gates.find(
      (gate) => gate.id === 'native_continuity'
    ).status,
    'FAIL'
  )

  const sameThread = structuredClone(fixture)
  sameThread.hardIsolation.newThreadId = sameThread.hardIsolation.oldThreadId
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: sameThread })).gates.find(
      (gate) => gate.id === 'explicit_hard_isolation'
    ).status,
    'FAIL'
  )

  const leakedHardThread = structuredClone(fixture)
  leakedHardThread.provider.captures.find(
    (capture) => capture.marker === 'E0R_CASE_HARD_NEW_V2'
  ).summary.inputContains.v1Body = true
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: leakedHardThread })).gates.find(
      (gate) => gate.id === 'explicit_hard_isolation'
    ).status,
    'FAIL'
  )

  const promptOverride = structuredClone(fixture)
  promptOverride.experimentBoundary.compactPromptOverrideCount = 1
  assert.equal(
    evaluateE0rEvidence(inputs({ fixture: promptOverride })).gates.find(
      (gate) => gate.id === 'experiment_scope'
    ).status,
    'FAIL'
  )
})

test('pre-review report remains BLOCKED and never silently authorizes E1', () => {
  const evaluation = evaluateE0rEvidence(inputs())
  const report = buildReport(inputs(), evaluation)
  assert.equal(report.phase, 'E0-R')
  assert.equal(report.verdict.status, 'BLOCKED')
  assert.equal(report.verdict.nextPhaseAllowed, false)
  assert.equal(report.review.verdict, 'PENDING')
  assert.deepEqual(report.productImplementation.changedProductPaths, [])
})

test('the original E0 report remains the old-route FAIL evidence', () => {
  assert.equal(fs.existsSync(contract.baseE0Failure.report), true)
  assert.equal(oldReport.verdict.status, 'FAIL')
  assert.equal(
    oldReport.verdict.failureCode,
    'codex_additional_context_previous_value_retained'
  )
  assert.equal(oldReport.verdict.nextPhaseAllowed, false)
})
