const { canonicalJson, sha256 } = require('./contract-lib.cjs')

const V1_BODY = 'E0R_RESOURCE_V1_BODY: policy says ALPHA only.'
const V2_BODY = 'E0R_RESOURCE_V2_BODY: policy says BETA only.'

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  )
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function only(values) {
  return values.length === 1 ? values[0] : null
}

function validDenial(event, errorCode, expected = {}) {
  const denial = event?.denial
  const requested = event?.frame?.arguments || event?.requested
  return (
    denial?.ok === false &&
    denial.error === errorCode &&
    denial.logicalResourceId === (expected.logicalResourceId || 'resource-a') &&
    denial.requestedVersion === (expected.requestedVersion || 'v1') &&
    denial.currentVersion === (expected.currentVersion || 'v2') &&
    denial.bodyBytes === 0 &&
    denial.receipt === null &&
    requested?.logicalResourceId === denial.logicalResourceId &&
    requested?.version === denial.requestedVersion
  )
}

function parseNativeMcpResult(item) {
  const content = item?.result?.content
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') {
    return null
  }
  try {
    return JSON.parse(content[0].text)
  } catch {
    return null
  }
}

function resourceReferenceBindings(fixture, dispatches, resultsByCase) {
  const v1 = {
    logicalResourceId: fixture.authority.final.logicalResourceId,
    currentVersion: 'v1',
    currentDigest: sha256(V1_BODY),
    supersedesVersion: null,
    policyEpoch: 1
  }
  const v2 = {
    logicalResourceId: fixture.authority.final.logicalResourceId,
    currentVersion: fixture.authority.final.currentVersion,
    currentDigest: fixture.authority.final.currentDigest,
    supersedesVersion: 'v1',
    policyEpoch: fixture.authority.final.policyEpoch
  }
  return dispatches.map(({ dispatch, parsed }) => {
    const result = resultsByCase[dispatch.caseId]
    const expected = dispatch.caseId.endsWith('_V1') ? v1 : v2
    const allowed = dispatch.caseId.endsWith('_V1') ? [v1] : [v1, v2]
    const captures = fixture.provider.captures.filter(
      (capture) =>
        capture.marker === dispatch.caseId &&
        capture.summary.threadId === result?.threadId &&
        capture.summary.turnMetadata?.thread_id === result?.threadId &&
        capture.summary.turnMetadata?.turn_id === result?.turnId
    )
    const capturesValid =
      captures.length > 0 &&
      captures.every((capture) => {
        const refs = capture.summary.readyResourceRefs
        const hasV1 = refs.some((ref) => ref.currentVersion === 'v1')
        const hasV2 = refs.some((ref) => ref.currentVersion === 'v2')
        return (
          refs.length > 0 &&
          refs.some((ref) => sameJson(ref, expected)) &&
          refs.every(
            (ref) =>
              exactKeys(ref, [
                'logicalResourceId',
                'currentVersion',
                'currentDigest',
                'supersedesVersion',
                'policyEpoch'
              ]) && allowed.some((entry) => sameJson(entry, ref))
          ) &&
          capture.summary.inputContains.v1Ref === hasV1 &&
          capture.summary.inputContains.v2Ref === hasV2
        )
      })
    return {
      caseId: dispatch.caseId,
      valid:
        Boolean(result) &&
        dispatch.threadId === result.threadId &&
        sameJson(parsed, expected) &&
        capturesValid,
      expected,
      captureCount: captures.length
    }
  })
}

function rootVisibilityBinding(fixture, result, currentReceipt) {
  const captures = fixture.provider.captures.filter(
    (capture) => capture.marker === 'E0R_CASE_ROOT_V2'
  )
  const currentRead = captures.find(
    (capture) => capture.responseToolCall?.callId === currentReceipt?.callId
  )
  const postRead = captures.filter(
    (capture) => capture.sequence > (currentRead?.sequence || Infinity)
  )
  const summariesConsistent = captures.every(
    (capture) =>
      capture.summary.inputContains.v1Body ===
        (capture.summary.occurrenceCounts.v1Body > 0) &&
      capture.summary.inputContains.v2Body ===
        (capture.summary.occurrenceCounts.v2Body > 0) &&
      capture.summary.inputContains.v1Body ===
        capture.summary.inputItemDigests.some((item) => item.containsV1Body) &&
      capture.summary.inputContains.v2Body ===
        capture.summary.inputItemDigests.some((item) => item.containsV2Body)
  )
  const computed = {
    requestCount: captures.length,
    priorV1BodyVisible: captures.some((entry) => entry.summary.inputContains.v1Body),
    currentV2BodyVisibleAfterRead: postRead.some(
      (entry) => entry.summary.inputContains.v2Body
    ),
    candidateContainsOnlyV2: result?.finalText === V2_BODY
  }
  return {
    valid:
      captures.length === 4 &&
      summariesConsistent &&
      captures[0]?.summary.inputContains.v1Body === true &&
      captures[0]?.summary.inputContains.v2Body === false &&
      currentRead?.summary.inputContains.v1Body === true &&
      currentRead?.summary.inputContains.v2Body === false &&
      postRead.length > 0 &&
      postRead.some((entry) => entry.summary.inputContains.v2Body === true) &&
      computed.priorV1BodyVisible === true &&
      computed.currentV2BodyVisibleAfterRead === true &&
      computed.candidateContainsOnlyV2 === true,
    computed
  }
}

function hardIsolationBinding(fixture, resultsByCase, publicationValid) {
  const evidence = fixture.hardIsolation
  const oldResult = resultsByCase.E0R_CASE_HARD_OLD_V1
  const newResult = resultsByCase.E0R_CASE_HARD_NEW_V2
  const captures = fixture.provider.captures.filter(
    (capture) => capture.marker === 'E0R_CASE_HARD_NEW_V2'
  )
  const rawIsolationValid =
    captures.length > 0 &&
    captures.every(
      (capture) =>
        capture.summary.threadId === evidence.newThreadId &&
        capture.summary.inputContains.v1Body === false &&
        capture.summary.occurrenceCounts.v1Body === 0 &&
        capture.summary.inputItemDigests.every((item) => !item.containsV1Body) &&
        capture.summary.inputContains.v1Ref === false &&
        capture.summary.readyResourceRefs.every(
          (reference) => reference.currentVersion === 'v2'
        )
    )
  return {
    valid:
      evidence.explicitNewThread === true &&
      evidence.oldThreadId !== evidence.newThreadId &&
      rawIsolationValid &&
      evidence.newThreadProviderSawV1Body ===
        captures.some((entry) => entry.summary.inputContains.v1Body) &&
      evidence.oldReadbackThreadId === evidence.oldThreadId &&
      evidence.oldReadbackContainsV1 === true &&
      evidence.oldReadbackTurn?.id === oldResult?.turnId &&
      evidence.oldReadbackTurn?.status === 'completed' &&
      evidence.oldReadbackTurn?.finalText === V1_BODY &&
      oldResult?.threadId === evidence.oldThreadId &&
      newResult?.threadId === evidence.newThreadId &&
      evidence.oldRolloutFiles.length === 1 &&
      evidence.oldRolloutFiles.every((entry) => entry.includes(evidence.oldThreadId)) &&
      evidence.newRolloutFiles.length === 1 &&
      evidence.newRolloutFiles.every((entry) => entry.includes(evidence.newThreadId)) &&
      evidence.oldRolloutStillOnDisk === true &&
      publicationValid === true,
    rawCaptureCount: captures.length
  }
}

function dynamicCallBinding({ fixture, result, marker, kind, tool, version }) {
  if (!result) return { valid: false, audit: null, capture: null }
  const expectedBase = {
    logicalResourceId: fixture.authority.final.logicalResourceId,
    version
  }
  const captures = fixture.provider.captures.filter(
    (capture) =>
      capture.marker === marker &&
      capture.summary.threadId === result.threadId &&
      capture.summary.turnMetadata?.thread_id === result.threadId &&
      capture.summary.turnMetadata?.turn_id === result.turnId &&
      capture.responseKind === 'tool_call' &&
      capture.responseToolCall?.namespace === null &&
      capture.responseToolCall?.name === tool &&
      capture.responseToolCall?.arguments?.logicalResourceId ===
        expectedBase.logicalResourceId &&
      capture.responseToolCall?.arguments?.version === version
  )
  const capture = only(captures)
  const audits = fixture.authority.dynamicAudit.filter(
    (entry) =>
      entry.kind === kind &&
      entry.frame?.threadId === result.threadId &&
      entry.frame?.turnId === result.turnId &&
      entry.frame?.callId === capture?.responseToolCall?.callId
  )
  const audit = only(audits)
  const nativeCalls = marker.startsWith('E0R_CHILD_ALL_TASK')
    ? fixture.agents.historyChild.native?.dynamicToolCalls.filter(
        (item) => item.id === capture?.responseToolCall?.callId
      ) || []
    : []
  const nativeValid =
    !marker.startsWith('E0R_CHILD_ALL_TASK') ||
    (nativeCalls.length === 1 &&
      nativeCalls[0].type === 'dynamicToolCall' &&
      nativeCalls[0].tool === tool &&
      nativeCalls[0].status === 'completed' &&
      nativeCalls[0].success === true &&
      sameJson(nativeCalls[0].arguments, capture?.responseToolCall?.arguments))
  return {
    valid:
      Boolean(capture && audit) &&
      audit.frame.namespace === null &&
      audit.frame.tool === tool &&
      sameJson(audit.frame.arguments, capture.responseToolCall.arguments) &&
      nativeValid,
    audit,
    capture
  }
}

function dynamicPublicationBinding({
  fixture,
  result,
  marker,
  publication,
  requiredReceiptFields
}) {
  const authority = fixture.authority.final
  if (!result || !publication) return { valid: false, receipt: null }
  const receipt = only(
    fixture.authority.receipts.filter(
      (entry) => entry.receiptId === publication.receiptId
    )
  )
  const audit = only(
    fixture.authority.dynamicAudit.filter(
      (entry) =>
        entry.kind === 'current_read' &&
        entry.receipt?.receiptId === publication.receiptId
    )
  )
  const capture = only(
    fixture.provider.captures.filter(
      (entry) =>
        entry.marker === marker &&
        entry.summary.threadId === result.threadId &&
        entry.summary.turnMetadata?.thread_id === result.threadId &&
        entry.summary.turnMetadata?.turn_id === result.turnId &&
        entry.responseKind === 'tool_call' &&
        entry.responseToolCall?.callId === receipt?.callId
    )
  )
  const expectedArguments = {
    logicalResourceId: authority.logicalResourceId,
    version: authority.currentVersion
  }
  const nativeCalls = marker.startsWith('E0R_CHILD_ALL_TASK')
    ? fixture.agents.historyChild.native?.dynamicToolCalls.filter(
        (item) => item.id === receipt?.callId
      ) || []
    : []
  const nativeValid =
    !marker.startsWith('E0R_CHILD_ALL_TASK') ||
    (nativeCalls.length === 1 &&
      nativeCalls[0].type === 'dynamicToolCall' &&
      nativeCalls[0].tool === 'ready_resource_read' &&
      nativeCalls[0].status === 'completed' &&
      nativeCalls[0].success === true &&
      sameJson(nativeCalls[0].arguments, expectedArguments))
  return {
    valid:
      Boolean(receipt && audit && capture) &&
      result.terminalStatus === 'completed' &&
      result.finalText === V2_BODY &&
      publication.allowed === true &&
      publication.containsCurrent === true &&
      publication.containsSuperseded === false &&
      publication.canonicalBody === result.finalText &&
      publication.reason === 'current_receipt_and_body' &&
      receipt.transport === 'dynamic_tool' &&
      requiredReceiptFields.every(
        (field) => receipt[field] !== undefined && receipt[field] !== null
      ) &&
      receipt.threadId === result.threadId &&
      receipt.turnId === result.turnId &&
      receipt.logicalResourceId === authority.logicalResourceId &&
      receipt.version === authority.currentVersion &&
      receipt.digest === authority.currentDigest &&
      receipt.policyEpoch === authority.policyEpoch &&
      receipt.resultDigest === sha256(V2_BODY) &&
      audit.frame.threadId === result.threadId &&
      audit.frame.turnId === result.turnId &&
      audit.frame.callId === receipt.callId &&
      audit.frame.namespace === null &&
      audit.frame.tool === 'ready_resource_read' &&
      sameJson(audit.frame.arguments, expectedArguments) &&
      sameJson(audit.receipt, receipt) &&
      capture.responseToolCall.namespace === null &&
      capture.responseToolCall.name === 'ready_resource_read' &&
      sameJson(capture.responseToolCall.arguments, expectedArguments) &&
      nativeValid,
    receipt
  }
}

function recomputeMcpBindings(fixture, result) {
  const authority = fixture.authority.final
  const native = fixture.agents.noHistoryChild.native
  const audits = fixture.authority.mcpAudit.filter((entry) =>
    ['stale_read_denied', 'current_read'].includes(entry.kind)
  )
  const captures = fixture.provider.captures.filter(
    (capture) =>
      capture.marker.startsWith('E0R_CHILD_NONE_TASK') &&
      capture.responseKind === 'tool_call' &&
      capture.responseToolCall?.namespace === 'mcp__ready_resource' &&
      capture.responseToolCall?.name === 'read_current_resource'
  )
  const nativeCalls = native?.mcpToolCalls || []
  const bindings = fixture.authority.mcpBindings || []
  const specs = [
    { kind: 'stale_read_denied', version: 'v1' },
    { kind: 'current_read', version: 'v2' }
  ]
  const recomputed = []
  let valid =
    Boolean(result && native) &&
    audits.length === 2 &&
    captures.length === 2 &&
    nativeCalls.length === 2 &&
    bindings.length === 2 &&
    result.threadId === native.threadId &&
    result.turnId === native.turnId

  for (const spec of specs) {
    const audit = only(
      audits.filter(
        (entry) => entry.kind === spec.kind && entry.requested?.version === spec.version
      )
    )
    const nonce = audit?.requested?.requestNonce
    const capture = only(
      captures.filter(
        (entry) => entry.responseToolCall?.arguments?.requestNonce === nonce
      )
    )
    const nativeCall = only(
      nativeCalls.filter((entry) => entry.arguments?.requestNonce === nonce)
    )
    const expectedArguments = {
      logicalResourceId: authority.logicalResourceId,
      version: spec.version,
      requestNonce: nonce
    }
    const parsedResult = parseNativeMcpResult(nativeCall)
    const sharedValid =
      typeof nonce === 'string' &&
      nonce.length > 0 &&
      Boolean(audit && capture && nativeCall && parsedResult) &&
      audit.metadata?.thread_id === result?.threadId &&
      audit.metadata?.turn_id === result?.turnId &&
      sameJson(audit.requested, expectedArguments) &&
      capture.summary.threadId === result?.threadId &&
      capture.summary.turnMetadata?.thread_id === result?.threadId &&
      capture.summary.turnMetadata?.turn_id === result?.turnId &&
      sameJson(capture.responseToolCall.arguments, expectedArguments) &&
      nativeCall.id === capture.responseToolCall.callId &&
      nativeCall.type === 'mcpToolCall' &&
      nativeCall.server === 'ready_resource' &&
      nativeCall.tool === 'read_current_resource' &&
      nativeCall.status === 'completed' &&
      exactKeys(nativeCall.result, ['content', 'structuredContent', '_meta']) &&
      nativeCall.result.structuredContent === null &&
      nativeCall.result._meta === null &&
      sameJson(nativeCall.arguments, expectedArguments)
    let resultValid = false
    let provisionalReceiptId = null
    let hostReceipt = null
    if (spec.kind === 'stale_read_denied') {
      resultValid =
        exactKeys(parsedResult, [
          'ok',
          'error',
          'logicalResourceId',
          'requestedVersion',
          'currentVersion',
          'bodyBytes',
          'receipt'
        ]) &&
        sameJson(parsedResult, audit?.denial) &&
        validDenial(audit, 'resource_version_superseded', {
          logicalResourceId: authority.logicalResourceId,
          requestedVersion: 'v1',
          currentVersion: authority.currentVersion
        })
    } else {
      const provisional = audit?.provisionalReceipt
      provisionalReceiptId = provisional?.receiptId || null
      const provisionalValid =
        exactKeys(provisional, [
          'receiptId',
          'transport',
          'mcpRequestId',
          'threadId',
          'turnId',
          'callId',
          'requestNonce',
          'logicalResourceId',
          'version',
          'digest',
          'policyEpoch',
          'resultDigest'
        ]) &&
        typeof provisional.receiptId === 'string' &&
        provisional.receiptId.length > 0 &&
        typeof provisional.mcpRequestId === 'string' &&
        provisional.mcpRequestId.length > 0 &&
        provisional.transport === 'mcp_provisional' &&
        provisional.callId === null &&
        provisional.threadId === result?.threadId &&
        provisional.turnId === result?.turnId &&
        provisional.requestNonce === nonce &&
        provisional.logicalResourceId === authority.logicalResourceId &&
        provisional.version === authority.currentVersion &&
        provisional.digest === authority.currentDigest &&
        provisional.policyEpoch === authority.policyEpoch &&
        provisional.resultDigest === sha256(V2_BODY)
      resultValid =
        exactKeys(parsedResult, ['ok', 'body', 'bodyBytes', 'provisionalReceipt']) &&
        parsedResult.ok === true &&
        parsedResult.body === V2_BODY &&
        parsedResult.bodyBytes === Buffer.byteLength(V2_BODY) &&
        sameJson(parsedResult.provisionalReceipt, provisional) &&
        provisionalValid
      if (sharedValid && resultValid) {
        hostReceipt = {
          receiptId: `mcp-host-${nativeCall.id}`,
          transport: 'mcp_host_reconciled',
          threadId: result.threadId,
          turnId: result.turnId,
          callId: nativeCall.id,
          requestNonce: nonce,
          logicalResourceId: authority.logicalResourceId,
          version: authority.currentVersion,
          digest: authority.currentDigest,
          policyEpoch: authority.policyEpoch,
          resultDigest: sha256(V2_BODY)
        }
      }
    }
    const expectedBinding = {
      kind: spec.kind,
      requestNonce: nonce || null,
      providerCallId: capture?.responseToolCall?.callId || null,
      nativeCallId: nativeCall?.id || null,
      provisionalReceiptId,
      bindingValid: true,
      receipt: hostReceipt
    }
    const assertedBinding = only(bindings.filter((entry) => entry.kind === spec.kind))
    const authorityReceipt = hostReceipt
      ? only(
          fixture.authority.receipts.filter(
            (entry) => entry.receiptId === hostReceipt.receiptId
          )
        )
      : null
    const bindingValid =
      sharedValid &&
      resultValid &&
      sameJson(assertedBinding, expectedBinding) &&
      (hostReceipt
        ? sameJson(authorityReceipt, hostReceipt) &&
          !fixture.authority.receipts.some(
            (entry) => entry.receiptId === provisionalReceiptId
          )
        : authorityReceipt === null)
    valid = valid && bindingValid
    recomputed.push({ ...expectedBinding, bindingValid })
  }
  valid =
    valid &&
    new Set(recomputed.map((entry) => entry.requestNonce)).size === 2 &&
    new Set(recomputed.map((entry) => entry.providerCallId)).size === 2 &&
    fixture.authority.receipts.filter(
      (entry) => entry.transport === 'mcp_host_reconciled'
    ).length === 1
  return { valid, bindings: recomputed }
}

module.exports = {
  dynamicCallBinding,
  dynamicPublicationBinding,
  hardIsolationBinding,
  recomputeMcpBindings,
  resourceReferenceBindings,
  rootVisibilityBinding,
  sameJson,
  validDenial
}
