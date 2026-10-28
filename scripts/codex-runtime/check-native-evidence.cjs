const path = require('node:path')
const {
  assert,
  assetRoot,
  readJson
} = require('./contract-lib.cjs')

const mode = process.argv[2]
const contracts = readJson(path.join(assetRoot, 'contracts/runtime-contracts.json'))
const applicationCapture = readJson(
  path.join(assetRoot, 'fixtures/native-protocol-capture-application-context.json')
)
const untrustedCapture = readJson(
  path.join(assetRoot, 'fixtures/native-protocol-capture.json')
)

function turnMetadata(request) {
  const raw = request.summary.clientMetadata?.['x-codex-turn-metadata']
  return raw ? JSON.parse(raw) : {}
}

function assertCommon(capture) {
  const threadStartIdentity = contracts.turnClientIdentityExtractionContract?.thread_start
  const pinnedSource = threadStartIdentity?.pinnedAppServerSource
  assert(typeof pinnedSource === 'string' && pinnedSource.length > 0, 'pinned_thread_source_missing')
  assert(
    JSON.stringify(threadStartIdentity.threadListSourceKinds) === JSON.stringify([pinnedSource]),
    'thread_list_source_contract_mismatch'
  )
  assert(capture.runtime.releaseTag === 'rust-v0.160.1', 'unexpected_release_tag')
  // 0.160.1 creates every new thread with paginated history storage; Ready reads complete turns through thread/read.
  assert(capture.threads.first.historyMode === 'paginated', 'first_thread_history_mode_changed')
  assert(capture.threads.second.historyMode === 'paginated', 'second_thread_history_mode_changed')
  assert(capture.threads.resume.thread.historyMode === 'paginated', 'resumed_thread_history_mode_changed')
  assert(capture.invariants.providerAuthorizationPresent, 'provider_authorization_missing')
  assert(capture.invariants.providerAuthorizationValueNotStored, 'provider_token_stored')
  assert(capture.invariants.appServerStderrDoesNotContainGatewayToken, 'provider_token_in_stderr')
  assert(capture.invariants.nativeBaseInstructionsPresent, 'native_base_instructions_missing')
  assert(capture.invariants.userClientIdReadback, 'user_client_id_not_read_back')
  assert(capture.threads.first.source === pinnedSource, 'unexpected_thread_source')
  assert(capture.threads.instructionSourcesEmpty, 'instruction_source_discovered')
  assert(capture.threads.rootMetadataValid, 'root_thread_metadata_invalid')
  assert(capture.threads.list.data.length === 1, 'thread_list_identity_not_unique')
  assert(capture.threads.list.data[0].id === capture.threads.first.id, 'thread_list_identity_mismatch')
  assert(capture.threads.list.data[0].source === pinnedSource, 'thread_list_source_mismatch')
}

function checkProtocol() {
  assertCommon(applicationCapture)
  assertCommon(untrustedCapture)
  assert(applicationCapture.runtime.resourceContextKind === 'application', 'application_fixture_kind_mismatch')
  assert(untrustedCapture.runtime.resourceContextKind === 'untrusted', 'untrusted_fixture_kind_mismatch')
  for (const capture of [applicationCapture, untrustedCapture]) {
    assert(
      capture.invariants.resourceV2DoesNotRetainResourceV1InCurrentContext === false,
      `codex_additional_context_history_missing:${capture.runtime.resourceContextKind}`
    )
  }
}

function checkToolSurface() {
  assertCommon(untrustedCapture)
  for (const request of untrustedCapture.provider.requests) {
    const requestKind = turnMetadata(request).request_kind
    const expected = requestKind === 'compaction' ? [] : ['ready_read_probe']
    assert(
      JSON.stringify(request.summary.toolNames) === JSON.stringify(expected),
      `unexpected_provider_tool_surface:${request.sequence}`
    )
  }
  assert(untrustedCapture.appServer.dynamicToolServerRequests.length === 1, 'dynamic_tool_roundtrip_not_exactly_once')
  console.log('Codex E0 tool-surface evidence PASS')
}

function checkResponseSurface() {
  assertCommon(untrustedCapture)
  const frames = untrustedCapture.appServer.frames
  const deltas = new Map()
  for (const frame of frames) {
    if (frame.method !== 'item/agentMessage/delta') continue
    const current = deltas.get(frame.params.itemId) || ''
    deltas.set(frame.params.itemId, current + frame.params.delta)
  }
  const completed = frames
    .filter((frame) => frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage')
    .map((frame) => frame.params.item)
  assert(completed.some((item) => item.phase === 'commentary'), 'commentary_phase_not_observed')
  assert(completed.some((item) => item.phase === 'final_answer'), 'final_answer_phase_not_observed')
  for (const item of completed) {
    assert(['commentary', 'final_answer', null].includes(item.phase), `unknown_agent_message_phase:${item.phase}`)
    if (deltas.has(item.id)) {
      assert(deltas.get(item.id) === item.text, `agent_message_delta_completed_mismatch:${item.id}`)
    }
  }
  console.log('Codex E0 response-surface evidence PASS')
}

function checkChildEnv() {
  assertCommon(untrustedCapture)
  assert(
    JSON.stringify(untrustedCapture.childEnvironment.keys) ===
      JSON.stringify(contracts.childEnvAllowlist.allowedKeys),
    'child_environment_key_mismatch'
  )
  assert(!untrustedCapture.childEnvironment.hostCanaryPresent, 'host_canary_in_spawn_environment')
  assert(
    untrustedCapture.childEnvironment.observedProcessEnvironmentDigest,
    'codex_child_environment_process_readback_not_recorded'
  )
}

function checkCompaction() {
  assertCommon(untrustedCapture)
  assert(untrustedCapture.invariants.manualCompactionObserved, 'manual_compaction_not_observed')
  const compactRequests = untrustedCapture.provider.requests.filter(
    (request) => turnMetadata(request).request_kind === 'compaction'
  )
  assert(compactRequests.length === 1, 'manual_compaction_request_count_mismatch')
  assert(compactRequests[0].summary.toolNames.length === 0, 'manual_compaction_tools_not_empty')
}

const checks = {
  protocol: checkProtocol,
  'tool-surface': checkToolSurface,
  'response-surface': checkResponseSurface,
  'child-env': checkChildEnv,
  compaction: checkCompaction
}

assert(checks[mode], `unknown_check_mode:${mode || 'missing'}`)
checks[mode]()
