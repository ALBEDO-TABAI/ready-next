import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'
import { openProviderCheckpointTestDb, providerCheckpointExecutionBinding } from './provider-checkpoint-test-fixtures'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { createCodexProductionPorts } from './helpers/codex-production-composition-harness'
import { makeProductTurnActionProjection } from './product-turn-action-projection-fixture'
import { CodexProductRunPreparer, type PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { CodexBindingRepositoryError } from '../main/modules/agent-control/codex-runtime/codex-binding-error'
import { CodexStartIdentityRegistry } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import { CodexModelGatewayRepository } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { digestCodexUserInput } from '../main/modules/agent-control/codex-runtime/codex-user-input'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { buildReadyTurnToolAuthorization } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { resourceReferenceForAnchor } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { ReadyMemoryRepository } from '../main/modules/agent-control/ready-memory/ready-memory-repository'
import { preflightExplicitRetryControl } from '../main/modules/agent-control/codex-runtime/codex-explicit-retry-control'
import { runConfirmedSendScoped } from '../main/modules/agent-control/send-scoped-confirmation'
import type { CodexRuntimeComposition } from '../main/modules/agent-control/codex-runtime/codex-runtime-composition'
import type { SendScopedRequest, CodexCurrentDocumentAnchor } from '../shared/ipc-contracts/agent-runtime'

// The exact production closures execute; these tests do not claim sidecar boot or installed IPC proof.
// Source/history port fixtures are separate from the native repository coverage/lineage tests.
export const __breaksInvariants = [
  'codex.production-startup-replaced-by-exact-ingress-and-release-closures',
  'codex.source-history-port-fixture-with-real-prepared-input-and-head-projector',
] as const
function production(dependencies: Record<string, unknown>) {
  return createCodexProductionPorts(dependencies)
}
const at = '2026-09-03T00:00:00.000Z'
const anchor: CodexCurrentDocumentAnchor = {
  kind: 'current_document', logicalResourceId: 'ready-current-document:scope:doc', tabId: 'doc', title: 'Current', pane: 'primary',
  pathDigest: 'b'.repeat(64), incarnationKey: 'c'.repeat(64), currentVersion: `sha256:${'a'.repeat(64)}`,
  currentDigest: 'a'.repeat(64), supersedesVersion: null, policyEpoch: 1,
  readScope: { operation: 'read_section', maxChars: 30_000 },
}
type Scenario = {
  mode: 'document' | 'browser'
  text?: string
  anchor?: CodexCurrentDocumentAnchor
  page?: object
  sourceAnchor?: boolean
  atomicContinuationDrift?: boolean
  profileRouteDriftAfterPrepare?: boolean
}
async function fixture(scenario: Scenario) {
  const db = openProviderCheckpointTestDb()
  const output = mkdtempSync(join(tmpdir(), 'ready-retry-production-handoff-'))
  db.prepare(`INSERT INTO chat_conversations (id, agent, source_kind, source_id, thread_key, created_at, updated_at)
    VALUES ('scope', 'butler', 'local', 'app', 'scope', ?, ?)`).run(at, at)
  const scope = { id: 'scope', aliasGeneration: 2, messageVisibilityEpoch: 0, agent: 'butler', activeAgentId: 'butler', sourceKind: 'local', meta: {} }
  const headFacts = { scopeId: 'scope', scopeEpoch: 0, aliasId: 'scope', aliasGeneration: 2,
    threadBindingId: 'head', headRevision: 1, actionProjectionSequence: 1, materializationKind: 'fresh_root_with_tail' as const,
    materializationState: 'confirmed' as const, codexThreadId: null, continuationBlocked: false, activeProductFence: false,
    manualCompactionState: 'none' as const, hasLegacyPreparedRun: false, headRuntimeManifestDigest: 'runtime',
    headProtocolSchemaDigest: 'protocol', currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol' }
  const head = projectCodexHeadActionProjection(headFacts)
  const actionAdmissionRef = { headProjectionDigest: head.evidenceDigest, actionProjectionVersion: head.actionProjectionVersion, actionHeadIdentity: head.actionHeadIdentity! }
  const tools = createCodexToolFixture(['ready_read', 'document_read_section'])
  const preparer = new CodexProductRunPreparer()
  const sourceResult = preparer.prepare({ taskId: 'task-B', runId: 'B', requestId: 'B', scopeId: 'scope', aliasId: 'scope', aliasGeneration: 1,
    taskOrigin: 'user_root', runOrigin: 'initial', originUserMessageId: 'message-B', reservationSetId: 'set-B', reservationEvidenceDigest: 'evidence-B',
    currentInput: [{ type: 'text', text: scenario.text || 'hello', text_elements: [] }],
    uncommittedTailAssignments: [], supersededUncommittedItems: [],
    explicitResourceEnvelope: { input: [], resourceRefs: scenario.sourceAnchor ? [resourceReferenceForAnchor(anchor)] : [] }, resourceAdditionalContext: scenario.sourceAnchor ? [resourceReferenceForAnchor(anchor)] : [], actionAdmissionRef: { ...actionAdmissionRef, actionHeadIdentity: { ...actionAdmissionRef.actionHeadIdentity, aliasGeneration: 1 }, actionProjectionVersion: { ...actionAdmissionRef.actionProjectionVersion, headGeneration: 1 } },
    trustedWorkbenchMode: scenario.mode, ...(scenario.sourceAnchor ? { currentDocumentAnchor: anchor } : {}),
    readyMemorySnapshot: disabledReadyMemorySnapshot(), ...tools, authorizationOwnerId: 'butler', resourceOwnerId: 'butler',
    productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
  })
  assert.equal(sourceResult.ok, true, JSON.stringify(sourceResult))
  if (!sourceResult.ok) throw new Error(sourceResult.code)
  const source = sourceResult.prepared
  const tail = [{ originUserMessageId: 'message-B', input: source.ingress.canonicalCurrentInputRef.input,
    inputDigest: digestCodexUserInput(source.ingress.canonicalCurrentInputRef.input), policy: 'untrusted_text_history' as const }]
  const actionProjection = makeProductTurnActionProjection({ readyRunId: 'B', retryAvailability: 'ready' })
  if (actionProjection.retryEvidenceKind !== 'complete') throw new Error('fixture_projection_missing')
  actionProjection.headProjectionRef = { digest: head.evidenceDigest, version: head.actionProjectionVersion }
  const receipt = { readyRunId: 'B', readyScopeId: 'scope', presentationDigest: 'a'.repeat(64), failure: { kind: 'provider' }, tools: [], actionProjection }
  const repository = {
    readActiveAliasBinding: () => ({ aliasId: 'scope', aliasGeneration: 2, threadBindingId: 'head', codexThreadId: null,
      materializationKind: 'fresh_root_with_tail', materializationState: 'confirmed', historySeedDigest: 'd'.repeat(64) }),
    readHeadActionFacts: () => headFacts,
    readProductTurnRuntime: () => ({ readyRunId: 'B', readyScopeId: 'scope', prepared: source, codexThreadId: 'old-thread', codexTurnId: 'old-turn' }),
    readProductTurnPresentation: () => receipt, readProductTurnSuccessorId: () => null,
    readLiveUncommittedUserTail: () => tail, readProductCloseout: () => ({ productTerminalDigest: 'terminal-B' }),
    readProductTurnActionContext: () => ({ sourceRootCompacted: false }),
    readTerminalCloseoutEvidence: () => ({ terminalFacts: { history: { kind: 'diverged' }, effect: { state: 'none' } } }),
    freshRootRequiresReseed: () => Boolean(scenario.atomicContinuationDrift),
    resolveFreshRootInheritance: () => {
      continuationReads += 1
      const blocked = scenario.atomicContinuationDrift && continuationReads > 1
      const toolCompatibility = {
        kind: 'compatible' as const,
        addedToCurrentSubset: [], modelContractChangedToolNames: [],
        readyContractChangedToolNames: [], frozenOnlyToolNames: [],
        evidenceDigest: '1'.repeat(64),
      }
      return {
        kind: blocked ? 'requires_new_context' as const : 'ready_same_thread' as const,
        reason: blocked ? 'native_tool_definition_changed' as const : null,
        evidenceDigest: (blocked ? '2' : '3').repeat(64),
        runtimeEvidenceDigest: '4'.repeat(64),
        toolCompatibility,
      }
    },
    admitProductBindingsInOpenTransaction: () => { throw new Error('fixture_admission_not_configured') },
  }
  let profileRouteDrifted = false
  const config = { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'isolated-fixture', model: 'fixture-model', agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on', nativeVideoMode: 'off' }
  const preparedDetails = new Map<string, unknown>()
  const detailPrepared = new Map<string, PreparedCodexProductRun>()
  const registry = new CodexStartIdentityRegistry({ capacity: 8 })
  const reserved = registry.reserve({ scopeId: 'scope', existingThread: false })
  assert.equal(reserved.ok, true)
  if (!reserved.ok) throw new Error(reserved.error)
  const reservation = reserved.reservation
  let continuationReads = 0
  const calls = { auth: 0, tools: 0, providerDispatch: 0, writes: 0 }
  const request: SendScopedRequest = { scopeId: 'scope', requestId: 'retry', expectedMessageVisibilityEpoch: 0, expectedAliasGeneration: 2,
    message: '再试一次', userMessage: { id: 'control-R', content: '再试一次', timestamp: at,
      meta: { sourceKind: 'local', sourceId: 'app', threadKey: 'scope', direction: 'local-input', workbenchMode: scenario.mode, actionAuthorizationMode: 'ask' },
      attachmentConfirmation: { selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0 } },
    explicitRetry: { predecessorRunId: 'B', predecessorPresentationDigest: receipt.presentationDigest },
    ...(scenario.anchor ? { currentDocumentAnchor: scenario.anchor } : {}),
  }
  const database = { getRawDb: () => db, chat: { addChatMessage(id: string, scopeId: string, role: string, content: string, timestamp: string, meta: object, epoch: number) {
    calls.writes += 1
    db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, scopeId, role, content, timestamp, JSON.stringify(meta), epoch)
  } } }
  const host = { getScope: () => scope, runtime: { async resolveTrustedRequestEnvironment() {
    return { workbenchMode: scenario.mode, ...(scenario.page ? { browserPageRef: scenario.page } : {}) }
  } }, resolveSkillAuthorizationForTurn(value: { mode: string; message: string }) {
    calls.auth += 1
    assert.equal(value.mode, request.explicitRetry ? 'observe' : 'commit')
    assert.equal(value.message, request.explicitRetry ? scenario.text || 'hello' : request.userMessage.content)
    return buildExplicitNoSkillAuthorization('no_skill_signal')
  }, resolveToolTurnSnapshot(value: { authorizationId: string; authorization: ReturnType<typeof buildExplicitNoSkillAuthorization>; requestEnvelope: { primaryInstruction: string } }) {
    calls.tools += 1
    assert.equal(value.requestEnvelope.primaryInstruction, request.explicitRetry ? scenario.text || 'hello' : request.userMessage.content)
    return { readyToolSurface: tools.readyToolSurface, readyTurnToolAuthorization: buildReadyTurnToolAuthorization({ ...value, toolSurface: tools.readyToolSurface }) }
  }, async createInitialExecutionBinding() { return providerCheckpointExecutionBinding('retry') },
  getTaskProjectionStore: () => ({ create(value: Parameters<TaskProjectionRepository['create']>[0]) {
    calls.writes += 1
    new TaskProjectionRepository(database).create(value, { silent: true })
  } }), createCodexActiveRunMetaInOpenTransaction(value: Omit<Parameters<RunMetaRepository['create']>[0], 'status'>) {
    calls.writes += 1
    new RunMetaRepository(db).create({ ...value, status: 'running' }, Date.parse(at))
  } }
  const ports = await production({ input: { database, settings: { getAIWorkspace: () => ({ profiles: [{ id: 'fixture',
      config: scenario.profileRouteDriftAfterPrepare && profileRouteDrifted
        ? { ...config, model: 'fixture-model-changed' }
        : config }] }), getActiveAIProfileId: () => 'fixture' },
    providerReadiness: { async ensureReady() {} } }, host, repository, rawDb: db,
    resolveHeadContinuation: () => null,
    issueBeginNewContextAction: (action: {
      scopeId: string; scopeEpoch: number; candidateEvidenceDigest: string
      consequenceDigest: string; draftRevision: number | null
    }) => {
      const unsigned = {
        contract: 'codex_begin_new_context_action_v1' as const,
        operationId: `begin-context-${action.candidateEvidenceDigest}`,
        scopeId: action.scopeId, scopeEpoch: action.scopeEpoch,
        sourceThreadBindingId: 'head', sourceAliasGeneration: 2, sourceRevision: 1,
        sourceEvidenceDigest: '5'.repeat(64),
        candidateEvidenceDigest: action.candidateEvidenceDigest,
        consequenceDigest: action.consequenceDigest,
        draftRevision: action.draftRevision,
      }
      return { ...unsigned, digest: digestCanonicalJson(unsigned) }
    },
    verified: { manifestDigest: 'runtime', manifest: { stableV2SchemaSha256: 'protocol' }, assetRoot: fileURLToPath(new URL('../../assets/codex-runtime', import.meta.url)) },
    gate: { assertOpen() {} }, state: { threadCwdRoot: output }, preparer, preparedDetails, detailPrepared, registry,
    readyMemoryRepository: new ReadyMemoryRepository(db), gatewayRepository: new CodexModelGatewayRepository(db), ownerMainBootId: 'fixture-boot',
    nativeRuntime: { async threadRead() { calls.providerDispatch += 1; throw new Error('unexpected_native_read') } },
  })
  const counts = () => ['chat_messages', 'task_projections', 'run_meta', 'codex_turn_bindings', 'ready_model_gateway_request_receipts', 'ready_model_gateway_exchange_events']
    .map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()!.n)
  return { db, scope, request, source, reservation, repository, registry, preparedDetails, detailPrepared, ports, calls, counts,
    actionAdmissionRef, driftProfileRoute() { profileRouteDrifted = true },
    close() { db.close(); rmSync(output, { recursive: true, force: true }) } }
}

for (const scenario of [
  { name: 'default document inactive', mode: 'document', anchor },
  { name: 'browser document split without page', mode: 'browser', anchor: { ...anchor, pane: 'split' } },
  { name: 'browser document split with degraded page', mode: 'browser', anchor: { ...anchor, pane: 'split' }, page: { tabId: 'incomplete' } },
  { name: 'complete browser page', mode: 'browser', anchor, page: { tabId: 'tab', physicalTargetToken: 'target', mainFrameDocumentToken: 'document' }, error: 'codex_explicit_retry_current_environment_requires_restatement' },
  { name: 'current document activation uses B, not R', mode: 'document', text: '读取当前文档', anchor, error: 'codex_explicit_retry_resource_restatement_required' },
  { name: 'current split document activation uses B, not R', mode: 'browser', text: '读取当前文档', anchor: { ...anchor, pane: 'split' }, error: 'codex_explicit_retry_resource_restatement_required' },
  { name: 'B current-document intent with no current observation', mode: 'document', text: '读取当前文档' },
  { name: 'source document remains a resource', mode: 'document', sourceAnchor: true, error: 'codex_explicit_retry_resource_restatement_required' },
] as const) test(`production Retry: ${scenario.name}`, async (t) => {
  if (skipIfSqliteUnavailable(t, 'production Retry handoff')) return
  const value = await fixture(scenario)
  t.after(() => value.close())
  const before = value.counts()
  const requestBytes = JSON.stringify(value.request)
  const result = await value.ports.ingressPort.prepareIngress({ scope: value.scope as never, request: value.request, reservation: value.reservation })
  if ('error' in scenario) {
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('unexpected_retry_admission')
    assert.equal(result.error, scenario.error)
    assert.equal(value.detailPrepared.size, 0)
  } else {
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) throw new Error(result.error)
    const prepared = result.dispatchContext
    assert.equal(prepared.ingress.currentDocumentAnchor, undefined)
    assert.equal(prepared.ingress.attemptKind, 'explicit_retry')
    assert.deepEqual(prepared.ingress.canonicalCurrentInputRef, value.source.ingress.canonicalCurrentInputRef)
    assert.equal(prepared.ingress.controlAuditMessageRef?.messageId, value.request.userMessage.id)
    assert.equal(prepared.ingress.uncommittedTailAssignments?.filter((item) => item.plan === 'replace_with_explicit_retry').length, 1)
    assert.equal(value.detailPrepared.get(prepared.runId), prepared)
  }
  assert.deepEqual(value.counts(), before)
  assert.equal(JSON.stringify(value.request), requestBytes)
  assert.equal(value.calls.providerDispatch, 0)
})

for (const code of ['action_admission_ref_stale', 'ordinary_uncommitted_tail_stale', 'unrelated_failure', 'rollback_failed', 'release_failed'] as const) {
  test(`production atomic Retry boundary: ${code}`, async (t) => {
    if (skipIfSqliteUnavailable(t, 'production admission rollback')) return
    const value = await fixture({ mode: 'document' })
    t.after(() => value.close())
    delete value.request.explicitRetry
    value.request.actionAdmissionRef = value.actionAdmissionRef
    const before = value.counts()
    value.repository.admitProductBindingsInOpenTransaction = () => {
      assert.equal(value.db.inTransaction, true)
      assert.equal(value.calls.writes, 3)
      throw new CodexBindingRepositoryError(code === 'rollback_failed' || code === 'release_failed' ? 'action_admission_ref_stale' : code)
    }
    const unrelated = value.registry.reserve({ scopeId: 'other-scope', existingThread: false })
    assert.equal(unrelated.ok, true)
    if (!unrelated.ok) throw new Error(unrelated.error)
    value.detailPrepared.set('other-run', { ingressBinding: { reservationSetId: unrelated.reservation.reservationSetId } } as PreparedCodexProductRun)
    value.preparedDetails.set('other-run', {})
    if (code === 'release_failed') t.mock.method(value.registry, 'releaseBeforeDispatch', () => { throw new Error('fixture_release_failed') })
    const originalExec = value.db.exec.bind(value.db)
    if (code === 'rollback_failed') t.mock.method(value.db, 'exec', (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('fixture_rollback_failed')
      return originalExec(sql)
    })
    let dispatched = 0
    let emitted = 0
    let releaseKind = ''
    const result = await runConfirmedSendScoped({
      scopeId: 'scope', requestId: value.request.requestId, userMessage: value.request.userMessage,
      getScope: () => value.scope, resolveStartIdentityMethods: () => ['thread/start', 'turn/start'],
      reserveStartIdentitySet: async () => ({ ok: true, reservation: value.reservation }),
      reconcileReservationContractFailure: async () => { assert.fail('unexpected_contract_reconciliation') },
      prepareDispatch: () => value.ports.ingressPort.prepareIngress({ scope: value.scope as never, request: value.request, reservation: value.reservation }),
      validateDispatchContext: (prepared): prepared is PreparedCodexProductRun => Boolean(prepared),
      persistIngressAtomic: ({ dispatchContext }) => value.ports.ingressPort.persistIngressAtomic({ scope: value.scope as never, request: value.request, reservation: value.reservation, prepared: dispatchContext }),
      releaseReservationAfterPrePersistenceRejection: async (input) => {
        releaseKind = 'pre-persistence'
        assert.equal(value.db.inTransaction, false)
        assert.deepEqual(value.counts(), before)
        await value.ports.startIdentityPort.releaseAfterPrePersistenceRejection(input)
      },
      releaseReservationAfterIngressFailure: async (input) => {
        releaseKind = 'ingress-failure'
        await value.ports.startIdentityPort.releaseAfterIngressFailure(input)
      },
      emitIngressAdmitted: () => { emitted += 1 },
      runConfirmed: async () => { dispatched += 1; throw new Error('unexpected_dispatch') },
    })
    if (code === 'rollback_failed') {
      assert.equal(value.db.inTransaction, true)
      originalExec('ROLLBACK')
    }
    assert.equal(result.disposition, code === 'unrelated_failure' || code === 'rollback_failed' ? 'ingress_persistence_failed' : 'rejected_before_persistence')
    assert.equal(releaseKind, code === 'unrelated_failure' || code === 'rollback_failed' ? 'ingress-failure' : 'pre-persistence')
    assert.equal(value.calls.writes, 3, JSON.stringify(result))
    assert.deepEqual([...value.preparedDetails.keys()], ['other-run'])
    assert.deepEqual([...value.detailPrepared.keys()], ['other-run'])
    assert.equal(value.registry.snapshot().members.length, code === 'release_failed' ? 4 : 2)
    assert.deepEqual(value.counts(), before)
    assert.equal(dispatched + emitted, 0)
  })
}

test('production atomic ingress rechecks continuation before every durable write', async (t) => {
  if (skipIfSqliteUnavailable(t, 'production atomic continuation')) return
  const value = await fixture({ mode: 'document', atomicContinuationDrift: true })
  t.after(() => value.close())
  delete value.request.explicitRetry
  value.request.actionAdmissionRef = value.actionAdmissionRef
  value.request.draftRevision = 9
  const before = value.counts()
  let dispatched = 0
  let emitted = 0
  const result = await runConfirmedSendScoped({
    scopeId: 'scope', requestId: value.request.requestId, userMessage: value.request.userMessage,
    getScope: () => value.scope,
    resolveStartIdentityMethods: () => ['thread/start', 'turn/start'],
    reserveStartIdentitySet: async () => ({ ok: true, reservation: value.reservation }),
    reconcileReservationContractFailure: async () => { assert.fail('unexpected_contract_reconciliation') },
    prepareDispatch: () => value.ports.ingressPort.prepareIngress({
      scope: value.scope as never,
      request: value.request,
      reservation: value.reservation,
    }),
    validateDispatchContext: (prepared): prepared is PreparedCodexProductRun => Boolean(prepared),
    persistIngressAtomic: ({ dispatchContext }) => value.ports.ingressPort.persistIngressAtomic({
      scope: value.scope as never,
      request: value.request,
      reservation: value.reservation,
      prepared: dispatchContext,
    }),
    releaseReservationAfterPrePersistenceRejection: (input) => (
      value.ports.startIdentityPort.releaseAfterPrePersistenceRejection(input)
    ),
    releaseReservationAfterIngressFailure: async () => { assert.fail('unexpected_ingress_failure') },
    emitIngressAdmitted: () => { emitted += 1 },
    runConfirmed: async () => { dispatched += 1; throw new Error('unexpected_dispatch') },
  })
  assert.equal(result.disposition, 'rejected_before_persistence')
  assert.equal(result.errorKind, 'native_tool_definition_changed')
  assert.equal(result.recoveryActionRef?.candidateEvidenceDigest, '2'.repeat(64))
  assert.equal(result.recoveryActionRef?.draftRevision, 9)
  assert.equal(value.calls.writes, 0)
  assert.deepEqual(value.counts(), before)
  assert.equal(dispatched + emitted, 0)
})

for (const kind of ['explicit_resource', 'attachment'] as const) test(`production Retry control preserves ${kind}`, async (t) => {
  if (skipIfSqliteUnavailable(t, 'production Retry control')) return
  const value = await fixture({ mode: 'document', anchor })
  t.after(() => value.close())
  if (kind === 'explicit_resource') value.request.resources = [{ kind: 'local_directory', id: 'folder', name: 'folder', path: '/tmp/unread-fixture' }]
  else value.request.userMessage.attachmentConfirmation.selectedCount = 1
  const before = value.counts()
  const requestDigest = digestCanonicalJson(value.request)
  const result = preflightExplicitRetryControl({ request: value.request, scope: {
    id: 'scope', source_kind: 'local', source_id: 'app', thread_key: 'scope', meta_json: '{}',
  } })
  assert.equal(result?.disposition, 'rejected_before_persistence')
  assert.equal(result?.error, kind === 'explicit_resource' ? 'explicit_retry_resource_present' : 'explicit_retry_attachment_count_nonzero')
  assert.equal(digestCanonicalJson(value.request), requestDigest)
  assert.deepEqual(value.counts(), before)
  assert.deepEqual(value.calls, { auth: 0, tools: 0, providerDispatch: 0, writes: 0 })
})

test('a profile route change between prepare and atomic ingress is a named zero-write rejection', async (t) => {
  if (skipIfSqliteUnavailable(t, 'production profile route drift')) return
  const value = await fixture({ mode: 'document', profileRouteDriftAfterPrepare: true })
  t.after(() => value.close())
  delete value.request.explicitRetry
  value.request.actionAdmissionRef = value.actionAdmissionRef
  const before = value.counts()
  let dispatched = 0
  let emitted = 0
  const result = await runConfirmedSendScoped({
    scopeId: 'scope', requestId: value.request.requestId, userMessage: value.request.userMessage,
    getScope: () => value.scope,
    resolveStartIdentityMethods: () => ['thread/start', 'turn/start'],
    reserveStartIdentitySet: async () => ({ ok: true, reservation: value.reservation }),
    reconcileReservationContractFailure: async () => { assert.fail('unexpected_contract_reconciliation') },
    prepareDispatch: async () => {
      const prepared = await value.ports.ingressPort.prepareIngress({
        scope: value.scope as never, request: value.request, reservation: value.reservation,
      })
      // The user switches provider configuration after prepare froze the route.
      value.driftProfileRoute()
      return prepared
    },
    validateDispatchContext: (prepared): prepared is PreparedCodexProductRun => Boolean(prepared),
    persistIngressAtomic: ({ dispatchContext }) => value.ports.ingressPort.persistIngressAtomic({
      scope: value.scope as never, request: value.request,
      reservation: value.reservation, prepared: dispatchContext,
    }),
    releaseReservationAfterPrePersistenceRejection: (input) => (
      value.ports.startIdentityPort.releaseAfterPrePersistenceRejection(input)
    ),
    releaseReservationAfterIngressFailure: async () => { assert.fail('unexpected_ingress_failure') },
    emitIngressAdmitted: () => { emitted += 1 },
    runConfirmed: async () => { dispatched += 1; throw new Error('unexpected_dispatch') },
  })
  assert.equal(result.disposition, 'rejected_before_persistence',
    'a configuration change is not a persistence fault')
  assert.equal(result.errorKind, 'action_projection_confirmation_required')
  assert.equal(result.success, false)
  if (result.success === false) assert.equal(result.retryableByUser, true)
  assert.equal(value.calls.writes, 0)
  assert.deepEqual(value.counts(), before)
  assert.equal(dispatched + emitted, 0)
})
