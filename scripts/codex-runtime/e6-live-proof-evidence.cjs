'use strict'

const { createHash } = require('node:crypto')

const THIN_REFERENCE_KEYS = [
  'currentDigest',
  'currentVersion',
  'logicalResourceId',
  'policyEpoch',
  'supersedesVersion',
]
const LARK_RESOURCE_PATHS = [
  'lark-doc/SKILL.md',
  'lark-shared/SKILL.md',
  'lark-doc/references/lark-doc-fetch.md',
]
const PROVIDER_SNAPSHOT_KEYS = [
  'agentProtocol',
  'authHeader',
  'authPrefix',
  'baseUrl',
  'credentialReferenceId',
  'extraHeaders',
  'model',
  'multiTurnThinkingPolicy',
  'patchProfileId',
  'profileId',
  'providerId',
  'reasoningEffort',
  'retryPolicy',
  'supportsNativeToolCalls',
  'supportsThinking',
  'supportsToolCalls',
  'supportsVision',
  'wireApi',
]
const RETRY_POLICY_KEYS = ['maxRetries', 'owner', 'semantic4xxRetries']

function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback
  return JSON.parse(value)
}

function readE6DatabaseEvidence(databasePath, scopeIds, sqliteJson) {
  const expectedScopes = new Set(scopeIds)
  const allThreads = sqliteJson(databasePath, `
    SELECT ready_conversation_alias AS scopeId, thread_binding_id AS threadBindingId,
           codex_thread_id AS codexThreadId, codex_session_id AS codexSessionId,
           tool_surface_digest AS toolSurfaceDigest, tool_surface_json AS toolSurfaceJson,
           runtime_manifest_digest AS runtimeManifestDigest,
           protocol_schema_digest AS protocolSchemaDigest,
           codex_model AS codexModel,
           upstream_profile_snapshot_ref AS upstreamProfileSnapshotRef,
           upstream_profile_snapshot_digest AS upstreamProfileSnapshotDigest
      FROM codex_thread_bindings ORDER BY created_at;
  `).map((row) => ({ ...row, toolSurfaceJson: parseJson(row.toolSurfaceJson, null) }))
  const ignored = allThreads.filter((row) => !expectedScopes.has(row.scopeId))
  if (ignored.some((row) => row.codexThreadId || row.codexSessionId)) {
    throw new Error('e6_unexpected_started_thread')
  }
  const turns = sqliteJson(databasePath, `
    SELECT thread.ready_conversation_alias AS scopeId, turn.ready_run_id AS readyRunId,
           turn.codex_thread_id AS codexThreadId, turn.codex_turn_id AS codexTurnId,
           turn.ingress_json AS ingressJson,
           turn.authorization_snapshot_json AS authorizationJson,
           turn.engine_terminal_status AS engineTerminalStatus,
           json_extract(turn.engine_terminal_candidate_json, '$.candidateText') AS candidateText,
           (SELECT COUNT(*) FROM chat_messages message
             WHERE message.conversation_id = thread.ready_conversation_alias
               AND message.role = 'assistant'
               AND json_extract(message.meta_json, '$.runId') = turn.ready_run_id) AS canonicalMessageCount,
	           (SELECT message.content FROM chat_messages message
             WHERE message.conversation_id = thread.ready_conversation_alias
               AND message.role = 'assistant'
               AND json_extract(message.meta_json, '$.runId') = turn.ready_run_id
	             LIMIT 1) AS canonicalMessageText,
	           (SELECT COUNT(*) FROM chat_messages message
	             WHERE message.conversation_id = thread.ready_conversation_alias
	               AND message.role = 'assistant') AS assistantScopeMessageCount,
	           (SELECT COUNT(*) FROM chat_messages message
	             WHERE message.conversation_id = thread.ready_conversation_alias
	               AND message.role = 'user') AS userScopeMessageCount,
	           (SELECT message.content FROM chat_messages message
	             WHERE message.conversation_id = thread.ready_conversation_alias
	               AND message.role = 'user'
	             LIMIT 1) AS userMessageText,
           turn.product_terminal_digest AS productTerminalDigest,
           turn.publication_receipt_refs_json AS publicationReceiptRefsJson,
           turn.publication_receipt_digest AS publicationReceiptDigest,
           turn.fence_release_revision AS fenceReleaseRevision,
           (SELECT COUNT(*) FROM ready_model_gateway_request_receipts receipt
             WHERE receipt.ready_run_id = turn.ready_run_id
               AND receipt.request_kind = 'product') AS gatewayRequestCount,
           turn.created_at AS createdAt
      FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
     ORDER BY turn.created_at;
  `).filter((row) => expectedScopes.has(row.scopeId)).map((row) => ({
    ...row,
    ingress: parseJson(row.ingressJson, null),
    authorization: parseJson(row.authorizationJson, null),
    publicationReceiptRefs: parseJson(row.publicationReceiptRefsJson, []),
  }))
  const calls = sqliteJson(databasePath, `
    SELECT thread.ready_conversation_alias AS scopeId, admission.ready_run_id AS readyRunId,
           admission.codex_thread_id AS codexThreadId,
           admission.codex_turn_id AS codexTurnId,
           admission.codex_call_id AS codexCallId, admission.tool_name AS toolName,
           admission.args_digest AS admissionArgsDigest,
           admission.gateway_request_receipt_id AS gatewayRequestReceiptId,
           binding.args_digest AS bindingArgsDigest,
           binding.ready_action_id AS readyActionId,
           binding.receipt_id AS bindingReceiptId,
           binding.result_digest AS bindingResultDigest,
           action.action_identity_digest AS actionIdentityDigest,
           action.state AS actionState, action.receipt_id AS actionReceiptId,
           action.result_digest AS actionResultDigest, action.result_json AS actionResultJson,
           admission.admitted_at AS admittedAt
      FROM codex_tool_call_admissions admission
      JOIN codex_thread_bindings thread ON thread.codex_thread_id = admission.codex_thread_id
      LEFT JOIN codex_tool_call_bindings binding
        ON binding.ready_run_id = admission.ready_run_id
       AND binding.codex_thread_id = admission.codex_thread_id
       AND binding.codex_turn_id = admission.codex_turn_id
       AND binding.codex_call_id = admission.codex_call_id
      LEFT JOIN ready_tool_action_receipts action
        ON action.ready_action_id = binding.ready_action_id
     ORDER BY admission.admitted_at, admission.codex_call_id;
  `).filter((row) => expectedScopes.has(row.scopeId)).map((row) => ({
    ...row,
    actionResult: parseJson(row.actionResultJson, null),
  }))
  const groups = sqliteJson(databasePath, `
    SELECT thread.ready_conversation_alias AS scopeId, group_row.ready_run_id AS readyRunId,
           group_row.codex_thread_id AS codexThreadId,
           group_row.codex_turn_id AS codexTurnId,
           group_row.gateway_request_receipt_id AS gatewayRequestReceiptId,
           group_row.tool_call_count AS toolCallCount,
           group_row.parallel_group_charged AS parallelGroupCharged
      FROM codex_tool_group_admissions group_row
      JOIN codex_thread_bindings thread ON thread.codex_thread_id = group_row.codex_thread_id
     ORDER BY group_row.admitted_at;
  `).filter((row) => expectedScopes.has(row.scopeId))
  const gatewayRequests = sqliteJson(databasePath, `
    SELECT thread.ready_conversation_alias AS scopeId,
           receipt.receipt_id AS gatewayRequestReceiptId,
           receipt.ready_run_id AS readyRunId,
           receipt.request_kind AS requestKind,
           receipt.codex_thread_id AS codexThreadId,
           receipt.codex_turn_id AS codexTurnId,
           receipt.upstream_profile_snapshot_digest AS upstreamProfileSnapshotDigest,
           receipt.request_digest AS requestDigest,
           request_event.input_digest AS inputDigest,
           request_event.tools_digest AS toolsDigest,
           request_event.event_sequence AS requestSequence,
           request_event.evidence_digest AS requestEvidenceDigest,
           response_event.event_sequence AS responseSequence,
           response_event.evidence_digest AS responseEvidenceDigest,
           response_event.response_id AS responseId,
           response_event.terminal_digest AS responseTerminalDigest,
           response_event.output_digest AS responseOutputDigest,
           response_event.usage_digest AS responseUsageDigest
      FROM ready_model_gateway_request_receipts receipt
      JOIN codex_turn_bindings turn ON turn.ready_run_id = receipt.ready_run_id
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
      JOIN ready_model_gateway_exchange_events request_event
        ON request_event.gateway_request_receipt_id = receipt.receipt_id
       AND request_event.event_kind = 'request_admitted'
      LEFT JOIN ready_model_gateway_exchange_events response_event
        ON response_event.gateway_request_receipt_id = receipt.receipt_id
       AND response_event.event_kind = 'response_completed'
     WHERE receipt.request_kind = 'product'
     ORDER BY request_event.event_sequence;
  `).filter((row) => expectedScopes.has(row.scopeId))
  const providerSnapshots = sqliteJson(databasePath, `
    SELECT snapshot_ref AS snapshotRef, snapshot_digest AS snapshotDigest,
           profile_id AS profileId, snapshot_json AS snapshotJson,
           credential_reference_id AS credentialReferenceId
      FROM ready_model_gateway_profile_snapshots ORDER BY created_at;
  `).map((row) => ({ ...row, snapshot: parseJson(row.snapshotJson, null) }))
  const sidecarLeases = sqliteJson(databasePath, `
    SELECT process_lease_id AS processLeaseId, pid,
           process_group_id AS processGroupId,
           process_start_identity AS processStartIdentity,
           runtime_manifest_digest AS runtimeManifestDigest,
           binary_sha256 AS binarySha256,
           executable_path AS executablePath,
           owner_main_pid AS ownerMainPid,
           owner_main_process_start_identity AS ownerMainProcessStartIdentity,
           closed_at AS closedAt, tree_zero_at AS treeZeroAt,
           tree_zero_evidence_digest AS treeZeroEvidenceDigest
      FROM codex_sidecar_process_leases ORDER BY spawn_intent_at;
  `)
  return {
    threads: allThreads.filter((row) => expectedScopes.has(row.scopeId)),
    turns,
    calls,
    groups,
    gatewayRequests,
    providerSnapshots,
    sidecarLeases,
    ignoredUnstartedThreadCount: ignored.length,
  }
}

function assertString(value, code) {
  if (typeof value !== 'string' || !value) throw new Error(code)
}

function assertExactList(actual, expected, code) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(code)
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isExactFileIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([
      'device', 'inode', 'mode', 'mtimeMs', 'size',
    ])
    && typeof value.device === 'string' && Boolean(value.device)
    && typeof value.inode === 'string' && Boolean(value.inode)
    && Number.isSafeInteger(value.mode) && value.mode >= 0
    && Number.isFinite(value.mtimeMs) && value.mtimeMs >= 0
    && Number.isSafeInteger(value.size) && value.size >= 0
}

function sentinelOccurrences(capture, expectedAnswer) {
  const expectedDigest = sha256Canonical(expectedAnswer)
  const item = Array.isArray(capture.proofSentinels)
    ? capture.proofSentinels.find((candidate) => candidate.digest === expectedDigest)
    : null
  return Number(item?.occurrences || 0)
}

function assertProviderEvidence(evidence, expectation) {
  if (!expectation || evidence.providerSnapshots.length !== 1) {
    throw new Error('e6_provider_identity_mismatch')
  }
  const row = evidence.providerSnapshots[0]
  const snapshot = row.snapshot
  const credentialReferenceId = `ai-profile:${expectation.profileId}`
  const extraHeaders = snapshot?.extraHeaders
  if (!snapshot || !row.snapshotRef || !row.snapshotDigest
    || canonicalJson(Object.keys(snapshot).sort()) !== canonicalJson(PROVIDER_SNAPSHOT_KEYS)
    || canonicalJson(Object.keys(snapshot.retryPolicy || {}).sort())
      !== canonicalJson(RETRY_POLICY_KEYS)
    || row.profileId !== expectation.profileId
    || row.credentialReferenceId !== credentialReferenceId
    || sha256Canonical(snapshot) !== row.snapshotDigest
    || snapshot.profileId !== expectation.profileId
    || snapshot.providerId !== expectation.providerId
    || snapshot.model !== expectation.model
    || String(snapshot.baseUrl || '').replace(/\/+$/, '') !== expectation.baseUrl
    || snapshot.agentProtocol !== 'openai'
    || !['chat/completions', 'responses'].includes(snapshot.wireApi)
    || ![null, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      .includes(snapshot.reasoningEffort)
    || ['supportsToolCalls', 'supportsNativeToolCalls', 'supportsVision', 'supportsThinking']
      .some((key) => typeof snapshot[key] !== 'boolean')
    || !['proven_safe', 'echo_required', 'unsupported', 'unknown']
      .includes(snapshot.multiTurnThinkingPolicy)
    || (snapshot.patchProfileId !== null
      && (typeof snapshot.patchProfileId !== 'string' || !snapshot.patchProfileId))
    || typeof snapshot.authHeader !== 'string'
    || typeof snapshot.authPrefix !== 'string'
    || snapshot.authHeader !== expectation.authHeader
    || snapshot.authPrefix !== expectation.authPrefix
    || /(?:mock|test|fixture)/i.test(canonicalJson(snapshot))
    || !extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)
    || Object.keys(extraHeaders).length !== 0
    || snapshot.credentialReferenceId !== credentialReferenceId
    || snapshot.retryPolicy?.owner !== 'ready_gateway'
    || snapshot.retryPolicy?.maxRetries !== 6
    || snapshot.retryPolicy?.semantic4xxRetries !== 0
    || evidence.threads.some((thread) => thread.upstreamProfileSnapshotRef !== row.snapshotRef
      || thread.upstreamProfileSnapshotDigest !== row.snapshotDigest)
    || evidence.gatewayRequests.some(
      (request) => request.upstreamProfileSnapshotDigest !== row.snapshotDigest,
    )) {
    throw new Error('e6_provider_identity_mismatch')
  }
  return {
    providerId: snapshot.providerId,
    modelDigest: sha256Canonical(snapshot.model),
    endpointClass: expectation.endpointClass,
    endpointOriginDigest: expectation.endpointOriginDigest,
    snapshotDigest: row.snapshotDigest,
  }
}

function assertCommonRun(
  result,
  thread,
  turn,
  calls,
  groups,
  gatewayRequests,
  captures,
  expected,
  proofAnswers,
  proofNeedles,
) {
  if (!thread?.codexThreadId || thread.codexThreadId !== thread.codexSessionId
    || turn?.codexThreadId !== thread.codexThreadId || !turn.codexTurnId) {
    throw new Error('e6_native_identity_mismatch')
  }
  if (turn.engineTerminalStatus !== 'completed'
    || turn.candidateText !== expected.expectedAnswer
	    || turn.canonicalMessageCount !== 1
	    || turn.canonicalMessageText !== expected.expectedAnswer
	    || turn.assistantScopeMessageCount !== 1
	    || turn.userScopeMessageCount !== 1
    || typeof turn.userMessageText !== 'string'
    || turn.userMessageText.includes(expected.expectedAnswer)
    || !turn.productTerminalDigest || !turn.publicationReceiptDigest
    || !turn.fenceReleaseRevision) {
    throw new Error('e6_terminal_closeout_mismatch')
  }
  const prepared = turn.ingress?.prepared
  const ingress = prepared?.ingress
  const references = ingress?.resourceAdditionalContext
  if (ingress?.currentDocumentAnchor || !Array.isArray(references) || references.length !== 1) {
    throw new Error('e6_resource_reference_missing')
  }
  const reference = references[0]
  assertExactList(Object.keys(reference).sort(), THIN_REFERENCE_KEYS, 'e6_resource_reference_not_thin')
  if (reference.logicalResourceId !== expected.logicalResourceId
    || reference.currentVersion !== expected.currentVersion
    || reference.currentDigest !== expected.currentDigest
    || reference.policyEpoch !== expected.policyEpoch
    || reference.supersedesVersion !== null
    || JSON.stringify(references).includes(expected.expectedAnswer)) {
    throw new Error('e6_resource_reference_identity_mismatch')
  }
  const slice = prepared.externalReadSlice
  if (!slice || slice.kind !== expected.kind
    || slice.logicalResourceId !== expected.logicalResourceId
    || slice.currentVersion !== expected.currentVersion
    || slice.currentDigest !== expected.currentDigest
    || slice.policyEpoch !== expected.policyEpoch) {
    throw new Error('e6_external_read_slice_mismatch')
  }
  assertExactList(turn.authorization?.allowedToolNames, expected.allowedToolNames, 'e6_authorization_mismatch')
  assertExactList(slice.allowedToolNames, expected.allowedToolNames, 'e6_slice_tool_policy_mismatch')
  assertString(slice.methodConstraintDigest, 'e6_method_digest_missing')
  assertString(slice.dependencySnapshotDigest, 'e6_dependency_digest_missing')
  if (calls.length !== expected.callNames.length
    || groups.length !== calls.length
    || groups.some((group) => group.toolCallCount !== 1 || group.parallelGroupCharged !== 0)
    || Number(turn.gatewayRequestCount) !== calls.length + 1) {
    throw new Error('e6_call_or_request_count_mismatch')
  }
  assertExactList(calls.map((call) => call.toolName), expected.callNames, 'e6_tool_sequence_mismatch')
  const gatewayReceiptIds = new Set(gatewayRequests.map((request) => request.gatewayRequestReceiptId))
  const callGatewayReceiptIds = calls.map((call) => call.gatewayRequestReceiptId)
  if (calls.some((call) => call.readyRunId !== turn.readyRunId
    || call.codexThreadId !== thread.codexThreadId
    || call.codexTurnId !== turn.codexTurnId
    || !gatewayReceiptIds.has(call.gatewayRequestReceiptId))
    || groups.some((group) => group.readyRunId !== turn.readyRunId
      || group.codexThreadId !== thread.codexThreadId
      || group.codexTurnId !== turn.codexTurnId
      || !gatewayReceiptIds.has(group.gatewayRequestReceiptId))
    || new Set(callGatewayReceiptIds).size !== calls.length) {
    throw new Error('e6_tool_receipt_ownership_mismatch')
  }
  assertExactList(
    groups.map((group) => group.gatewayRequestReceiptId).sort(),
    [...callGatewayReceiptIds].sort(),
    'e6_tool_receipt_ownership_mismatch',
  )
  for (const call of calls) {
    if (call.actionState !== 'confirmed'
      || !call.readyActionId || !call.actionIdentityDigest
      || call.readyActionId !== `codex-action-${call.actionIdentityDigest}`
      || !call.bindingReceiptId || call.bindingReceiptId !== call.actionReceiptId
      || !call.bindingResultDigest || call.bindingResultDigest !== call.actionResultDigest
      || sha256Canonical(call.actionResult) !== call.bindingResultDigest
      || !call.admissionArgsDigest || call.admissionArgsDigest !== call.bindingArgsDigest
      || !call.gatewayRequestReceiptId || !call.actionResult) {
      throw new Error('e6_tool_receipt_mismatch')
    }
  }
  const expectedReceipts = calls.map((call) => call.bindingReceiptId).sort()
  assertExactList([...turn.publicationReceiptRefs].sort(), expectedReceipts, 'e6_publication_receipt_mismatch')
  const proofSentinelDigests = proofNeedles.map((needle) => sha256Canonical(needle))
  if (captures.length !== calls.length + 1 || gatewayRequests.length !== captures.length
    || captures.some((capture) => capture.requestKind !== 'product'
      || capture.readyRunId !== turn.readyRunId
      || capture.readyResourceReferenceCount !== 1
      || capture.toolsDigest !== thread.toolSurfaceDigest
      || capture.toolCount !== capture.toolNames.length
      || new Set(capture.toolNames).size !== capture.toolNames.length
      || !Array.isArray(capture.proofSentinels)
      || canonicalJson(capture.proofSentinels.map((item) => item.digest))
        !== canonicalJson(proofSentinelDigests))
    || captures.slice(0, -1).some(
      (capture) => sentinelOccurrences(capture, expected.expectedAnswer) !== 0,
    )
    || sentinelOccurrences(captures.at(-1), expected.expectedAnswer) < 1
    || proofAnswers.filter((answer) => answer !== expected.expectedAnswer).some(
      (answer) => captures.some((capture) => sentinelOccurrences(capture, answer) !== 0),
    )) {
    throw new Error('e6_gateway_capture_mismatch')
  }
  if (gatewayRequests.some((request) => !request.gatewayRequestReceiptId
    || !request.readyRunId || !request.requestDigest || !request.inputDigest || !request.toolsDigest)
    || gatewayRequests.some((request) => !request.requestEvidenceDigest
      || !request.responseEvidenceDigest || !request.responseId
      || !request.responseTerminalDigest || !request.responseOutputDigest
      || !request.responseUsageDigest
      || !Number.isSafeInteger(request.requestSequence)
      || !Number.isSafeInteger(request.responseSequence)
      || request.requestSequence >= request.responseSequence)
    || gatewayRequests.slice(0, -1).some((request, index) => (
      request.responseSequence >= gatewayRequests[index + 1].requestSequence
    ))
    || new Set(gatewayRequests.map((request) => request.gatewayRequestReceiptId)).size
      !== gatewayRequests.length) {
    throw new Error('e6_gateway_receipt_capture_mismatch')
  }
  assertExactList(captures.map((capture) => ({
    readyRunId: capture.readyRunId,
    requestKind: capture.requestKind,
    codexThreadId: capture.threadId,
    codexTurnId: capture.turnId,
    requestDigest: capture.requestDigest,
    inputDigest: capture.inputDigest,
    toolsDigest: capture.toolsDigest,
  })), gatewayRequests.map((request) => ({
    readyRunId: request.readyRunId,
    requestKind: request.requestKind,
    codexThreadId: request.codexThreadId,
    codexTurnId: request.codexTurnId,
    requestDigest: request.requestDigest,
    inputDigest: request.inputDigest,
    toolsDigest: request.toolsDigest,
  })), 'e6_gateway_receipt_capture_mismatch')
  assertExactList([...captures[0].toolNames].sort(), [...thread.toolSurfaceJson.toolNames].sort(), 'e6_tool_surface_mismatch')
  return slice
}

function assertFeishuRun(
  result,
  thread,
  turn,
  calls,
  groups,
  gatewayRequests,
  captures,
  expected,
  proofAnswers,
  proofNeedles,
) {
  const slice = assertCommonRun(
    result, thread, turn, calls, groups, gatewayRequests, captures, expected, proofAnswers,
    proofNeedles,
  )
  const authority = slice.authority
  if (canonicalJson(Object.keys(slice).sort()) !== canonicalJson([
    'allowedToolNames', 'authority', 'currentDigest', 'currentVersion',
    'dependencySnapshotDigest', 'kind', 'logicalResourceId', 'methodConstraintDigest',
    'policyEpoch',
  ])
    || canonicalJson(Object.keys(authority || {}).sort()) !== canonicalJson([
      'allowedToolName', 'channelId', 'channelIdentityDigest', 'docToken', 'docType',
      'expectedResultDigest',
    ])
    || authority?.channelId !== expected.channelId
    || slice.authority?.docToken !== expected.documentToken
    || slice.authority?.docType !== expected.documentType
    || slice.authority?.allowedToolName !== 'feishu_doc_read'
    || slice.authority?.expectedResultDigest !== expected.currentDigest
    || !isDigest(slice.authority?.channelIdentityDigest)
    || slice.methodConstraintDigest !== sha256Canonical({
      kind: slice.kind,
      allowedToolNames: slice.allowedToolNames,
      authority: {
        channelId: authority.channelId,
        docToken: authority.docToken,
        docType: authority.docType,
        allowedToolName: authority.allowedToolName,
      },
    })
    || slice.dependencySnapshotDigest !== sha256Canonical({
      provider: 'ready_connector:feishu',
      channelIdentityDigest: authority.channelIdentityDigest,
    })) {
    throw new Error('e6_feishu_authority_mismatch')
  }
  const output = calls[0].actionResult
  const answerLines = typeof output?.data?.data?.content === 'string'
    ? output.data.data.content.split(/\r?\n/).filter((line) => line.startsWith('ANSWER='))
    : []
  if (output?.data?.ok !== true || output?.data?.success !== true
    || !output.data.data || typeof output.data.data !== 'object'
    || typeof output.data.data.content !== 'string'
    || answerLines.length !== 1 || answerLines[0] !== `ANSWER=${expected.expectedAnswer}`
    || Object.prototype.hasOwnProperty.call(output.data, 'content')
    || output.data.errorKind !== undefined
    || sha256Canonical({ success: output.data.success, data: output.data.data })
      !== expected.currentDigest) {
    throw new Error('e6_feishu_result_mismatch')
  }
  return slice
}

function assertLarkRun(
  result,
  thread,
  turn,
  calls,
  groups,
  gatewayRequests,
  captures,
  expected,
  proofAnswers,
  proofNeedles,
) {
  const slice = assertCommonRun(
    result, thread, turn, calls, groups, gatewayRequests, captures, expected, proofAnswers,
    proofNeedles,
  )
  const expectedArgv = [
    'docs', '+fetch', '--doc', expected.documentRef,
    '--as', 'user', '--doc-format', 'markdown', '--detail', 'simple',
    '--revision-id', '-1', '--scope', 'full', '--format', 'json',
  ]
  if (!turn.userMessageText.includes(expected.documentRef)
    || sentinelOccurrences(captures[0], expected.documentRef) < 1) {
    throw new Error('e6_lark_target_visibility_mismatch')
  }
  if (canonicalJson(Object.keys(slice).sort()) !== canonicalJson([
    'allowedToolNames', 'authReadback', 'currentDigest', 'currentVersion',
    'dependencySnapshotDigest', 'docRef', 'kind', 'logicalResourceId',
    'methodConstraintDigest', 'policyEpoch', 'requiredMethod', 'requiredResources',
    'siblingReadRoots', 'skillId', 'skillRoot',
  ])
    || slice.docRef !== expected.documentRef
    || slice.skillId !== 'lark-doc'
    || slice.requiredMethod?.methodId !== 'lark-doc-fetch'
    || slice.requiredMethod?.commandName !== 'lark-cli'
    || slice.requiredMethod?.expectedStdoutSha256 !== expected.currentDigest
    || canonicalJson(slice.requiredMethod?.allowedArgv) !== canonicalJson([expectedArgv])
    || slice.authReadback?.identity !== 'user'
    || slice.authReadback?.verified !== true
    || slice.authReadback?.tokenStatus !== 'valid') {
    throw new Error('e6_lark_method_mismatch')
  }
  const executable = slice.requiredMethod?.executableAuthority
  const executableKeys = [
    'authorityDigest', 'autoInstallForbidden', 'fileIdentity', 'launchPath',
    'launchPrefixArgs', 'launcherChain', 'outerPath', 'payloadPath', 'payloadSha256',
    'program', 'realPath', 'spawnPath', 'version', 'wrapperExecutionForbidden',
  ]
  const launcher = executable?.launcherChain?.[0]
  const unsignedExecutable = executable ? {
    program: executable.program,
    outerPath: executable.outerPath,
    realPath: executable.realPath,
    payloadPath: executable.payloadPath,
    payloadSha256: executable.payloadSha256,
    fileIdentity: executable.fileIdentity,
    launcherChain: executable.launcherChain,
    launchPath: executable.launchPath,
    spawnPath: executable.spawnPath,
    launchPrefixArgs: executable.launchPrefixArgs,
    version: executable.version,
    wrapperExecutionForbidden: executable.wrapperExecutionForbidden,
    autoInstallForbidden: executable.autoInstallForbidden,
  } : null
  if (!executable
    || canonicalJson(Object.keys(executable).sort()) !== canonicalJson(executableKeys.sort())
    || executable.payloadPath !== expected.larkProvenance.payloadPath
    || executable.program !== expected.larkProvenance.payloadPath
    || executable.outerPath !== expected.larkProvenance.payloadPath
    || executable.realPath !== expected.larkProvenance.payloadPath
    || executable.spawnPath !== expected.larkProvenance.payloadPath
    || executable.launchPath !== expected.larkProvenance.payloadPath
    || executable.launchPrefixArgs?.length !== 0
    || executable.payloadSha256 !== expected.larkProvenance.payloadSha256
    || executable.version !== expected.larkProvenance.version
    || !isExactFileIdentity(executable.fileIdentity)
    || executable.wrapperExecutionForbidden !== true
    || executable.autoInstallForbidden !== true
    || executable.launcherChain?.length !== 1
    || canonicalJson(Object.keys(launcher || {}).sort()) !== canonicalJson([
      'fileIdentity', 'kind', 'path', 'realPath', 'sha256',
    ])
    || launcher?.kind !== 'payload'
    || launcher?.path !== expected.larkProvenance.payloadPath
    || launcher?.realPath !== expected.larkProvenance.payloadPath
    || executable.launcherChain[0]?.sha256 !== expected.larkProvenance.payloadSha256) {
    throw new Error('e6_lark_provenance_mismatch')
  }
  if (!isExactFileIdentity(launcher.fileIdentity)
    || canonicalJson(launcher.fileIdentity) !== canonicalJson(executable.fileIdentity)
    || executable.authorityDigest !== sha256Canonical(unsignedExecutable)) {
    throw new Error('e6_lark_provenance_mismatch')
  }
  const auth = slice.authReadback
  const unsignedAuth = auth ? {
    identity: auth.identity,
    verified: auth.verified,
    userStatus: auth.userStatus,
    userAvailable: auth.userAvailable,
    userVerified: auth.userVerified,
    tokenStatus: auth.tokenStatus,
    principalDigest: auth.principalDigest,
    scopeDigest: auth.scopeDigest,
    executableReadbackDigest: auth.executableReadbackDigest,
  } : null
  if (canonicalJson(Object.keys(auth || {}).sort()) !== canonicalJson([
    'authReadbackDigest', 'executableReadbackDigest', 'identity', 'principalDigest',
    'scopeDigest', 'tokenStatus', 'userAvailable', 'userStatus', 'userVerified', 'verified',
  ])
    || auth.identity !== 'user' || auth.verified !== true
    || auth.userStatus !== 'ready' || auth.userAvailable !== true || auth.userVerified !== true
    || auth.tokenStatus !== 'valid' || !isDigest(auth.principalDigest) || !isDigest(auth.scopeDigest)
    || auth.executableReadbackDigest !== executable.authorityDigest
    || auth.authReadbackDigest !== sha256Canonical(unsignedAuth)) {
    throw new Error('e6_lark_auth_mismatch')
  }
  assertExactList(
    slice.requiredResources.map((resource) => resource.logicalPath),
    LARK_RESOURCE_PATHS,
    'e6_lark_resource_contract_mismatch',
  )
  const resourcePolicies = [
    ['selected_skill', 'SKILL.md'],
    ['sibling_skill', 'SKILL.md'],
    ['selected_skill', 'references/lark-doc-fetch.md'],
  ]
  if (slice.requiredResources.some((resource, index) => (
    canonicalJson(Object.keys(resource).sort()) !== canonicalJson([
      'fileIdentity', 'logicalPath', 'relativePath', 'rootKind', 'sha256',
    ])
    || resource.rootKind !== resourcePolicies[index][0]
    || resource.relativePath !== resourcePolicies[index][1]
    || !isDigest(resource.sha256)
    || !isExactFileIdentity(resource.fileIdentity)
  ))) throw new Error('e6_lark_resource_contract_mismatch')
  if (typeof slice.skillRoot !== 'string' || !slice.skillRoot
    || slice.siblingReadRoots?.length !== 1 || !slice.siblingReadRoots[0]
    || slice.methodConstraintDigest !== sha256Canonical({
      kind: slice.kind,
      allowedToolNames: slice.allowedToolNames,
      skillId: slice.skillId,
      requiredResources: slice.requiredResources.map((resource) => ({
        logicalPath: resource.logicalPath,
        rootKind: resource.rootKind,
        relativePath: resource.relativePath,
      })),
      methodId: slice.requiredMethod.methodId,
      commandName: slice.requiredMethod.commandName,
      allowedArgv: slice.requiredMethod.allowedArgv,
    })
    || slice.dependencySnapshotDigest !== sha256Canonical({
      skillRoot: slice.skillRoot,
      siblingReadRoots: slice.siblingReadRoots,
      requiredResourceIdentities: slice.requiredResources.map((resource) => ({
        logicalPath: resource.logicalPath,
        sha256: resource.sha256,
        fileIdentity: resource.fileIdentity,
      })),
      executableAuthority: executable,
      authReadback: auth,
    })) throw new Error('e6_lark_slice_digest_mismatch')
  const readCalls = calls.slice(0, 3)
  assertExactList(
    readCalls.map((call) => call.actionResult?.data?.resourcePath),
    LARK_RESOURCE_PATHS,
    'e6_lark_resource_reads_mismatch',
  )
  if (readCalls.some((call) => typeof call.actionResult?.text !== 'string'
    || !call.actionResult.text
    || createHash('sha256').update(call.actionResult.text).digest('hex')
      !== slice.requiredResources[readCalls.indexOf(call)].sha256
    || Object.prototype.hasOwnProperty.call(call.actionResult?.data || {}, 'absolutePath'))) {
    throw new Error('e6_lark_resource_result_mismatch')
  }
  const output = calls[3].actionResult
  let parsedStdout = null
  try { parsedStdout = JSON.parse(output?.data?.stdout) } catch {
    throw new Error('e6_lark_result_mismatch')
  }
  const documentContent = parsedStdout?.data?.document?.content
  const answerLines = typeof documentContent === 'string'
    ? documentContent.split(/\r?\n/).filter((line) => line.startsWith('ANSWER='))
    : []
  if (output?.data?.ok !== true || output?.data?.exitCode !== 0
    || typeof output.data.stdout !== 'string'
    || parsedStdout?.data?.document?.document_id !== expected.documentRef
    || answerLines.length !== 1 || answerLines[0] !== `ANSWER=${expected.expectedAnswer}`
    || output.data.stdoutTruncated !== false
    || output.data.stdoutArtifactPath !== null
    || output.data.requiredMethod?.methodId !== 'lark-doc-fetch'
    || output.data.requiredMethod?.commandName !== 'lark-cli'
    || output.data.requiredMethod?.authorityDigest
      !== slice.requiredMethod.executableAuthority.authorityDigest
    || createHash('sha256').update(output.data.stdout).digest('hex') !== expected.currentDigest) {
    throw new Error('e6_lark_result_mismatch')
  }
  return slice
}

function assertE6LiveProofEvidence(input) {
  const {
    results,
    evidence,
    gatewayCapture,
    expectedRuns,
    providerExpectation,
    runtimeExpectation,
    mainProcessExpectation,
  } = input
  if (!Array.isArray(results) || results.length !== 6
    || !Array.isArray(gatewayCapture)
    || !Array.isArray(expectedRuns) || expectedRuns.length !== 6
    || !Array.isArray(evidence.gatewayRequests)
    || !Array.isArray(evidence.providerSnapshots)
    || new Set(results.map((result) => result.scopeId)).size !== 6
    || evidence.threads.length !== 6 || evidence.turns.length !== 6) {
    throw new Error('e6_run_cardinality_mismatch')
  }
  const expectedOrder = [
    ['feishu_typed_read', 1],
    ['feishu_typed_read', 2],
    ['feishu_typed_read', 3],
    ['lark_cli_read', 1],
    ['lark_cli_read', 2],
    ['lark_cli_read', 3],
  ]
  assertExactList(
    expectedRuns.map((run) => [run.kind, run.index]),
    expectedOrder,
    'e6_run_order_mismatch',
  )
  const expectedScopeOrder = expectedRuns.map((run) => run.scopeId)
  assertExactList(results.map((result) => result.scopeId), expectedScopeOrder, 'e6_run_order_mismatch')
  assertExactList(evidence.threads.map((thread) => thread.scopeId), expectedScopeOrder, 'e6_run_order_mismatch')
  assertExactList(evidence.turns.map((turn) => turn.scopeId), expectedScopeOrder, 'e6_run_order_mismatch')
  if (new Set(expectedScopeOrder).size !== 6
    || new Set(evidence.threads.map((thread) => thread.codexThreadId)).size !== 6
    || new Set(evidence.threads.map((thread) => thread.codexSessionId)).size !== 6
    || new Set(evidence.turns.map((turn) => turn.codexTurnId)).size !== 6
    || new Set(evidence.turns.map((turn) => turn.readyRunId)).size !== 6) {
    throw new Error('e6_run_identity_not_unique')
  }
  if (evidence.gatewayRequests.slice(0, -1).some((request, index) => (
    request.responseSequence >= evidence.gatewayRequests[index + 1].requestSequence
  ))) throw new Error('e6_gateway_receipt_capture_mismatch')
  if (evidence.sidecarLeases.length < 1
    || evidence.sidecarLeases.some((lease) => !lease.closedAt || !lease.treeZeroAt
      || !lease.treeZeroEvidenceDigest
      || !Number.isSafeInteger(lease.pid) || lease.pid <= 1
      || lease.processGroupId !== lease.pid
      || typeof lease.processStartIdentity !== 'string' || !lease.processStartIdentity
      || lease.runtimeManifestDigest !== runtimeExpectation?.sidecarRuntime?.runtimeManifestDigest
      || lease.binarySha256 !== runtimeExpectation?.sidecarRuntime?.binarySha256
      || lease.executablePath !== runtimeExpectation?.sidecarRuntime?.executablePath
      || !Number.isSafeInteger(lease.ownerMainPid) || lease.ownerMainPid <= 1
      || typeof lease.ownerMainProcessStartIdentity !== 'string'
      || !lease.ownerMainProcessStartIdentity
      || !mainProcessExpectation
      || lease.ownerMainPid !== mainProcessExpectation.pid
      || lease.ownerMainProcessStartIdentity
        !== mainProcessExpectation.processStartIdentity)) {
    throw new Error('e6_sidecar_lease_not_closed')
  }
  if (!runtimeExpectation?.runtimeManifestDigest || !runtimeExpectation?.protocolSchemaDigest
    || evidence.threads.some((thread) => thread.runtimeManifestDigest
      !== runtimeExpectation.runtimeManifestDigest
      || thread.protocolSchemaDigest !== runtimeExpectation.protocolSchemaDigest)) {
    throw new Error('e6_runtime_identity_mismatch')
  }
  const providerIdentity = assertProviderEvidence(evidence, providerExpectation)
  const feishuAnswers = new Set(expectedRuns
    .filter((run) => run.kind === 'feishu_typed_read').map((run) => run.expectedAnswer))
  const larkAnswers = new Set(expectedRuns
    .filter((run) => run.kind === 'lark_cli_read').map((run) => run.expectedAnswer))
  if (feishuAnswers.size !== 1 || larkAnswers.size !== 1
    || [...feishuAnswers][0] === [...larkAnswers][0]) {
    throw new Error('e6_proof_sentinel_identity_mismatch')
  }
  const proofAnswers = [[...feishuAnswers][0], [...larkAnswers][0]]
  const larkDocumentRefs = new Set(expectedRuns
    .filter((run) => run.kind === 'lark_cli_read').map((run) => run.documentRef))
  if (larkDocumentRefs.size !== 1 || ![...larkDocumentRefs][0]) {
    throw new Error('e6_lark_target_identity_mismatch')
  }
  const proofNeedles = [...proofAnswers, [...larkDocumentRefs][0]]
  const expectedCaptureIdentities = new Set()
  for (const result of results) {
    const thread = evidence.threads.find((candidate) => candidate.scopeId === result.scopeId)
    const turn = evidence.turns.find((candidate) => candidate.scopeId === result.scopeId)
    if (!thread?.codexThreadId || !turn?.codexTurnId) throw new Error('e6_run_evidence_missing')
    expectedCaptureIdentities.add(canonicalJson([thread.codexThreadId, turn.codexTurnId]))
  }
  if (expectedCaptureIdentities.size !== 6
    || gatewayCapture.some((capture) => !expectedCaptureIdentities.has(
      canonicalJson([capture.threadId, capture.turnId]),
    ))) {
    throw new Error('e6_unexpected_gateway_capture')
  }
  const summaries = []
  for (const result of results) {
    const expected = expectedRuns.find((candidate) => candidate.scopeId === result.scopeId)
    const thread = evidence.threads.find((candidate) => candidate.scopeId === result.scopeId)
    const turn = evidence.turns.find((candidate) => candidate.scopeId === result.scopeId)
    const calls = evidence.calls.filter((candidate) => candidate.scopeId === result.scopeId)
    const groups = evidence.groups.filter((candidate) => candidate.scopeId === result.scopeId)
    const gatewayRequests = evidence.gatewayRequests.filter(
      (candidate) => candidate.scopeId === result.scopeId,
    )
    const captures = gatewayCapture.filter((candidate) => candidate.threadId === thread?.codexThreadId
      && candidate.turnId === turn?.codexTurnId)
    if (!expected || !thread || !turn) throw new Error('e6_run_evidence_missing')
    if (!result?.ok || result.kind !== expected.kind || result.index !== expected.index
      || result.expectedAnswer !== expected.expectedAnswer
      || result.finalText !== expected.expectedAnswer
      || canonicalJson(result.toolCalls) !== canonicalJson(expected.callNames)) {
      throw new Error('e6_renderer_result_mismatch')
    }
    const slice = expected.kind === 'feishu_typed_read'
      ? assertFeishuRun(
          result, thread, turn, calls, groups, gatewayRequests, captures, expected, proofAnswers,
          proofNeedles,
        )
      : assertLarkRun(
          result, thread, turn, calls, groups, gatewayRequests, captures, expected, proofAnswers,
          proofNeedles,
        )
    summaries.push({
      kind: expected.kind,
      scopeIdDigest: sha256Canonical(result.scopeId),
      threadIdDigest: sha256Canonical(thread.codexThreadId),
      turnIdDigest: sha256Canonical(turn.codexTurnId),
      toolSurfaceDigest: thread.toolSurfaceDigest,
      methodConstraintDigest: slice.methodConstraintDigest,
      dependencySnapshotDigest: slice.dependencySnapshotDigest,
      toolCallCount: calls.length,
      providerRequestCount: captures.length,
    })
  }
  for (const kind of ['feishu_typed_read', 'lark_cli_read']) {
    const rows = summaries.filter((summary) => summary.kind === kind)
    if (rows.length !== 3
      || new Set(rows.map((row) => row.toolSurfaceDigest)).size !== 1
      || new Set(rows.map((row) => row.methodConstraintDigest)).size !== 1
      || new Set(rows.map((row) => row.dependencySnapshotDigest)).size !== 1) {
      throw new Error('e6_three_run_stability_mismatch')
    }
  }
  return {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: 'typed-and-cli-3-plus-3',
    runCount: summaries.length,
    toolCallCount: summaries.reduce((total, row) => total + row.toolCallCount, 0),
    providerRequestCount: summaries.reduce((total, row) => total + row.providerRequestCount, 0),
    ignoredUnstartedThreadCount: evidence.ignoredUnstartedThreadCount,
    sidecarLeaseCount: evidence.sidecarLeases.length,
    runtimeManifestDigest: runtimeExpectation.runtimeManifestDigest,
    protocolSchemaDigest: runtimeExpectation.protocolSchemaDigest,
    providerIdentity,
    runs: summaries,
  }
}

module.exports = {
  LARK_RESOURCE_PATHS,
  readE6DatabaseEvidence,
  assertE6LiveProofEvidence,
  sha256Canonical,
}
