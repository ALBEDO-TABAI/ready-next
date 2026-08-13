'use strict'

const { createHash } = require('node:crypto')

const { canonicalJson, digestJson } = require('./contract-lib.cjs')
const {
  EXPECTED_DOCX_TITLE,
  EXPECTED_DOCX_URL,
  EXPECTED_SHEET_URL,
  SHEET_APPEND_POLICY,
  columnNameForNumber,
  mapReadyToolOutputDigests,
  polishSentenceForE6,
  projectSheetStructureRead,
  projectSingleSheetCellRead,
} = require('./e6-user-scenario-authority.cjs')

const SHA256 = /^[a-f0-9]{64}$/
const PROOF_MODE = 'ordinary-agent-lark-cli-two-resource-write-readback'
const ALLOWED_TOOLS = [
  'agent_propose_handoff',
  'declare_completion_criteria',
  'skill_ask_user',
  'skill_read_artifact',
  'skill_run_shell',
]
const SHEET_LEDGER_ROLES = [
  ['skills_shared', 'skills read', false],
  ['auth_before', 'auth status', false],
  ['skills_domain', 'skills read', false],
  ['before_info', 'sheets +workbook-info', false],
  ['before_revision', 'sheets +revision-get', false],
  ['pre_insert_structure', 'sheets +sheet-info', false],
  ['pre_insert_template', 'sheets +cells-get', false],
  ['insert_preview', 'sheets +dim-insert', true],
  ['insert', 'sheets +dim-insert', false],
  ['post_insert_info', 'sheets +workbook-info', false],
  ['post_insert_revision', 'sheets +revision-get', false],
  ['post_insert_template', 'sheets +cells-get', false],
  ['write_preview', 'sheets +cells-set', true],
  ['write', 'sheets +cells-set', false],
  ['after_info', 'sheets +workbook-info', false],
  ['after_revision', 'sheets +revision-get', false],
  ['readback', 'sheets +cells-get', false],
]
const DOCX_LEDGER_ROLES = [
  ['skills_shared', 'skills read', false],
  ['auth_before', 'auth status', false],
  ['skills_domain', 'skills read', false],
  ['pre_read', 'docs +fetch', false],
  ['write_preview', 'docs +update', true],
  ['write', 'docs +update', false],
  ['readback', 'docs +fetch', false],
  ['auth_after', 'auth status', false],
]
const SHEET_REQUIRED_REFERENCES = [
  'references/lark-sheets-sheet-structure.md',
  'references/lark-sheets-write-cells.md',
]
const DOCX_REQUIRED_REFERENCES = [
  'references/lark-doc-fetch.md',
  'references/lark-doc-xml.md',
  'references/style/lark-doc-style.md',
  'references/lark-doc-update.md',
  'references/style/lark-doc-update-workflow.md',
]
const PROVIDER_SNAPSHOT_KEYS = [
  'agentProtocol', 'authHeader', 'authPrefix', 'baseUrl', 'credentialReferenceId',
  'extraHeaders', 'model', 'multiTurnThinkingPolicy', 'patchProfileId', 'profileId',
  'providerId', 'reasoningEffort', 'retryPolicy', 'supportsNativeToolCalls',
  'supportsThinking', 'supportsToolCalls', 'supportsVision', 'wireApi',
]
const RETRY_POLICY_KEYS = ['maxRetries', 'owner', 'semantic4xxRetries']
const CODEX_SCHEMA_KEYS = new Set([
  '$ref', 'type', 'description', 'encrypted', 'enum', 'items', 'properties', 'required',
  'additionalProperties', 'anyOf', 'oneOf', 'allOf', '$defs', 'definitions',
])
const CODEX_SCHEMA_TYPES = new Set([
  'string', 'number', 'boolean', 'integer', 'object', 'array', 'null',
])

function fail(code) {
  throw new Error(code)
}

function assert(condition, code) {
  if (!condition) fail(code)
}

function parseJson(value, code) {
  try { return JSON.parse(value) } catch { fail(code) }
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort())
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSchemaType(value) {
  if (typeof value === 'string') return CODEX_SCHEMA_TYPES.has(value) ? value : undefined
  if (!Array.isArray(value)) return undefined
  const types = value.filter((item) => typeof item === 'string' && CODEX_SCHEMA_TYPES.has(item))
  return types.length > 0 ? [...new Set(types)] : undefined
}

function inferredSchemaType(value) {
  const explicit = normalizeSchemaType(value.type)
  if (explicit) return explicit
  if ('$ref' in value || 'anyOf' in value || 'oneOf' in value || 'allOf' in value) return undefined
  if ('properties' in value || 'required' in value || 'additionalProperties' in value) return 'object'
  if ('items' in value || 'prefixItems' in value) return 'array'
  if ('enum' in value || 'format' in value) return 'string'
  if ('minimum' in value || 'maximum' in value || 'exclusiveMinimum' in value
    || 'exclusiveMaximum' in value || 'multipleOf' in value) return 'number'
  return undefined
}

function schemaIncludesType(value, type) {
  return value === type || (Array.isArray(value) && value.includes(type))
}

function normalizeCodexSchemaNode(value) {
  if (typeof value === 'boolean') return { type: 'string' }
  if (Array.isArray(value)) return value.map(normalizeCodexSchemaNode)
  if (!isRecord(value)) return value
  const source = { ...value }
  if ('const' in source) {
    source.enum = [source.const]
    delete source.const
  }
  const schemaType = inferredSchemaType(source)
  if (!schemaType) {
    if (!('$ref' in source || 'anyOf' in source || 'oneOf' in source || 'allOf' in source)) {
      return {}
    }
  } else {
    source.type = schemaType
  }
  if (schemaIncludesType(schemaType, 'object') && !isRecord(source.properties)) source.properties = {}
  if (schemaIncludesType(schemaType, 'array') && source.items === undefined) {
    source.items = { type: 'string' }
  }
  const output = {}
  for (const key of CODEX_SCHEMA_KEYS) {
    if (!(key in source)) continue
    const child = source[key]
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      if (!isRecord(child)) continue
      output[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, normalizeCodexSchemaNode(schema)]),
      )
    } else if (key === 'items') {
      output[key] = normalizeCodexSchemaNode(child)
    } else if (key === 'additionalProperties') {
      output[key] = typeof child === 'boolean' ? child : normalizeCodexSchemaNode(child)
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (Array.isArray(child)) output[key] = child.map(normalizeCodexSchemaNode)
    } else {
      output[key] = child
    }
  }
  return JSON.parse(canonicalJson(output))
}

function recursivelyContains(value, expected) {
  if (typeof value === 'string') return value === expected
  if (Array.isArray(value)) return value.some((child) => recursivelyContains(child, expected))
  return value && typeof value === 'object'
    ? Object.values(value).some((child) => recursivelyContains(child, expected))
    : false
}

function occurrenceCount(value, expected) {
  if (typeof value === 'string') return value.split(expected).length - 1
  if (Array.isArray(value)) {
    return value.reduce((total, child) => total + occurrenceCount(child, expected), 0)
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce(
      (total, child) => total + occurrenceCount(child, expected), 0,
    )
  }
  return 0
}

function uniqueDocumentContent(value, code) {
  const matches = []
  const visit = (candidate) => {
    if (typeof candidate === 'string') {
      if (candidate.includes(`<title>${EXPECTED_DOCX_TITLE}</title>`)) matches.push(candidate)
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (candidate && typeof candidate === 'object') Object.values(candidate).forEach(visit)
  }
  visit(value)
  assert(matches.length === 1, code)
  return matches[0]
}

function optionValues(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === name) {
      const next = args[index + 1]
      if (typeof next === 'string' && !next.startsWith('--')) values.push(next)
      continue
    }
    if (token.startsWith(`${name}=`)) values.push(token.slice(name.length + 1))
  }
  return values
}

function exactOption(args, name, code, optional = false) {
  const values = optionValues(args, name)
  if (optional && values.length === 0) return null
  assert(values.length === 1 && values[0].length > 0, code)
  return values[0]
}

function hasFlag(args, name) {
  return args.some((token) => token === name || token.startsWith(`${name}=`))
}

function assertSkillMethodology(
  commandRows, domainSkill, firstBusinessIndex, authRows, requiredReferences,
) {
  const skillRows = commandRows.filter((row) => row.path === 'skills read')
  assert(commandRows[0]?.path === 'skills read'
    && canonicalJson(commandRows[0].args) === canonicalJson(['skills', 'read', 'lark-shared'])
    && authRows[0]?.index > commandRows[0].index,
  'e6_user_scenario_skill_methodology_invalid')
  for (const row of skillRows) {
    assert(row.args[0] === 'skills' && row.args[1] === 'read'
      && ['lark-shared', domainSkill].includes(row.args[2])
      && (row.args.length === 3
        || (row.args.length === 4 && row.args[2] === domainSkill
          && row.args[3].startsWith(
            domainSkill === 'lark-sheets' ? 'references/lark-sheets-' : 'references/',
          )
          && !row.args[3].includes('..'))),
    'e6_user_scenario_skill_methodology_invalid')
  }
  assert(skillRows.some((row) => row.args.length === 3 && row.args[2] === domainSkill
    && row.index > authRows[0].index && row.index < firstBusinessIndex),
  'e6_user_scenario_skill_methodology_invalid')
  assert(requiredReferences.every((reference) => skillRows.some((row) => (
    canonicalJson(row.args) === canonicalJson(['skills', 'read', domainSkill, reference])
    && row.index > authRows[0].index && row.index < firstBusinessIndex
  ))), 'e6_user_scenario_skill_methodology_invalid')
}

function assertDryRunPreview(commandRows, write, code) {
  assert(!hasFlag(write.args, '--dry-run'), code)
  const previews = commandRows.filter((row) => {
    const dryRunTokens = row.args.filter((token) => token === '--dry-run')
    return row.path === write.path && dryRunTokens.length === 1
      && !row.args.some((token) => token.startsWith('--dry-run='))
      && canonicalJson(row.args.filter((token) => token !== '--dry-run'))
        === canonicalJson(write.args)
  })
  assert(previews.length === 1 && previews[0].index < write.index, code)
  return previews[0]
}

function commandOf(call) {
  const data = call.actionResult?.data
  const command = data?.command
  assert(data?.ok === true && data.exitCode === 0
    && data.stdoutTruncated === false && data.stderrTruncated === false
    && command?.bin === 'lark-cli' && Array.isArray(command.args)
    && command.args.every((arg) => typeof arg === 'string'),
  'e6_user_scenario_command_result_invalid')
  return {
    args: command.args,
    stdout: typeof data.stdout === 'string' ? data.stdout.trim() : '',
  }
}

function assertCommandAuthority(call, cliIdentity) {
  const required = call.actionResult?.data?.requiredMethod
  assert(required && typeof required.methodId === 'string' && required.methodId.length > 0
    && required.commandName === 'lark-cli'
    && required.authorityDigest === cliIdentity.authorityDigest
    && required.payloadSha256 === cliIdentity.payloadSha256
    && required.version === cliIdentity.version,
  'e6_user_scenario_command_authority_invalid')
}

function commandPath(call) {
  const args = commandOf(call).args
  return `${args[0] || ''} ${args[1] || ''}`.trim()
}

function assertAllowedCommandPaths(rows, allowed) {
  assert(rows.every((row) => allowed.has(row.path)),
    'e6_user_scenario_unexpected_command')
}

function parseStdout(call) {
  const stdout = commandOf(call).stdout
  assert(stdout.length > 0, 'e6_user_scenario_command_stdout_missing')
  return parseJson(stdout, 'e6_user_scenario_command_stdout_invalid')
}

function projectSafeAuthStatus(value) {
  const user = value?.identities?.user
  assert(value?.identity === 'user' && value?.verified === true
    && value.defaultAs === 'user'
    && typeof value.appId === 'string' && value.appId.length > 0
    && typeof value.brand === 'string' && value.brand.length > 0
    && user?.available === true && user?.verified === true
    && typeof user.openId === 'string' && user.openId.length > 0
    && user.status === 'ready'
    && user.tokenStatus === 'valid'
    && typeof user.scope === 'string' && user.scope.trim().length > 0,
  'e6_user_scenario_auth_status_invalid')
  const scopes = user.scope.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean).sort()
  return {
    principalDigest: digestJson({
      appId: value.appId,
      brand: value.brand,
      identity: value.identity,
      openId: user.openId,
    }),
    scopeDigest: digestJson(scopes),
    statusDigest: digestJson({
      available: user.available,
      status: user.status,
      tokenStatus: user.tokenStatus,
      verified: user.verified,
    }),
  }
}

function assertAuthStatus(call) {
  const args = commandOf(call).args
  assert(canonicalJson(args) === canonicalJson(['auth', 'status', '--json', '--verify']),
    'e6_user_scenario_auth_status_invalid')
  return projectSafeAuthStatus(parseStdout(call))
}

function readE6UserScenarioDatabase(databasePath, runIds, sqliteJson) {
  assert(Array.isArray(runIds) && runIds.length === 2 && new Set(runIds).size === 2,
    'e6_user_scenario_run_identity_invalid')
  const runSet = new Set(runIds)
  const turns = sqliteJson(databasePath, `
    SELECT turn.ready_run_id AS readyRunId, turn.ready_task_id AS readyTaskId,
           thread.ready_conversation_alias AS scopeId,
           thread.codex_session_id AS codexSessionId,
           thread.codex_thread_id AS codexThreadId,
           turn.codex_turn_id AS codexTurnId,
           turn.tool_surface_digest AS toolSurfaceDigest,
           thread.tool_surface_snapshot_digest AS toolSurfaceSnapshotDigest,
           turn.authorization_snapshot_digest AS authorizationSnapshotDigest,
           turn.authorization_snapshot_json AS authorizationSnapshotJson,
           turn.turn_contract_digest AS turnContractDigest,
           thread.tool_surface_json AS toolSurfaceJson,
           turn.engine_terminal_status AS engineTerminalStatus,
           turn.engine_terminal_candidate_json AS engineTerminalCandidateJson,
           turn.engine_terminal_candidate_digest AS engineTerminalCandidateDigest,
           turn.product_terminal_digest AS productTerminalDigest,
           turn.publication_receipt_refs_json AS publicationReceiptRefsJson,
           turn.publication_receipt_digest AS publicationReceiptDigest,
           turn.fence_release_revision AS fenceReleaseRevision,
           (SELECT COUNT(*) FROM chat_messages message
             WHERE message.conversation_id = thread.ready_conversation_alias
               AND message.role = 'assistant'
               AND json_extract(message.meta_json, '$.runId') = turn.ready_run_id) AS canonicalMessageCount,
           turn.created_at AS createdAt
      FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
     ORDER BY turn.created_at;
  `).filter((row) => runSet.has(row.readyRunId)).map((row) => ({
    ...row,
    authorizationSnapshot: parseJson(
      row.authorizationSnapshotJson, 'e6_user_scenario_authorization_invalid',
    ),
    toolSurface: parseJson(row.toolSurfaceJson, 'e6_user_scenario_tool_surface_invalid'),
    engineTerminalCandidate: parseJson(
      row.engineTerminalCandidateJson, 'e6_user_scenario_terminal_invalid',
    ),
    publicationReceiptRefs: parseJson(
      row.publicationReceiptRefsJson, 'e6_user_scenario_publication_invalid',
    ),
  }))
  const calls = sqliteJson(databasePath, `
    SELECT admission.ready_run_id AS readyRunId,
           admission.codex_thread_id AS codexThreadId,
           admission.codex_turn_id AS codexTurnId,
           admission.codex_call_id AS codexCallId,
           admission.tool_name AS toolName,
           admission.args_digest AS admissionArgsDigest,
           admission.gateway_request_receipt_id AS gatewayRequestReceiptId,
           admission.admitted_at AS admittedAt,
           binding.ready_action_id AS readyActionId,
           binding.ready_alias_id AS readyAliasId,
           binding.codex_session_id AS codexSessionId,
           binding.ready_task_id AS readyTaskId,
           binding.tool_name AS bindingToolName,
           binding.args_digest AS bindingArgsDigest,
           binding.turn_contract_digest AS turnContractDigest,
           binding.surface_snapshot_digest AS surfaceSnapshotDigest,
           binding.tool_surface_digest AS bindingToolSurfaceDigest,
           binding.authorization_snapshot_digest AS authorizationSnapshotDigest,
           binding.tool_schema_digest AS toolSchemaDigest,
           binding.receipt_id AS bindingReceiptId,
           binding.result_digest AS bindingResultDigest,
           binding.delivered_connection_epoch AS deliveredConnectionEpoch,
           binding.delivered_rpc_id AS deliveredRpcId,
           binding.tool_response_digest AS toolResponseDigest,
           binding.delivery_intent_at AS deliveryIntentAt,
           action.action_identity_digest AS actionIdentityDigest,
           action.state AS actionState,
           action.receipt_id AS actionReceiptId,
           action.result_digest AS actionResultDigest,
           action.result_json AS actionResultJson,
           action.updated_at AS actionUpdatedAt
      FROM codex_tool_call_admissions admission
      LEFT JOIN codex_tool_call_bindings binding
        ON binding.ready_run_id = admission.ready_run_id
       AND binding.codex_thread_id = admission.codex_thread_id
       AND binding.codex_turn_id = admission.codex_turn_id
       AND binding.codex_call_id = admission.codex_call_id
      LEFT JOIN ready_tool_action_receipts action
        ON action.ready_action_id = binding.ready_action_id
     ORDER BY admission.admitted_at, admission.codex_call_id;
  `).filter((row) => runSet.has(row.readyRunId)).map((row) => ({
    ...row,
    actionResult: parseJson(row.actionResultJson, 'e6_user_scenario_action_result_invalid'),
  }))
  const confirmations = sqliteJson(databasePath, `
    SELECT id, run_id AS readyRunId, scope_id AS scopeId, tool_name AS toolName,
           params_json AS paramsJson, created_at AS createdAt,
           status, released_at AS releasedAt
      FROM pending_confirmations
     ORDER BY created_at, id;
  `).filter((row) => runSet.has(row.readyRunId)).map((row) => ({
    ...row,
    audit: parseJson(row.paramsJson, 'e6_user_scenario_confirmation_invalid'),
  }))
  const gatewayRequests = sqliteJson(databasePath, `
    SELECT receipt.ready_run_id AS readyRunId, receipt.receipt_id AS receiptId,
           receipt.request_digest AS requestDigest,
           receipt.upstream_profile_snapshot_ref AS upstreamProfileSnapshotRef,
           receipt.upstream_profile_snapshot_digest AS upstreamProfileSnapshotDigest,
           request_event.input_digest AS inputDigest,
           request_event.tools_digest AS toolsDigest,
           response_event.response_id AS responseId,
           response_event.terminal_digest AS responseTerminalDigest,
           response_event.output_digest AS responseOutputDigest,
           response_event.usage_digest AS responseUsageDigest
      FROM ready_model_gateway_request_receipts receipt
      JOIN ready_model_gateway_exchange_events request_event
        ON request_event.gateway_request_receipt_id = receipt.receipt_id
       AND request_event.event_kind = 'request_admitted'
      JOIN ready_model_gateway_exchange_events response_event
        ON response_event.gateway_request_receipt_id = receipt.receipt_id
       AND response_event.event_kind = 'response_completed'
     WHERE receipt.request_kind = 'product'
     ORDER BY request_event.event_sequence;
  `).filter((row) => runSet.has(row.readyRunId))
  const providerSnapshots = sqliteJson(databasePath, `
    SELECT snapshot_ref AS snapshotRef, snapshot_digest AS snapshotDigest,
           profile_id AS profileId, credential_reference_id AS credentialReferenceId,
           snapshot_json AS snapshotJson
      FROM ready_model_gateway_profile_snapshots ORDER BY created_at;
  `).map((row) => ({
    ...row,
    snapshot: parseJson(row.snapshotJson, 'e6_user_scenario_provider_invalid'),
  }))
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
  return { turns, calls, confirmations, gatewayRequests, providerSnapshots, sidecarLeases }
}

function assertProviderEvidence(evidence, expectation) {
  assert(expectation && evidence.providerSnapshots.length === 1,
    'e6_user_scenario_provider_invalid')
  const provider = evidence.providerSnapshots[0]
  const snapshot = provider.snapshot
  const credentialReferenceId = `ai-profile:${expectation.profileId}`
  assert(snapshot && provider.snapshotRef && SHA256.test(provider.snapshotDigest)
    && sameKeys(snapshot, PROVIDER_SNAPSHOT_KEYS)
    && sameKeys(snapshot.retryPolicy, RETRY_POLICY_KEYS)
    && digestJson(snapshot) === provider.snapshotDigest
    && provider.profileId === expectation.profileId
    && provider.credentialReferenceId === credentialReferenceId
    && snapshot.profileId === expectation.profileId
    && snapshot.providerId === expectation.providerId
    && snapshot.model === expectation.model
    && String(snapshot.baseUrl || '').replace(/\/+$/, '') === expectation.baseUrl
    && snapshot.authHeader === expectation.authHeader
    && snapshot.authPrefix === expectation.authPrefix
    && snapshot.credentialReferenceId === credentialReferenceId
    && snapshot.agentProtocol === 'openai'
    && ['chat/completions', 'responses'].includes(snapshot.wireApi)
    && snapshot.retryPolicy.owner === 'ready_gateway'
    && snapshot.retryPolicy.maxRetries === 6
    && snapshot.retryPolicy.semantic4xxRetries === 0
    && [null, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      .includes(snapshot.reasoningEffort)
    && ['supportsToolCalls', 'supportsNativeToolCalls', 'supportsVision', 'supportsThinking']
      .every((key) => typeof snapshot[key] === 'boolean')
    && ['proven_safe', 'echo_required', 'unsupported', 'unknown']
      .includes(snapshot.multiTurnThinkingPolicy)
    && (snapshot.patchProfileId === null
      || (typeof snapshot.patchProfileId === 'string' && snapshot.patchProfileId.length > 0))
    && snapshot.extraHeaders && typeof snapshot.extraHeaders === 'object'
    && !Array.isArray(snapshot.extraHeaders) && Object.keys(snapshot.extraHeaders).length === 0
    && !/(?:^|[-_])(?:mock|test|fixture)(?:$|[-_])/i.test(
      `${snapshot.providerId}\0${snapshot.model}\0${snapshot.profileId}`,
    )
    && expectation.endpointClass === 'trusted_public_https'
    && SHA256.test(expectation.endpointOriginDigest),
  'e6_user_scenario_provider_invalid')
  assert(evidence.gatewayRequests.every((request) => (
    request.upstreamProfileSnapshotRef === provider.snapshotRef
    && request.upstreamProfileSnapshotDigest === provider.snapshotDigest
  )), 'e6_user_scenario_provider_request_binding_invalid')
  for (const call of evidence.calls) {
    const matches = evidence.gatewayRequests.filter((request) => (
      request.readyRunId === call.readyRunId
      && request.receiptId === call.gatewayRequestReceiptId
    ))
    assert(matches.length === 1, 'e6_user_scenario_gateway_admission_binding_invalid')
  }
  return {
    providerId: snapshot.providerId,
    modelDigest: digestJson(snapshot.model),
    endpointClass: expectation.endpointClass,
    endpointOriginDigest: expectation.endpointOriginDigest,
    profileIdDigest: digestJson(snapshot.profileId),
    snapshotDigest: provider.snapshotDigest,
  }
}

function assertNativeTerminalCandidateForEvidence(turn, calls) {
  const candidate = turn.engineTerminalCandidate
  const candidateKeys = [
    'abortInitiator', 'actionReceiptRefs', 'browserContinuationRef', 'browserProofRefs',
    'budgetState', 'candidateDigest', 'candidateSelection', 'candidateText', 'codexThreadId',
    'codexTurnId', 'contextState', 'engineOutcome', 'interactionState', 'kind',
    'otherProofRefs', 'projectionPatchRefs', 'providerDiagnostics', 'readyRunId',
    'readyTaskId', 'recoveryCheckpointRef', 'runtimeDiagnostics', 'scopeId',
    'terminalReasonCandidate', 'usedToolCalls', 'waitingFor',
  ]
  assert(sameKeys(candidate, candidateKeys)
    && candidate.kind === 'native_terminal'
    && candidate.readyTaskId === turn.readyTaskId
    && candidate.readyRunId === turn.readyRunId
    && candidate.scopeId === turn.scopeId
    && candidate.codexThreadId === turn.codexThreadId
    && candidate.codexTurnId === turn.codexTurnId
    && candidate.engineOutcome === 'completed'
    && sameKeys(candidate.candidateSelection, ['itemId', 'kind'])
    && candidate.candidateSelection.kind === 'accepted'
    && typeof candidate.candidateSelection.itemId === 'string'
    && candidate.candidateSelection.itemId.length > 0
    && typeof candidate.candidateText === 'string' && candidate.candidateText.length > 0
    && candidate.candidateDigest === digestText(candidate.candidateText)
    && Array.isArray(candidate.actionReceiptRefs) && candidate.actionReceiptRefs.length === 0
    && candidate.interactionState === null && candidate.waitingFor === null
    && typeof candidate.terminalReasonCandidate === 'string'
    && candidate.terminalReasonCandidate.length > 0
    && candidate.abortInitiator === null
    && isRecord(candidate.budgetState) && isRecord(candidate.contextState)
    && isRecord(candidate.providerDiagnostics)
    && (candidate.recoveryCheckpointRef === null
      || typeof candidate.recoveryCheckpointRef === 'string')
    && (candidate.browserContinuationRef === null
      || typeof candidate.browserContinuationRef === 'string')
    && Array.isArray(candidate.browserProofRefs)
    && Array.isArray(candidate.otherProofRefs)
    && Array.isArray(candidate.projectionPatchRefs)
    && sameKeys(candidate.runtimeDiagnostics, [
      'commentaryItemIds', 'finalDeltaItemIds', 'nativeTurnError',
    ])
    && Array.isArray(candidate.runtimeDiagnostics.commentaryItemIds)
    && Array.isArray(candidate.runtimeDiagnostics.finalDeltaItemIds)
    && candidate.runtimeDiagnostics.nativeTurnError === null
    && digestJson(candidate) === turn.engineTerminalCandidateDigest,
  'e6_user_scenario_terminal_invalid')
  assert(Array.isArray(candidate.usedToolCalls)
    && candidate.usedToolCalls.length === calls.length
    && new Set(candidate.usedToolCalls.map((call) => call.itemId)).size === calls.length
    && calls.every((call) => candidate.usedToolCalls.filter((used) => (
      sameKeys(used, ['itemId', 'responseDigest', 'status', 'success', 'tool'])
      && used.itemId === call.codexCallId
      && used.tool === call.toolName
      && used.status === 'completed'
      && used.success === true
      && used.responseDigest === call.toolResponseDigest
    )).length === 1),
  'e6_user_scenario_terminal_tool_result_invalid')
}

function assertTurn(turn, kind, calls) {
  assert(turn && turn.engineTerminalStatus === 'completed'
    && SHA256.test(turn.productTerminalDigest)
    && SHA256.test(turn.publicationReceiptDigest)
    && Array.isArray(turn.publicationReceiptRefs)
    && turn.publicationReceiptRefs.length > 0
    && turn.publicationReceiptRefs.every((ref) => typeof ref === 'string' && ref.length > 0)
    && new Set(turn.publicationReceiptRefs).size === turn.publicationReceiptRefs.length
    && SHA256.test(turn.engineTerminalCandidateDigest)
    && Number.isSafeInteger(turn.fenceReleaseRevision)
    && turn.fenceReleaseRevision >= 1
    && Number(turn.canonicalMessageCount) === 1
    && SHA256.test(turn.toolSurfaceDigest)
    && SHA256.test(turn.toolSurfaceSnapshotDigest)
    && SHA256.test(turn.authorizationSnapshotDigest)
    && SHA256.test(turn.turnContractDigest),
  'e6_user_scenario_terminal_invalid')
  assertNativeTerminalCandidateForEvidence(turn, calls)
  const surface = turn.toolSurface
  assert(sameKeys(surface, [
    'dynamicTools', 'entries', 'responsesTools', 'surfaceId', 'surfaceSnapshotDigest',
    'toolNames', 'toolSurfaceDigest',
  ]) && Array.isArray(surface.entries) && Array.isArray(surface.dynamicTools)
    && Array.isArray(surface.responsesTools) && Array.isArray(surface.toolNames)
    && canonicalJson(surface.toolNames) === canonicalJson([...ALLOWED_TOOLS].sort())
    && canonicalJson(surface.entries.map((entry) => entry.name))
      === canonicalJson(surface.toolNames)
    && canonicalJson(surface.dynamicTools.map((entry) => entry.name))
      === canonicalJson(surface.toolNames)
    && canonicalJson(surface.responsesTools.map((entry) => entry.name))
      === canonicalJson(surface.toolNames)
    && surface.entries.every((entry) => sameKeys(entry, [
      'description', 'effectProfile', 'effectProfileDigest', 'inputSchema', 'name',
      'schemaDigest',
    ]) && typeof entry.description === 'string'
      && entry.schemaDigest === digestJson(entry.inputSchema)
      && entry.effectProfileDigest === digestJson(entry.effectProfile))
    && surface.dynamicTools.every((entry, index) => sameKeys(entry, [
      'description', 'inputSchema', 'name', 'type',
    ]) && entry.type === 'function'
      && entry.name === surface.entries[index].name
      && entry.description === surface.entries[index].description
      && canonicalJson(entry.inputSchema) === canonicalJson(surface.entries[index].inputSchema))
    && surface.responsesTools.every((entry, index) => sameKeys(entry, [
      'description', 'name', 'parameters', 'strict', 'type',
    ]) && entry.type === 'function' && entry.strict === false
      && entry.name === surface.entries[index].name
      && entry.description === surface.entries[index].description
      && canonicalJson(entry.parameters)
        === canonicalJson(normalizeCodexSchemaNode(surface.entries[index].inputSchema)))
    && surface.toolSurfaceDigest === digestJson(surface.responsesTools)
    && surface.surfaceSnapshotDigest === digestJson({
      entries: surface.entries,
      dynamicTools: surface.dynamicTools,
      responsesTools: surface.responsesTools,
    })
    && surface.toolSurfaceDigest === turn.toolSurfaceDigest
    && surface.surfaceSnapshotDigest === turn.toolSurfaceSnapshotDigest,
  'e6_user_scenario_tool_surface_invalid')
  const authorization = turn.authorizationSnapshot
  assert(sameKeys(authorization, [
    'allowedToolNames', 'authorizationDigest', 'authorizationId',
    'authorizationSnapshotDigest', 'createdAt', 'readyRunId', 'readySessionKey',
    'readyTaskId', 'resourceAnchorDigest', 'scopeId', 'skillAuthorization',
    'toolSurfaceDigest', 'turnContractDigest',
  ]) && canonicalJson(authorization.allowedToolNames) === canonicalJson(surface.toolNames)
    && sameKeys(authorization.skillAuthorization, [
      'allowedPrimitives', 'allowedTypedActions', 'mode', 'reason', 'skillId', 'source',
    ])
    && authorization.skillAuthorization.mode === 'selected'
    && authorization.skillAuthorization.skillId === 'lark-cli'
    && authorization.skillAuthorization.source === 'explicit'
    && canonicalJson(authorization.skillAuthorization.allowedTypedActions) === '[]'
    && canonicalJson(authorization.skillAuthorization.allowedPrimitives)
      === canonicalJson(['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'])
    && authorization.authorizationDigest === digestJson({
      authorizationId: authorization.authorizationId,
      allowedToolNames: authorization.allowedToolNames,
      skillAuthorization: authorization.skillAuthorization,
    })
    && authorization.authorizationSnapshotDigest === digestJson({
      authorizationId: authorization.authorizationId,
      authorizationDigest: authorization.authorizationDigest,
      readySessionKey: authorization.readySessionKey,
      readyTaskId: authorization.readyTaskId,
      readyRunId: authorization.readyRunId,
      scopeId: authorization.scopeId,
      toolSurfaceDigest: authorization.toolSurfaceDigest,
      turnContractDigest: authorization.turnContractDigest,
      resourceAnchorDigest: authorization.resourceAnchorDigest,
      createdAt: authorization.createdAt,
      allowedToolNames: authorization.allowedToolNames,
      skillAuthorization: authorization.skillAuthorization,
    })
    && authorization.authorizationSnapshotDigest === turn.authorizationSnapshotDigest
    && authorization.readyTaskId === turn.readyTaskId
    && authorization.readyRunId === turn.readyRunId
    && authorization.scopeId === turn.scopeId
    && authorization.toolSurfaceDigest === turn.toolSurfaceDigest
    && authorization.turnContractDigest === turn.turnContractDigest
    && isIsoDate(authorization.createdAt)
    && SHA256.test(authorization.resourceAnchorDigest),
  'e6_user_scenario_authorization_invalid')
  return {
    kind,
    readyRunIdDigest: digestJson(turn.readyRunId),
    scopeIdDigest: digestText(turn.scopeId),
    threadIdDigest: digestJson(turn.codexThreadId),
    turnIdDigest: digestJson(turn.codexTurnId),
    toolSurfaceDigest: turn.toolSurfaceDigest,
    authorizationSnapshotDigest: turn.authorizationSnapshotDigest,
    publicationReceiptDigest: turn.publicationReceiptDigest,
  }
}

function assertActionCall(call, turn, expectedToolResponseDigest) {
  const surfaceEntry = turn.toolSurface.entries.find((entry) => entry.name === call.toolName)
  assert(call.bindingArgsDigest === call.admissionArgsDigest
    && call.bindingToolName === call.toolName
    && call.bindingToolSurfaceDigest === turn.toolSurfaceDigest
    && surfaceEntry?.schemaDigest === call.toolSchemaDigest
    && call.readyRunId === turn.readyRunId
    && call.readyTaskId === turn.readyTaskId
    && call.readyAliasId === turn.scopeId
    && call.codexSessionId === turn.codexSessionId
    && call.codexThreadId === turn.codexThreadId
    && call.codexTurnId === turn.codexTurnId
    && call.turnContractDigest === turn.turnContractDigest
    && call.surfaceSnapshotDigest === turn.toolSurfaceSnapshotDigest
    && call.authorizationSnapshotDigest === turn.authorizationSnapshotDigest
    && call.actionState === 'confirmed'
    && SHA256.test(call.bindingResultDigest)
    && call.bindingResultDigest === call.actionResultDigest
    && call.bindingReceiptId === call.actionReceiptId
    && call.actionReceiptId === `ready-tool-receipt-${digestJson({
      readyActionId: call.readyActionId,
      resultDigest: call.actionResultDigest,
    })}`
    && digestJson(call.actionResult) === call.actionResultDigest
    && typeof call.deliveredConnectionEpoch === 'string'
    && typeof call.deliveredRpcId === 'string'
    && SHA256.test(call.toolResponseDigest)
    && call.toolResponseDigest === expectedToolResponseDigest
    && typeof call.deliveryIntentAt === 'string',
  'e6_user_scenario_action_receipt_invalid')
  const expectedActionIdentityDigest = digestJson({
    readyAliasId: call.readyAliasId,
    codexSessionId: call.codexSessionId,
    codexThreadId: call.codexThreadId,
    codexTurnId: call.codexTurnId,
    callId: call.codexCallId,
    readyTaskId: call.readyTaskId,
    readyRunId: call.readyRunId,
    toolName: call.toolName,
    argsDigest: call.bindingArgsDigest,
    turnContractDigest: call.turnContractDigest,
    surfaceSnapshotDigest: call.surfaceSnapshotDigest,
    authorizationSnapshotDigest: call.authorizationSnapshotDigest,
    schemaDigest: call.toolSchemaDigest,
  })
  assert(call.actionIdentityDigest === expectedActionIdentityDigest
    && call.readyActionId === `codex-action-${expectedActionIdentityDigest}`,
  'e6_user_scenario_action_identity_invalid')
}

function assertConfirmationForCall(confirmations, call) {
  const matches = confirmations.filter((row) => (
    row.readyRunId === call.readyRunId
    && row.scopeId === call.readyAliasId
    && row.toolName === call.toolName
    && row.audit?.canonicalSha256 === call.admissionArgsDigest
  ))
  assert(matches.length === 1, 'e6_user_scenario_confirmation_binding_invalid')
  const confirmation = matches[0]
  assert(confirmation.status === 'released'
    && typeof confirmation.id === 'string' && confirmation.id.startsWith('fc-')
    && isIsoDate(confirmation.createdAt) && isIsoDate(confirmation.releasedAt)
    && isIsoDate(call.admittedAt) && isIsoDate(call.actionUpdatedAt)
    && call.admittedAt <= confirmation.createdAt
    && confirmation.createdAt <= confirmation.releasedAt
    && confirmation.releasedAt <= call.actionUpdatedAt
    && sameKeys(confirmation.audit, ['__audit', 'canonicalSha256', 'sha256', 'shape'])
    && confirmation.audit.__audit === 'redacted'
    && SHA256.test(confirmation.audit.sha256)
    && SHA256.test(confirmation.audit.canonicalSha256)
    && !confirmation.paramsJson.includes(commandOf(call).args.join(' ')),
  'e6_user_scenario_confirmation_invalid')
  return {
    idDigest: digestText(confirmation.id),
    argsDigest: confirmation.audit.canonicalSha256,
    releasedAtDigest: digestText(confirmation.releasedAt),
  }
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value
}

function numericValuesForKeys(value, keys, out = []) {
  if (Array.isArray(value)) {
    value.forEach((child) => numericValuesForKeys(child, keys, out))
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (keys.has(key) && Number.isSafeInteger(Number(child))) out.push(Number(child))
      numericValuesForKeys(child, keys, out)
    }
  }
  return out
}

function uniqueNumber(value, keys, code) {
  const values = [...new Set(numericValuesForKeys(value, new Set(keys)))]
  assert(values.length === 1 && values[0] >= 0, code)
  return values[0]
}

function sheetSelector(args) {
  const sheetIds = optionValues(args, '--sheet-id')
  const sheetNames = optionValues(args, '--sheet-name')
  assert((sheetIds.length === 1 && sheetNames.length === 0)
    || (sheetNames.length === 1 && sheetIds.length === 0),
  'e6_user_scenario_sheet_selector_invalid')
  return sheetIds.length === 1
    ? { key: 'sheet_id', value: sheetIds[0] }
    : { key: 'title', value: sheetNames[0] }
}

function matchingSheetMetadata(value, selector, matches = []) {
  if (Array.isArray(value)) {
    value.forEach((child) => matchingSheetMetadata(child, selector, matches))
  } else if (value && typeof value === 'object') {
    const candidate = value[selector.key]
      ?? (selector.key === 'sheet_id' ? value.sheetId : value.sheet_name ?? value.sheetName)
    if (candidate === selector.value) matches.push(value)
    Object.values(value).forEach((child) => matchingSheetMetadata(child, selector, matches))
  }
  return matches
}

function parseColumnCount(call, selector) {
  const matches = matchingSheetMetadata(parseStdout(call), selector)
  assert(matches.length === 1, 'e6_user_scenario_sheet_metadata_invalid')
  return uniqueNumber(
    matches[0], ['column_count', 'columnCount'], 'e6_user_scenario_sheet_metadata_invalid',
  )
}

function parseRevision(call) {
  return uniqueNumber(
    parseStdout(call), ['revision', 'revision_id', 'revisionId'],
    'e6_user_scenario_revision_invalid',
  )
}

function exactSingleCellRead(call, expectedRange, expectedRevision, code) {
  const value = parseStdout(call)
  const projection = projectSingleSheetCellRead(value, expectedRange)
  assert(projection && projection.revision === expectedRevision, code)
  return {
    contentDigest: outputDigest(call),
    ...projection,
  }
}

function assertPreInsertStructure(call, selector, previousColumn, expectedRevision) {
  const value = parseStdout(call)
  const projection = projectSheetStructureRead(value, selector)
  assert(projection && projection.revision === expectedRevision
    && new RegExp(`^A1:${previousColumn}[1-9][0-9]*$`).test(projection.range),
  'e6_user_scenario_sheet_structure_invalid')
  return outputDigest(call)
}

function assertCommonLarkArgs(args, targetUrl, code) {
  const target = new URL(targetUrl)
  const isSheet = target.pathname.includes('/sheets/')
  const targetFlag = isSheet ? '--url' : '--doc'
  const forbiddenFlag = isSheet ? '--spreadsheet-token' : '--document-id'
  assert(exactOption(args, targetFlag, code) === targetUrl
    && optionValues(args, forbiddenFlag).length === 0
    && exactOption(args, '--as', code) === 'user'
    && !args.some((token) => (
      token === '--jq' || token.startsWith('--jq=')
      || token === '-q' || (token.startsWith('-q') && token.length > 2)
      || token === '--format' || token.startsWith('--format=')
      || token === '--output' || token.startsWith('--output=')
      || token === '--output-path' || token.startsWith('--output-path=')
      || token === '--output-dir' || token.startsWith('--output-dir=')
      || token === '-o' || (token.startsWith('-o') && token.length > 2)
    )), code)
}

function resourceTokenFromUrl(value, kind, code) {
  const parsed = new URL(value)
  const match = parsed.pathname.match(kind === 'sheet' ? /\/sheets\/([^/]+)/ : /\/docx\/([^/]+)/)
  assert(match?.[1], code)
  return match[1]
}

function outputDigest(call) {
  const stdout = call?.actionResult?.data?.stdout
  assert(typeof stdout === 'string' && stdout.length > 0,
    'e6_user_scenario_command_stdout_invalid')
  try {
    return digestJson(JSON.parse(stdout.trim()))
  } catch {
    return digestText(stdout)
  }
}

function buildValidatedCallLedger(
  calls, commandRows, expectedRoles, requiredReferences, domainSkill, cliIdentity,
) {
  let baseOrdinal = 0
  const seenReferences = new Set()
  const shellRows = commandRows.map((row, shellOrdinal) => {
    const methodologyReference = row.path === 'skills read' && row.args.length === 4
      ? row.args[3]
      : null
    let role
    if (methodologyReference !== null) {
      const domainPrefix = domainSkill === 'lark-sheets'
        ? 'references/lark-sheets-'
        : 'references/'
      assert(baseOrdinal === 3 && row.args[2] === domainSkill
        && methodologyReference.startsWith(domainPrefix)
        && !methodologyReference.includes('..')
        && !seenReferences.has(methodologyReference),
      'e6_user_scenario_command_ledger_sequence_invalid')
      role = 'skills_reference'
      seenReferences.add(methodologyReference)
    } else {
      const expected = expectedRoles[baseOrdinal]
      assert(expected && row.path === expected[1]
        && hasFlag(row.args, '--dry-run') === expected[2],
      'e6_user_scenario_command_ledger_sequence_invalid')
      role = expected[0]
      baseOrdinal += 1
    }
    return {
      callIdDigest: digestText(row.call.codexCallId),
      shellOrdinal,
      role,
      methodologyReference,
      commandArgsDigest: digestJson(row.args),
      commandAuthorityDigest: cliIdentity.authorityDigest,
      outputDigest: outputDigest(row.call),
    }
  })
  assert(baseOrdinal === expectedRoles.length
    && requiredReferences.every((reference) => seenReferences.has(reference)),
  'e6_user_scenario_command_ledger_sequence_invalid')
  const shellByCall = new Map(shellRows.map((row) => [row.callIdDigest, row]))
  return calls.map((call, ordinal) => {
    const shell = shellByCall.get(digestText(call.codexCallId))
    return {
      ordinal,
      shellOrdinal: shell?.shellOrdinal ?? null,
      role: shell?.role ?? 'non_shell',
      methodologyReference: shell?.methodologyReference ?? null,
      toolName: call.toolName,
      callIdDigest: digestText(call.codexCallId),
      readyRunIdDigest: digestJson(call.readyRunId),
      argsDigest: call.admissionArgsDigest,
      resultDigest: call.actionResultDigest,
      outputDigest: shell?.outputDigest ?? null,
      gatewayRequestReceiptIdDigest: digestText(call.gatewayRequestReceiptId),
      bindingReceiptIdDigest: digestText(call.bindingReceiptId),
      actionIdentityDigest: call.actionIdentityDigest,
      toolResponseDigest: call.toolResponseDigest,
      admittedAtDigest: digestText(call.admittedAt),
      actionUpdatedAtDigest: digestText(call.actionUpdatedAt),
      commandArgsDigest: shell?.commandArgsDigest ?? null,
      commandAuthorityDigest: shell?.commandAuthorityDigest ?? null,
    }
  })
}

function assertSheetRun(input) {
  const calls = input.calls.filter((call) => call.readyRunId === input.turn.readyRunId)
  calls.forEach((call) => assertActionCall(
    call, input.turn, input.toolResponseDigests.get(call.codexCallId),
  ))
  const shellCalls = calls.filter((call) => call.toolName === 'skill_run_shell')
  shellCalls.forEach((call) => assertCommandAuthority(call, input.cliIdentity))
  const commandRows = shellCalls.map((call, index) => ({
    call,
    index,
    path: commandPath(call),
    args: commandOf(call).args,
  }))
  assertAllowedCommandPaths(commandRows, new Set([
    'auth status', 'skills read', 'sheets +workbook-info', 'sheets +revision-get',
    'sheets +sheet-info', 'sheets +dim-insert', 'sheets +cells-set',
    'sheets +cells-get',
  ]))
  const insertRows = commandRows.filter((row) => row.path === 'sheets +dim-insert'
    && !hasFlag(row.args, '--dry-run'))
  const writeRows = commandRows.filter((row) => row.path === 'sheets +cells-set'
    && !hasFlag(row.args, '--dry-run'))
  assert(insertRows.length === 1 && writeRows.length === 1,
    'e6_user_scenario_sheet_write_cardinality_invalid')
  const insert = insertRows[0]
  const write = writeRows[0]
  const authRows = commandRows.filter((row) => row.path === 'auth status')
  assert(authRows.length === 1 && authRows[0].index < insert.index,
    'e6_user_scenario_auth_status_invalid')
  const firstBusiness = commandRows.find((row) => row.path.startsWith('sheets '))
  assert(firstBusiness, 'e6_user_scenario_skill_methodology_invalid')
  assertSkillMethodology(
    commandRows, 'lark-sheets', firstBusiness.index, authRows, SHEET_REQUIRED_REFERENCES,
  )
  const insertPreview = assertDryRunPreview(
    commandRows, insert, 'e6_user_scenario_sheet_preview_invalid',
  )
  const writePreview = assertDryRunPreview(
    commandRows, write, 'e6_user_scenario_sheet_preview_invalid',
  )
  assert(insert.index < write.index, 'e6_user_scenario_sheet_sequence_invalid')
  assertCommonLarkArgs(insert.args, input.sheetUrl, 'e6_user_scenario_sheet_insert_invalid')
  assertCommonLarkArgs(write.args, input.sheetUrl, 'e6_user_scenario_sheet_write_invalid')
  const selector = sheetSelector(insert.args)
  assert(canonicalJson(sheetSelector(write.args)) === canonicalJson(selector),
    'e6_user_scenario_sheet_selector_invalid')
  const position = exactOption(insert.args, '--position', 'e6_user_scenario_sheet_insert_invalid')
  assert(/^[A-Z]{1,3}$/.test(position)
    && exactOption(insert.args, '--count', 'e6_user_scenario_sheet_insert_invalid') === '1'
    && exactOption(insert.args, '--inherit-style',
      'e6_user_scenario_sheet_insert_invalid') === SHEET_APPEND_POLICY.inheritStyle,
  'e6_user_scenario_sheet_insert_invalid')
  const range = exactOption(write.args, '--range', 'e6_user_scenario_sheet_write_invalid')
  assert(range === `${position}1`
    && exactOption(write.args, '--allow-overwrite',
      'e6_user_scenario_sheet_write_invalid') === 'false',
  'e6_user_scenario_sheet_write_invalid')
  const cells = parseJson(
    exactOption(write.args, '--cells', 'e6_user_scenario_sheet_write_invalid'),
    'e6_user_scenario_sheet_write_invalid',
  )
  assert(canonicalJson(cells) === canonicalJson([[{ value: input.sheetSentinel }]]),
    'e6_user_scenario_sheet_write_invalid')
  const phaseRows = (path, predicate) => commandRows.filter((row) => (
    row.path === path && predicate(row)
  ))
  const beforeInfos = phaseRows('sheets +workbook-info', (row) => row.index < insertPreview.index)
  const beforeRevisions = phaseRows('sheets +revision-get', (row) => row.index < insertPreview.index)
  const preInsertStructures = phaseRows('sheets +sheet-info', (row) => (
    row.index < insertPreview.index
  ))
  const preInsertTemplates = phaseRows('sheets +cells-get', (row) => (
    row.index < insertPreview.index
  ))
  const insertedInfos = phaseRows('sheets +workbook-info', (row) => (
    row.index > insert.index && row.index < writePreview.index
  ))
  const insertedRevisions = phaseRows('sheets +revision-get', (row) => (
    row.index > insert.index && row.index < writePreview.index
  ))
  const insertedTemplates = phaseRows('sheets +cells-get', (row) => (
    row.index > insert.index && row.index < writePreview.index
  ))
  const afterInfos = phaseRows('sheets +workbook-info', (row) => row.index > write.index)
  const afterRevisions = phaseRows('sheets +revision-get', (row) => row.index > write.index)
  const readbacks = phaseRows('sheets +cells-get', (row) => (
    row.index > write.index && optionValues(row.args, '--range').includes(range)
  ))
  assert([beforeInfos, beforeRevisions, preInsertStructures, preInsertTemplates,
    insertedInfos, insertedRevisions, insertedTemplates, afterInfos,
    afterRevisions, readbacks].every((rows) => rows.length === 1),
    'e6_user_scenario_sheet_readback_missing')
  const [beforeInfo] = beforeInfos
  const [beforeRevision] = beforeRevisions
  const [preInsertStructure] = preInsertStructures
  const [preInsertTemplate] = preInsertTemplates
  const [insertedInfo] = insertedInfos
  const [insertedRevision] = insertedRevisions
  const [insertedTemplate] = insertedTemplates
  const [afterInfo] = afterInfos
  const [afterRevision] = afterRevisions
  const [readback] = readbacks
  for (const row of [beforeInfo, beforeRevision, preInsertStructure, preInsertTemplate,
    insertedInfo, insertedRevision, insertedTemplate, afterInfo, afterRevision, readback]) {
    assertCommonLarkArgs(row.args, input.sheetUrl, 'e6_user_scenario_sheet_read_invalid')
  }
  for (const row of [preInsertStructure, preInsertTemplate, insertedTemplate, readback]) {
    assert(canonicalJson(sheetSelector(row.args)) === canonicalJson(selector),
      'e6_user_scenario_sheet_selector_invalid')
  }
  assert(canonicalJson(sheetSelector(readback.args)) === canonicalJson(selector),
    'e6_user_scenario_sheet_selector_invalid')
  const columnCountBefore = parseColumnCount(beforeInfo.call, selector)
  const columnCountAfterInsert = parseColumnCount(insertedInfo.call, selector)
  const columnCountAfter = parseColumnCount(afterInfo.call, selector)
  const revisionBefore = parseRevision(beforeRevision.call)
  const revisionAfterInsert = parseRevision(insertedRevision.call)
  const revisionAfter = parseRevision(afterRevision.call)
  const previousColumn = columnNameForNumber(columnCountBefore)
  assert(position === columnNameForNumber(columnCountBefore + 1)
    && exactOption(preInsertStructure.args, '--include',
      'e6_user_scenario_sheet_structure_invalid') === SHEET_APPEND_POLICY.structureInclude
    && optionValues(preInsertStructure.args, '--range').length === 0
    && exactOption(preInsertTemplate.args, '--range',
      'e6_user_scenario_sheet_template_invalid') === `${previousColumn}1`
    && exactOption(preInsertTemplate.args, '--include',
      'e6_user_scenario_sheet_template_invalid') === SHEET_APPEND_POLICY.templateInclude
    && exactOption(insertedTemplate.args, '--range',
      'e6_user_scenario_sheet_template_invalid') === `${position}1`
    && exactOption(insertedTemplate.args, '--include',
      'e6_user_scenario_sheet_template_invalid') === SHEET_APPEND_POLICY.templateInclude,
  'e6_user_scenario_sheet_position_invalid')
  const preInsertStructureContentDigest = assertPreInsertStructure(
    preInsertStructure.call, selector, previousColumn, revisionBefore,
  )
  const preInsertTemplateRead = exactSingleCellRead(
    preInsertTemplate.call, `${previousColumn}1`, revisionBefore,
    'e6_user_scenario_sheet_template_invalid',
  )
  const postInsertTemplateRead = exactSingleCellRead(
    insertedTemplate.call, `${position}1`, revisionAfterInsert,
    'e6_user_scenario_sheet_template_invalid',
  )
  const finalReadback = exactSingleCellRead(
    readback.call, `${position}1`, revisionAfter,
    'e6_user_scenario_sheet_readback_invalid',
  )
  assert(columnCountAfterInsert === columnCountBefore + 1
    && columnCountAfter === columnCountAfterInsert
    && revisionAfterInsert > revisionBefore
    && revisionAfter > revisionAfterInsert
    && postInsertTemplateRead.empty
    && postInsertTemplateRead.styleDigest === preInsertTemplateRead.styleDigest
    && finalReadback.literalValue === input.sheetSentinel
    && finalReadback.styleDigest === preInsertTemplateRead.styleDigest,
  'e6_user_scenario_sheet_readback_invalid')
  const confirmationRows = [
    assertConfirmationForCall(input.confirmations, insert.call),
    assertConfirmationForCall(input.confirmations, write.call),
  ]
  return {
    calls,
    callLedger: buildValidatedCallLedger(
      calls, commandRows, SHEET_LEDGER_ROLES, SHEET_REQUIRED_REFERENCES,
      'lark-sheets', input.cliIdentity,
    ),
    authIdentities: authRows.map((row) => assertAuthStatus(row.call)),
    confirmations: confirmationRows,
    evidence: {
      referenceDigest: digestJson(input.sheetUrl),
      commandAuthorityBindingDigest: digestJson(shellCalls.map((call) => ({
        callIdDigest: digestText(call.codexCallId),
        authorityDigest: input.cliIdentity.authorityDigest,
      }))),
      sentinelDigest: digestJson(input.sheetSentinel),
      insertedColumn: position,
      columnCountBefore,
      columnCountAfterInsert,
      columnCountAfter,
      revisionBefore,
      revisionAfterInsert,
      revisionAfter,
      preInsertStructureCallIdDigest: digestText(preInsertStructure.call.codexCallId),
      preInsertStructureResultDigest: preInsertStructure.call.actionResultDigest,
      preInsertStructureContentDigest,
      preInsertTemplateCallIdDigest: digestText(preInsertTemplate.call.codexCallId),
      preInsertTemplateResultDigest: preInsertTemplate.call.actionResultDigest,
      preInsertTemplateContentDigest: preInsertTemplateRead.contentDigest,
      templateStyleDigest: preInsertTemplateRead.styleDigest,
      insertCallIdDigest: digestText(insert.call.codexCallId),
      insertArgsDigest: insert.call.admissionArgsDigest,
      insertResultDigest: insert.call.actionResultDigest,
      postInsertInfoCallIdDigest: digestText(insertedInfo.call.codexCallId),
      postInsertInfoResultDigest: insertedInfo.call.actionResultDigest,
      postInsertInfoContentDigest: outputDigest(insertedInfo.call),
      postInsertRevisionCallIdDigest: digestText(insertedRevision.call.codexCallId),
      postInsertRevisionResultDigest: insertedRevision.call.actionResultDigest,
      postInsertRevisionContentDigest: outputDigest(insertedRevision.call),
      postInsertTemplateCallIdDigest: digestText(insertedTemplate.call.codexCallId),
      postInsertTemplateResultDigest: insertedTemplate.call.actionResultDigest,
      postInsertTemplateContentDigest: postInsertTemplateRead.contentDigest,
      writeCallIdDigest: digestText(write.call.codexCallId),
      writeArgsDigest: write.call.admissionArgsDigest,
      writeResultDigest: write.call.actionResultDigest,
      readbackCallIdDigest: digestText(readback.call.codexCallId),
      readbackResultDigest: readback.call.actionResultDigest,
      readbackContentDigest: outputDigest(readback.call),
    },
  }
}

function decodedVisibleXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_all, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/<[^>]+>/g, '')
}

function assertDocxRun(input) {
  const calls = input.calls.filter((call) => call.readyRunId === input.turn.readyRunId)
  calls.forEach((call) => assertActionCall(
    call, input.turn, input.toolResponseDigests.get(call.codexCallId),
  ))
  const shellCalls = calls.filter((call) => call.toolName === 'skill_run_shell')
  shellCalls.forEach((call) => assertCommandAuthority(call, input.cliIdentity))
  const commandRows = shellCalls.map((call, index) => ({
    call,
    index,
    path: commandPath(call),
    args: commandOf(call).args,
  }))
  assertAllowedCommandPaths(commandRows, new Set([
    'auth status', 'skills read', 'docs +fetch', 'docs +update',
  ]))
  const writes = commandRows.filter((row) => row.path === 'docs +update'
    && !hasFlag(row.args, '--dry-run'))
  assert(writes.length === 1, 'e6_user_scenario_docx_write_cardinality_invalid')
  const write = writes[0]
  const authRows = commandRows.filter((row) => row.path === 'auth status')
  const firstBusiness = commandRows.find((row) => row.path.startsWith('docs '))
  assert(firstBusiness, 'e6_user_scenario_skill_methodology_invalid')
  assertSkillMethodology(
    commandRows, 'lark-doc', firstBusiness.index, authRows, DOCX_REQUIRED_REFERENCES,
  )
  assertDryRunPreview(commandRows, write, 'e6_user_scenario_docx_preview_invalid')
  assertCommonLarkArgs(write.args, input.docxUrl, 'e6_user_scenario_docx_write_invalid')
  assert(exactOption(write.args, '--command', 'e6_user_scenario_docx_write_invalid') === 'str_replace'
    && (exactOption(write.args, '--doc-format', 'e6_user_scenario_docx_write_invalid', true)
      || 'xml') === 'xml',
  'e6_user_scenario_docx_write_invalid')
  const pattern = exactOption(write.args, '--pattern', 'e6_user_scenario_docx_write_invalid')
  const content = exactOption(write.args, '--content', 'e6_user_scenario_docx_write_invalid')
  const paragraph = /^<p>([^<>]*)<\/p>$/.exec(content.trim())
  assert(paragraph, 'e6_user_scenario_docx_write_invalid')
  const visibleContent = decodedVisibleXml(paragraph[1]).trim()
  const expectedContent = polishSentenceForE6(pattern.trim())
  assert(pattern.trim().length >= 12 && visibleContent.length >= 12
    && expectedContent && visibleContent === expectedContent
    && paragraph[1].trim() === visibleContent
    && /\p{Script=Han}/u.test(pattern)
    && /\p{Script=Han}/u.test(visibleContent)
    && !/[<>]/.test(pattern)
    && !pattern.includes(input.docxTaskMarker)
    && !visibleContent.includes(input.docxTaskMarker)
    && !/https?:\/\//i.test(pattern)
    && !/https?:\/\//i.test(visibleContent),
    'e6_user_scenario_docx_write_invalid')
  const reads = commandRows.filter((row) => row.path === 'docs +fetch')
  const before = reads.filter((row) => row.index < write.index).at(-1)
  const after = reads.find((row) => row.index > write.index)
  assert(before && after && authRows.length === 2
    && authRows[0].index < before.index && authRows[1].index > after.index,
  'e6_user_scenario_docx_readback_missing')
  assertCommonLarkArgs(before.args, input.docxUrl, 'e6_user_scenario_docx_read_invalid')
  assertCommonLarkArgs(after.args, input.docxUrl, 'e6_user_scenario_docx_read_invalid')
  const beforeJson = parseStdout(before.call)
  const afterJson = parseStdout(after.call)
  const documentToken = resourceTokenFromUrl(
    input.docxUrl, 'docx', 'e6_user_scenario_docx_identity_invalid',
  )
  assert(recursivelyContains(beforeJson, documentToken)
    && recursivelyContains(afterJson, documentToken),
  'e6_user_scenario_docx_identity_invalid')
  const revisionBefore = uniqueNumber(
    beforeJson, ['revision', 'revision_id', 'revisionId'], 'e6_user_scenario_revision_invalid',
  )
  const revisionAfter = uniqueNumber(
    afterJson, ['revision', 'revision_id', 'revisionId'], 'e6_user_scenario_revision_invalid',
  )
  const rawBefore = uniqueDocumentContent(
    beforeJson, 'e6_user_scenario_docx_readback_invalid',
  )
  const rawAfter = uniqueDocumentContent(
    afterJson, 'e6_user_scenario_docx_readback_invalid',
  )
  const sourceParagraph = `<p>${pattern}</p>`
  const replacementParagraph = `<p>${visibleContent}</p>`
  const expectedRawAfter = rawBefore.replace(sourceParagraph, replacementParagraph)
  const visibleBefore = decodedVisibleXml(rawBefore)
  const visibleAfter = decodedVisibleXml(rawAfter)
  const expectedVisibleAfter = visibleBefore.replace(pattern, visibleContent)
  assert(exactOption(write.args, '--revision-id', 'e6_user_scenario_docx_write_invalid')
    === String(revisionBefore), 'e6_user_scenario_docx_write_invalid')
  assert(revisionAfter > revisionBefore
    && occurrenceCount(beforeJson, `<title>${EXPECTED_DOCX_TITLE}</title>`) === 1
    && occurrenceCount(afterJson, `<title>${EXPECTED_DOCX_TITLE}</title>`) === 1
    && occurrenceCount(beforeJson, input.docxTaskMarker) === 0
    && occurrenceCount(afterJson, input.docxTaskMarker) === 0
    && occurrenceCount(beforeJson, pattern) === 1
    && occurrenceCount(beforeJson, visibleContent) === 0
    && occurrenceCount(afterJson, pattern) === 0
    && occurrenceCount(afterJson, visibleContent) === 1
    && rawBefore.split(sourceParagraph).length === 2
    && expectedRawAfter !== rawBefore
    && rawAfter === expectedRawAfter
    && expectedVisibleAfter !== visibleBefore
    && visibleAfter === expectedVisibleAfter,
  'e6_user_scenario_docx_readback_invalid')
  const confirmation = assertConfirmationForCall(input.confirmations, write.call)
  return {
    calls,
    callLedger: buildValidatedCallLedger(
      calls, commandRows, DOCX_LEDGER_ROLES, DOCX_REQUIRED_REFERENCES,
      'lark-doc', input.cliIdentity,
    ),
    authIdentities: authRows.map((row) => assertAuthStatus(row.call)),
    confirmations: [confirmation],
    evidence: {
      referenceDigest: digestJson(input.docxUrl),
      commandAuthorityBindingDigest: digestJson(shellCalls.map((call) => ({
        callIdDigest: digestText(call.codexCallId),
        authorityDigest: input.cliIdentity.authorityDigest,
      }))),
      taskMarkerDigest: digestJson(input.docxTaskMarker),
      originalSentenceDigest: digestJson(pattern),
      polishedSentenceDigest: digestJson(visibleContent),
      revisionBefore,
      revisionAfter,
      preReadCallIdDigest: digestText(before.call.codexCallId),
      preReadResultDigest: before.call.actionResultDigest,
      preReadContentDigest: outputDigest(before.call),
      writeCallIdDigest: digestText(write.call.codexCallId),
      writeArgsDigest: write.call.admissionArgsDigest,
      writeResultDigest: write.call.actionResultDigest,
      readbackCallIdDigest: digestText(after.call.codexCallId),
      readbackResultDigest: after.call.actionResultDigest,
      readbackContentDigest: outputDigest(after.call),
    },
  }
}

function assertGatewayCapture(input) {
  assert(Array.isArray(input.gatewayCapture) && input.gatewayCapture.length > 0,
    'e6_user_scenario_gateway_capture_invalid')
  const expectedSentinelDigests = [
    digestJson(input.sheetSentinel),
    digestJson(input.docxTaskMarker),
    digestJson(input.sheetUrl),
    digestJson(input.docxUrl),
  ]
  const groups = input.turns.map((turn) => input.gatewayCapture.filter(
    (capture) => capture.readyRunId === turn.readyRunId,
  ))
  assert(groups.every((group) => group.length > 0)
    && canonicalJson(groups.flat()) === canonicalJson(input.gatewayCapture)
    && new Set(input.gatewayCapture.map((row) => row.requestDigest)).size
      === input.gatewayCapture.length,
  'e6_user_scenario_gateway_capture_invalid')
  for (const [index, group] of groups.entries()) {
    const turn = input.turns[index]
    assert(group.every((capture) => capture.threadId === turn.codexThreadId
      && capture.turnId === turn.codexTurnId
      && capture.toolsDigest === turn.toolSurfaceDigest
      && canonicalJson([...capture.toolNames].sort())
        === canonicalJson([...ALLOWED_TOOLS].sort())
      && capture.readyResourceReferenceCount === 0
      && canonicalJson(capture.proofSentinels.map((row) => row.digest))
        === canonicalJson(expectedSentinelDigests)),
    'e6_user_scenario_gateway_binding_invalid')
    const occurrences = group.map((capture) => Object.fromEntries(
      capture.proofSentinels.map((row) => [row.digest, row.occurrences]),
    ))
    if (index === 0) {
      assert(occurrences.every((row) => row[expectedSentinelDigests[0]] >= 1
        && row[expectedSentinelDigests[2]] >= 1
        && row[expectedSentinelDigests[1]] === 0
        && row[expectedSentinelDigests[3]] === 0),
      'e6_user_scenario_gateway_sentinel_invalid')
    } else {
      assert(occurrences.every((row) => expectedSentinelDigests.every((digest) => row[digest] >= 1)),
        'e6_user_scenario_gateway_sentinel_invalid')
    }
  }
  return groups.map((group) => group.length)
}

function buildE6UserScenarioEvidenceBundle(input) {
  assert(input && typeof input === 'object'
    && input.sheetUrl === EXPECTED_SHEET_URL
    && input.docxUrl === EXPECTED_DOCX_URL
    && input.sheetUrl !== input.docxUrl
    && typeof input.sheetSentinel === 'string' && input.sheetSentinel.length >= 16
    && typeof input.docxTaskMarker === 'string' && input.docxTaskMarker.length >= 16,
  'e6_user_scenario_expectation_invalid')
  assert(sameKeys(input.cliIdentity, [
    'architecture', 'authorityDigest', 'autoInstallForbidden', 'launcherCount',
    'payloadSha256', 'version', 'wrapperExecutionForbidden',
  ]) && input.cliIdentity.version === 'lark-cli version 1.0.76'
    && input.cliIdentity.architecture === 'arm64'
    && input.cliIdentity.wrapperExecutionForbidden === true
    && input.cliIdentity.autoInstallForbidden === true
    && input.cliIdentity.launcherCount === 1
    && SHA256.test(input.cliIdentity.authorityDigest)
    && SHA256.test(input.cliIdentity.payloadSha256),
  'e6_user_scenario_cli_identity_invalid')
  const evidence = input.databaseEvidence
  assert(evidence.turns.length === 2 && evidence.calls.length > 0
    && evidence.providerSnapshots.length === 1
    && evidence.sidecarLeases.length >= 1,
  'e6_user_scenario_database_evidence_invalid')
  const [sheetTurn, docxTurn] = evidence.turns
  assert(sheetTurn.readyRunId === input.runIds[0] && docxTurn.readyRunId === input.runIds[1]
    && sheetTurn.scopeId === docxTurn.scopeId
    && sheetTurn.codexThreadId === docxTurn.codexThreadId
    && sheetTurn.toolSurfaceDigest === docxTurn.toolSurfaceDigest,
  'e6_user_scenario_run_continuity_invalid')
  const computedToolResponseDigests = mapReadyToolOutputDigests(
    evidence.calls.map((call) => call.actionResult),
  )
  const toolResponseDigests = new Map(evidence.calls.map((call, index) => (
    [call.codexCallId, computedToolResponseDigests[index]]
  )))
  assert(toolResponseDigests.size === evidence.calls.length,
    'e6_user_scenario_tool_response_invalid')
  const sheetCalls = evidence.calls.filter((call) => call.readyRunId === sheetTurn.readyRunId)
  const docxCalls = evidence.calls.filter((call) => call.readyRunId === docxTurn.readyRunId)
  const runs = [
    assertTurn(sheetTurn, 'sheet', sheetCalls),
    assertTurn(docxTurn, 'docx', docxCalls),
  ]
  for (const turn of evidence.turns) {
    const expectedReceiptRefs = evidence.calls
      .filter((call) => call.readyRunId === turn.readyRunId)
      .map((call) => call.bindingReceiptId)
      .sort()
    assert(canonicalJson(turn.publicationReceiptRefs) === canonicalJson(expectedReceiptRefs)
      && turn.publicationReceiptDigest === digestJson({
        readyRunId: turn.readyRunId,
        engineTerminalCandidateDigest: turn.engineTerminalCandidateDigest,
        verifiedReceiptRefs: expectedReceiptRefs,
      }),
    'e6_user_scenario_publication_receipt_invalid')
  }
  const providerIdentity = assertProviderEvidence(evidence, input.providerExpectation)
  const sheet = assertSheetRun({
    calls: evidence.calls,
    confirmations: evidence.confirmations,
    turn: sheetTurn,
    sheetUrl: input.sheetUrl,
    sheetSentinel: input.sheetSentinel,
    cliIdentity: input.cliIdentity,
    toolResponseDigests,
  })
  const docx = assertDocxRun({
    calls: evidence.calls,
    confirmations: evidence.confirmations,
    turn: docxTurn,
    docxUrl: input.docxUrl,
    docxTaskMarker: input.docxTaskMarker,
    cliIdentity: input.cliIdentity,
    toolResponseDigests,
  })
  const confirmations = [...sheet.confirmations, ...docx.confirmations]
  const authIdentities = [...sheet.authIdentities, ...docx.authIdentities]
  assert(authIdentities.length === 3
    && authIdentities.every((identity) => canonicalJson(identity) === canonicalJson(authIdentities[0])),
  'e6_user_scenario_auth_identity_drift')
  assert(evidence.confirmations.length === 3
    && new Set(confirmations.map((row) => row.idDigest)).size === 3
    && new Set(confirmations.map((row) => row.argsDigest)).size === 3,
  'e6_user_scenario_confirmation_cardinality_invalid')
  const providerRequestCounts = assertGatewayCapture({
    ...input,
    turns: evidence.turns,
  })
  assert(evidence.gatewayRequests.length === input.gatewayCapture.length,
    'e6_user_scenario_gateway_receipt_invalid')
  for (const capture of input.gatewayCapture) {
    const rows = evidence.gatewayRequests.filter((row) => row.readyRunId === capture.readyRunId
      && row.requestDigest === capture.requestDigest)
    assert(rows.length === 1 && rows[0].inputDigest === capture.inputDigest
      && rows[0].toolsDigest === capture.toolsDigest
      && SHA256.test(rows[0].responseTerminalDigest)
      && SHA256.test(rows[0].responseOutputDigest)
      && SHA256.test(rows[0].responseUsageDigest),
    'e6_user_scenario_gateway_receipt_invalid')
  }
  assert(input.sidecarRuntimeExpectation && input.mainProcessExpectation
    && evidence.sidecarLeases.every((lease) => lease.closedAt && lease.treeZeroAt
      && SHA256.test(lease.treeZeroEvidenceDigest)
      && Number.isSafeInteger(lease.pid) && lease.pid > 1
      && lease.processGroupId === lease.pid
      && typeof lease.processStartIdentity === 'string' && lease.processStartIdentity.length > 0
      && lease.runtimeManifestDigest
        === input.sidecarRuntimeExpectation.runtimeManifestDigest
      && lease.binarySha256 === input.sidecarRuntimeExpectation.binarySha256
      && lease.executablePath === input.sidecarRuntimeExpectation.executablePath
      && lease.ownerMainPid === input.mainProcessExpectation.pid
      && lease.ownerMainProcessStartIdentity
        === input.mainProcessExpectation.processStartIdentity),
  'e6_user_scenario_sidecar_lease_invalid')
  const summary = {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: PROOF_MODE,
    runCount: 2,
    toolCallCount: evidence.calls.length,
    providerRequestCount: input.gatewayCapture.length,
    confirmationCount: confirmations.length,
    runtimeManifestDigest: input.runtimeManifestDigest,
    protocolSchemaDigest: input.protocolSchemaDigest,
    cliIdentity: input.cliIdentity,
    cliAuthIdentity: authIdentities[0],
    providerIdentity,
    runs: runs.map((run, index) => ({
      ...run,
      toolCallCount: evidence.calls.filter((call) => call.readyRunId === input.runIds[index]).length,
      providerRequestCount: providerRequestCounts[index],
    })),
    resources: {
      sheet: sheet.evidence,
      docx: docx.evidence,
    },
    confirmations,
    sidecarLeaseCount: evidence.sidecarLeases.length,
  }
  const relationalLedgerUnsigned = {
    schemaVersion: 1,
    phase: 'E6',
    proofMode: PROOF_MODE,
    evidenceDigest: digestJson(summary),
    cliIdentityDigest: digestJson(input.cliIdentity),
    authIdentityDigest: digestJson(summary.cliAuthIdentity),
    providerSnapshotDigest: summary.providerIdentity.snapshotDigest,
    turns: evidence.turns.map((turn, index) => ({
      kind: index === 0 ? 'sheet' : 'docx',
      readyRunIdDigest: digestJson(turn.readyRunId),
      scopeIdDigest: digestText(turn.scopeId),
      threadIdDigest: digestJson(turn.codexThreadId),
      turnIdDigest: digestJson(turn.codexTurnId),
      toolSurfaceDigest: turn.toolSurfaceDigest,
      authorizationSnapshotDigest: turn.authorizationSnapshotDigest,
      engineTerminalCandidateDigest: turn.engineTerminalCandidateDigest,
      terminal: {
        candidateTextDigest: turn.engineTerminalCandidate.candidateDigest,
        engineOutcome: turn.engineTerminalCandidate.engineOutcome,
        usedToolCalls: turn.engineTerminalCandidate.usedToolCalls.map((call) => ({
          callIdDigest: digestText(call.itemId),
          toolName: call.tool,
          status: call.status,
          success: call.success,
          responseDigest: call.responseDigest,
        })),
      },
      productTerminalDigest: turn.productTerminalDigest,
      publicationReceiptDigest: turn.publicationReceiptDigest,
      publicationReceiptRefsDigest: digestJson(turn.publicationReceiptRefs),
      calls: index === 0 ? sheet.callLedger : docx.callLedger,
    })),
    confirmations: evidence.confirmations.map((confirmation) => ({
      idDigest: digestText(confirmation.id),
      readyRunIdDigest: digestJson(confirmation.readyRunId),
      scopeIdDigest: digestText(confirmation.scopeId),
      argsDigest: confirmation.audit.canonicalSha256,
      createdAtDigest: digestText(confirmation.createdAt),
      releasedAtDigest: digestText(confirmation.releasedAt),
    })),
    gatewayReceipts: evidence.gatewayRequests.map((request) => ({
      readyRunIdDigest: digestJson(request.readyRunId),
      receiptIdDigest: digestText(request.receiptId),
      requestDigest: request.requestDigest,
      inputDigest: request.inputDigest,
      toolsDigest: request.toolsDigest,
      upstreamProfileSnapshotRefDigest: digestText(request.upstreamProfileSnapshotRef),
      upstreamProfileSnapshotDigest: request.upstreamProfileSnapshotDigest,
      responseTerminalDigest: request.responseTerminalDigest,
      responseOutputDigest: request.responseOutputDigest,
      responseUsageDigest: request.responseUsageDigest,
    })),
    sidecarLeases: evidence.sidecarLeases.map((lease) => ({
      processLeaseIdDigest: digestText(lease.processLeaseId),
      pid: lease.pid,
      processGroupId: lease.processGroupId,
      processStartIdentityDigest: digestText(lease.processStartIdentity),
      runtimeManifestDigest: lease.runtimeManifestDigest,
      binarySha256: lease.binarySha256,
      executablePathDigest: digestText(lease.executablePath),
      ownerMainPid: lease.ownerMainPid,
      ownerMainProcessStartIdentityDigest: digestText(
        lease.ownerMainProcessStartIdentity,
      ),
      closedAt: lease.closedAt,
      treeZeroAt: lease.treeZeroAt,
      treeZeroEvidenceDigest: lease.treeZeroEvidenceDigest,
    })),
  }
  const relationalLedger = {
    ...relationalLedgerUnsigned,
    ledgerDigest: digestJson(relationalLedgerUnsigned),
  }
  assertE6UserScenarioRelationalLedger(relationalLedger, summary, input.gatewayCapture)
  return { evidence: summary, relationalLedger }
}

function assertE6UserScenarioRelationalLedger(ledger, evidence, gatewayCapture) {
  assert(sameKeys(ledger, [
    'authIdentityDigest', 'cliIdentityDigest', 'confirmations', 'evidenceDigest',
    'gatewayReceipts', 'ledgerDigest', 'phase', 'proofMode', 'providerSnapshotDigest',
    'schemaVersion', 'sidecarLeases', 'turns',
  ]) && ledger.schemaVersion === 1 && ledger.phase === 'E6'
    && ledger.proofMode === PROOF_MODE
    && ledger.evidenceDigest === digestJson(evidence)
    && ledger.cliIdentityDigest === digestJson(evidence.cliIdentity)
    && ledger.authIdentityDigest === digestJson(evidence.cliAuthIdentity)
    && ledger.providerSnapshotDigest === evidence.providerIdentity.snapshotDigest
    && Array.isArray(ledger.turns) && ledger.turns.length === 2
    && Array.isArray(ledger.confirmations) && ledger.confirmations.length === 3
    && Array.isArray(ledger.gatewayReceipts)
    && Array.isArray(ledger.sidecarLeases)
    && ledger.sidecarLeases.length === evidence.sidecarLeaseCount,
  'e6_user_scenario_relational_ledger_invalid')
  const unsigned = { ...ledger }
  delete unsigned.ledgerDigest
  assert(ledger.ledgerDigest === digestJson(unsigned),
    'e6_user_scenario_relational_ledger_invalid')

  const sidecarKeys = [
    'binarySha256', 'closedAt', 'executablePathDigest', 'ownerMainPid',
    'ownerMainProcessStartIdentityDigest', 'pid', 'processGroupId',
    'processLeaseIdDigest', 'processStartIdentityDigest', 'runtimeManifestDigest',
    'treeZeroAt', 'treeZeroEvidenceDigest',
  ]
  assert(ledger.sidecarLeases.every((lease) => sameKeys(lease, sidecarKeys)
      && Number.isSafeInteger(lease.pid) && lease.pid > 1
      && lease.processGroupId === lease.pid
      && Number.isSafeInteger(lease.ownerMainPid) && lease.ownerMainPid > 1
      && [lease.processLeaseIdDigest, lease.processStartIdentityDigest,
        lease.runtimeManifestDigest, lease.binarySha256, lease.executablePathDigest,
        lease.ownerMainProcessStartIdentityDigest,
        lease.treeZeroEvidenceDigest].every((digest) => SHA256.test(digest))
      && lease.runtimeManifestDigest === evidence.runtimeManifestDigest
      && typeof lease.closedAt === 'string' && !Number.isNaN(Date.parse(lease.closedAt))
      && typeof lease.treeZeroAt === 'string' && !Number.isNaN(Date.parse(lease.treeZeroAt))
      && Date.parse(lease.treeZeroAt) >= Date.parse(lease.closedAt))
    && new Set(ledger.sidecarLeases.map((lease) => lease.ownerMainPid)).size === 1
    && new Set(ledger.sidecarLeases.map(
      (lease) => lease.ownerMainProcessStartIdentityDigest,
    )).size === 1,
  'e6_user_scenario_relational_ledger_sidecar_invalid')

  const callKeys = [
    'actionIdentityDigest', 'actionUpdatedAtDigest', 'admittedAtDigest', 'argsDigest',
    'bindingReceiptIdDigest', 'callIdDigest', 'commandArgsDigest',
    'commandAuthorityDigest', 'gatewayRequestReceiptIdDigest', 'ordinal', 'outputDigest',
    'methodologyReference', 'readyRunIdDigest', 'resultDigest', 'role', 'shellOrdinal', 'toolName',
    'toolResponseDigest',
  ]
  const expectedRoles = [SHEET_LEDGER_ROLES, DOCX_LEDGER_ROLES]
  for (const [index, turn] of ledger.turns.entries()) {
    const summary = evidence.runs[index]
    assert(sameKeys(turn, [
      'authorizationSnapshotDigest', 'calls', 'engineTerminalCandidateDigest', 'kind',
      'productTerminalDigest', 'publicationReceiptDigest', 'publicationReceiptRefsDigest',
      'readyRunIdDigest', 'scopeIdDigest', 'terminal', 'threadIdDigest', 'toolSurfaceDigest',
      'turnIdDigest',
    ]) && turn.kind === summary.kind
      && turn.readyRunIdDigest === summary.readyRunIdDigest
      && turn.scopeIdDigest === summary.scopeIdDigest
      && turn.threadIdDigest === summary.threadIdDigest
      && turn.turnIdDigest === summary.turnIdDigest
      && turn.toolSurfaceDigest === summary.toolSurfaceDigest
      && turn.authorizationSnapshotDigest === summary.authorizationSnapshotDigest
      && turn.publicationReceiptDigest === summary.publicationReceiptDigest
      && SHA256.test(turn.engineTerminalCandidateDigest)
      && SHA256.test(turn.productTerminalDigest)
      && SHA256.test(turn.publicationReceiptRefsDigest)
      && Array.isArray(turn.calls) && turn.calls.length === summary.toolCallCount,
    'e6_user_scenario_relational_ledger_turn_invalid')
    assert(sameKeys(turn.terminal, [
      'candidateTextDigest', 'engineOutcome', 'usedToolCalls',
    ]) && turn.terminal.engineOutcome === 'completed'
      && SHA256.test(turn.terminal.candidateTextDigest)
      && Array.isArray(turn.terminal.usedToolCalls)
      && turn.terminal.usedToolCalls.length === turn.calls.length
      && new Set(turn.terminal.usedToolCalls.map((call) => call.callIdDigest)).size
        === turn.calls.length
      && turn.calls.every((call) => turn.terminal.usedToolCalls.filter((used) => (
        sameKeys(used, ['callIdDigest', 'responseDigest', 'status', 'success', 'toolName'])
        && used.callIdDigest === call.callIdDigest
        && used.toolName === call.toolName
        && used.status === 'completed'
        && used.success === true
        && used.responseDigest === call.toolResponseDigest
      )).length === 1),
    'e6_user_scenario_relational_ledger_terminal_invalid')
    for (const [ordinal, call] of turn.calls.entries()) {
      assert(sameKeys(call, callKeys) && call.ordinal === ordinal
        && typeof call.role === 'string' && call.role.length > 0
        && call.readyRunIdDigest === turn.readyRunIdDigest
        && ALLOWED_TOOLS.includes(call.toolName)
        && [call.actionIdentityDigest, call.actionUpdatedAtDigest, call.admittedAtDigest,
          call.argsDigest, call.bindingReceiptIdDigest, call.callIdDigest,
          call.gatewayRequestReceiptIdDigest, call.resultDigest,
          call.toolResponseDigest].every((digest) => SHA256.test(digest))
        && (call.toolName === 'skill_run_shell'
          ? Number.isSafeInteger(call.shellOrdinal)
            && SHA256.test(call.commandArgsDigest)
            && SHA256.test(call.outputDigest)
            && call.commandAuthorityDigest === evidence.cliIdentity.authorityDigest
            && (call.role === 'skills_reference'
              ? typeof call.methodologyReference === 'string'
                && call.methodologyReference.startsWith(
                  index === 0 ? 'references/lark-sheets-' : 'references/',
                )
                && !call.methodologyReference.includes('..')
              : call.methodologyReference === null)
          : call.shellOrdinal === null && call.role === 'non_shell'
            && call.commandArgsDigest === null && call.commandAuthorityDigest === null
            && call.outputDigest === null && call.methodologyReference === null),
      'e6_user_scenario_relational_ledger_call_invalid')
    }
    const shellCalls = turn.calls.filter((call) => call.toolName === 'skill_run_shell')
      .sort((left, right) => left.shellOrdinal - right.shellOrdinal)
    const baseCalls = shellCalls.filter((call) => call.role !== 'skills_reference')
    const referenceCalls = shellCalls.filter((call) => call.role === 'skills_reference')
    const requiredReferences = index === 0 ? SHEET_REQUIRED_REFERENCES : DOCX_REQUIRED_REFERENCES
    assert(shellCalls.every((call, shellOrdinal) => call.shellOrdinal === shellOrdinal)
      && baseCalls.length === expectedRoles[index].length
      && baseCalls.every((call, baseOrdinal) => (
        call.role === expectedRoles[index][baseOrdinal][0]
      ))
      && referenceCalls.every((call) => (
        call.shellOrdinal > shellCalls.find((candidate) => candidate.role === 'skills_domain').shellOrdinal
        && call.shellOrdinal < shellCalls.find((candidate) => candidate.role === expectedRoles[index][3][0]).shellOrdinal
      ))
      && new Set(referenceCalls.map((call) => call.methodologyReference)).size
        === referenceCalls.length
      && requiredReferences.every((reference) => referenceCalls.some(
        (call) => call.methodologyReference === reference,
      )), 'e6_user_scenario_relational_ledger_call_invalid')
  }
  const allCalls = ledger.turns.flatMap((turn) => turn.calls)
  assert(allCalls.length === evidence.toolCallCount
    && new Set(allCalls.map((call) => call.callIdDigest)).size === allCalls.length
    && new Set(allCalls.map((call) => call.bindingReceiptIdDigest)).size === allCalls.length,
  'e6_user_scenario_relational_ledger_call_invalid')

  const sortedConfirmations = ledger.confirmations.map((confirmation) => {
    assert(sameKeys(confirmation, [
      'argsDigest', 'createdAtDigest', 'idDigest', 'readyRunIdDigest', 'releasedAtDigest',
      'scopeIdDigest',
    ]) && [confirmation.argsDigest, confirmation.createdAtDigest, confirmation.idDigest,
      confirmation.readyRunIdDigest, confirmation.releasedAtDigest,
      confirmation.scopeIdDigest].every((digest) => SHA256.test(digest)),
    'e6_user_scenario_relational_ledger_confirmation_invalid')
    return {
      argsDigest: confirmation.argsDigest,
      idDigest: confirmation.idDigest,
      releasedAtDigest: confirmation.releasedAtDigest,
    }
  }).sort((left, right) => left.idDigest.localeCompare(right.idDigest))
  assert(canonicalJson(sortedConfirmations) === canonicalJson(
    evidence.confirmations.map((row) => ({ ...row }))
      .sort((left, right) => left.idDigest.localeCompare(right.idDigest)),
  ), 'e6_user_scenario_relational_ledger_confirmation_invalid')

  const sheetShellCalls = ledger.turns[0].calls
    .filter((call) => call.toolName === 'skill_run_shell')
    .sort((left, right) => left.shellOrdinal - right.shellOrdinal)
  const docxShellCalls = ledger.turns[1].calls
    .filter((call) => call.toolName === 'skill_run_shell')
    .sort((left, right) => left.shellOrdinal - right.shellOrdinal)
  const sheetCalls = Object.fromEntries(sheetShellCalls.map((call) => [call.role, call]))
  const docxCalls = Object.fromEntries(docxShellCalls.map((call) => [call.role, call]))
  const sheet = evidence.resources.sheet
  const docx = evidence.resources.docx
  assert(sheetCalls.pre_insert_structure.callIdDigest === sheet.preInsertStructureCallIdDigest
    && sheetCalls.pre_insert_structure.resultDigest === sheet.preInsertStructureResultDigest
    && sheetCalls.pre_insert_structure.outputDigest === sheet.preInsertStructureContentDigest
    && sheetCalls.pre_insert_template.callIdDigest === sheet.preInsertTemplateCallIdDigest
    && sheetCalls.pre_insert_template.resultDigest === sheet.preInsertTemplateResultDigest
    && sheetCalls.pre_insert_template.outputDigest === sheet.preInsertTemplateContentDigest
    && SHA256.test(sheet.templateStyleDigest)
    && sheetCalls.insert.callIdDigest === sheet.insertCallIdDigest
    && sheet.commandAuthorityBindingDigest === digestJson(
      sheetShellCalls.map((call) => ({
        callIdDigest: call.callIdDigest,
        authorityDigest: call.commandAuthorityDigest,
      })),
    )
    && sheetCalls.insert.argsDigest === sheet.insertArgsDigest
    && sheetCalls.insert.resultDigest === sheet.insertResultDigest
    && sheetCalls.post_insert_info.callIdDigest === sheet.postInsertInfoCallIdDigest
    && sheetCalls.post_insert_info.resultDigest === sheet.postInsertInfoResultDigest
    && sheetCalls.post_insert_info.outputDigest === sheet.postInsertInfoContentDigest
    && sheetCalls.post_insert_revision.callIdDigest === sheet.postInsertRevisionCallIdDigest
    && sheetCalls.post_insert_revision.resultDigest === sheet.postInsertRevisionResultDigest
    && sheetCalls.post_insert_revision.outputDigest === sheet.postInsertRevisionContentDigest
    && sheetCalls.post_insert_template.callIdDigest === sheet.postInsertTemplateCallIdDigest
    && sheetCalls.post_insert_template.resultDigest === sheet.postInsertTemplateResultDigest
    && sheetCalls.post_insert_template.outputDigest === sheet.postInsertTemplateContentDigest
    && sheetCalls.write.callIdDigest === sheet.writeCallIdDigest
    && sheetCalls.write.argsDigest === sheet.writeArgsDigest
    && sheetCalls.write.resultDigest === sheet.writeResultDigest
    && sheetCalls.readback.callIdDigest === sheet.readbackCallIdDigest
    && sheetCalls.readback.resultDigest === sheet.readbackResultDigest
    && sheetCalls.readback.outputDigest === sheet.readbackContentDigest
    && docxCalls.pre_read.callIdDigest === docx.preReadCallIdDigest
    && docx.commandAuthorityBindingDigest === digestJson(
      docxShellCalls.map((call) => ({
        callIdDigest: call.callIdDigest,
        authorityDigest: call.commandAuthorityDigest,
      })),
    )
    && docxCalls.pre_read.resultDigest === docx.preReadResultDigest
    && docxCalls.pre_read.outputDigest === docx.preReadContentDigest
    && docxCalls.write.callIdDigest === docx.writeCallIdDigest
    && docxCalls.write.argsDigest === docx.writeArgsDigest
    && docxCalls.write.resultDigest === docx.writeResultDigest
    && docxCalls.readback.callIdDigest === docx.readbackCallIdDigest
    && docxCalls.readback.resultDigest === docx.readbackResultDigest
    && docxCalls.readback.outputDigest === docx.readbackContentDigest,
  'e6_user_scenario_relational_ledger_resource_invalid')
  const formalCalls = [
    { call: sheetCalls.insert, turn: ledger.turns[0] },
    { call: sheetCalls.write, turn: ledger.turns[0] },
    { call: docxCalls.write, turn: ledger.turns[1] },
  ]
  assert(new Set(formalCalls.map((row) => row.call.argsDigest)).size === 3
    && formalCalls.every(({ call, turn }) => {
      const matches = ledger.confirmations.filter((row) => row.argsDigest === call.argsDigest)
      return matches.length === 1
        && matches[0].readyRunIdDigest === turn.readyRunIdDigest
        && matches[0].scopeIdDigest === turn.scopeIdDigest
    }),
  'e6_user_scenario_relational_ledger_confirmation_invalid')

  assert(Array.isArray(gatewayCapture)
    && ledger.gatewayReceipts.length === gatewayCapture.length
    && new Set(ledger.gatewayReceipts.map((row) => row.receiptIdDigest)).size
      === ledger.gatewayReceipts.length
    && new Set(ledger.gatewayReceipts.map((row) => row.requestDigest)).size
      === ledger.gatewayReceipts.length
    && new Set(gatewayCapture.map((row) => row.requestDigest)).size === gatewayCapture.length
    && ledger.gatewayReceipts.every((receipt) => sameKeys(receipt, [
      'inputDigest', 'readyRunIdDigest', 'receiptIdDigest', 'requestDigest',
      'responseOutputDigest', 'responseTerminalDigest', 'responseUsageDigest', 'toolsDigest',
      'upstreamProfileSnapshotDigest', 'upstreamProfileSnapshotRefDigest',
    ]) && [receipt.inputDigest, receipt.readyRunIdDigest, receipt.receiptIdDigest,
      receipt.requestDigest, receipt.responseOutputDigest, receipt.responseTerminalDigest,
      receipt.responseUsageDigest, receipt.toolsDigest, receipt.upstreamProfileSnapshotDigest,
      receipt.upstreamProfileSnapshotRefDigest].every((digest) => SHA256.test(digest))
      && receipt.upstreamProfileSnapshotDigest === ledger.providerSnapshotDigest
      && gatewayCapture.filter((capture) => (
        digestJson(capture.readyRunId) === receipt.readyRunIdDigest
        && capture.requestDigest === receipt.requestDigest
        && capture.inputDigest === receipt.inputDigest
        && capture.toolsDigest === receipt.toolsDigest
      )).length === 1)
    && gatewayCapture.every((capture) => ledger.gatewayReceipts.filter((receipt) => (
      digestJson(capture.readyRunId) === receipt.readyRunIdDigest
      && capture.requestDigest === receipt.requestDigest
      && capture.inputDigest === receipt.inputDigest
      && capture.toolsDigest === receipt.toolsDigest
    )).length === 1)
    && ledger.turns.every((turn, index) => ledger.gatewayReceipts.filter((receipt) => (
      receipt.readyRunIdDigest === turn.readyRunIdDigest
    )).length === evidence.runs[index].providerRequestCount)
    && allCalls.every((call) => ledger.gatewayReceipts.some((receipt) => (
      receipt.readyRunIdDigest === call.readyRunIdDigest
      && receipt.receiptIdDigest === call.gatewayRequestReceiptIdDigest
    ))),
  'e6_user_scenario_relational_ledger_gateway_invalid')
  return ledger
}

function assertE6UserScenarioEvidence(input) {
  return buildE6UserScenarioEvidenceBundle(input).evidence
}

module.exports = {
  ALLOWED_TOOLS,
  PROOF_MODE,
  assertE6UserScenarioEvidence,
  assertE6UserScenarioRelationalLedger,
  buildE6UserScenarioEvidenceBundle,
  readE6UserScenarioDatabase,
  projectSafeAuthStatus,
}
