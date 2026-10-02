import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

import { DatabaseManager } from '../main/modules/database'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { preflightExplicitRetryControl } from '../main/modules/agent-control/codex-runtime/codex-explicit-retry-control'
import { createRejectedBeforePersistence } from '../main/modules/agent-control/send-scoped-confirmation'
import { hasLocalSendImIntentForTurn } from '../main/modules/agent-control/runtime-core/agent-sdk-foundation-utils'
import { resolveSkillHintRelevanceForTurn } from '../main/modules/agent-control/runtime-core/agent-sdk-skill-intent-utils'
import { resolveSemanticSkillAuthorizationForTurn } from '../main/modules/agent-control/runtime-core/skill-turn-authorization-resolver'
import type { SkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { ConversationScopeStore } from '../main/modules/agent-control/runtime-core/conversation-scope-store'
import { ReferenceHintService } from '../main/modules/agent-control/runtime-core/reference-hint-service'
import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  peekLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// __breaksInvariants: reset the hint singleton to simulate restart, inject a
// fixture skill catalog into the real host authorizer, and stop sendScoped at
// runtime readiness. This proves replay/selection, not native tool execution.
// Installed proof owns the separate real runtime/model-boundary evidence.

// Execute the actual methods without constructing Electron/UI owners. The
// transpiled AST is the test subject, not a duplicated send/authorization path.
function productionMethod(file: string, name: string, dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(new URL(
    `../main/modules/agent-control/runtime-core/${file}`, import.meta.url,
  ), 'utf8'), ts.ScriptTarget.Latest, true)
  let method: ts.MethodDeclaration | undefined
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) method = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(method, `production method missing: ${name}`)
  const compiled = ts.transpileModule(`return ({ ${method.getText(source)} }).${name}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies))
}

const sendScoped = productionMethod('runtime.ts', 'sendScoped', {
  preflightExplicitRetryControl, createRejectedBeforePersistence,
})
const resolveSkillAuthorizationForTurn = productionMethod('codex-host-orchestrator.ts', 'resolveSkillAuthorizationForTurn', {
  hasLocalSendImIntentForTurn, resolveSkillHintRelevanceForTurn, resolveSemanticSkillAuthorizationForTurn,
})

const VIDEO_COPY_SKILL = {
  id: 'video-copy-analyzer',
  name: 'Video Copy Analyzer',
  description: '视频分析与文案拆解',
  executionMode: 'advisory' as const,
  hostRequirements: { expose_when_hint_armed: ['video_copy_analyze'] },
  actions: [
    { name: 'read_skill', visibility: 'internal', runtime: 'reference', params: [] },
    { name: 'video_copy_analyze', visibility: 'internal', runtime: 'subprocess', params: [] },
  ],
}

function makeOrchestrator() {
  return new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [VIDEO_COPY_SKILL] as never,
    resolveSkillToolByAction: (_skillId, action) => (
      { name: `skill_${action}`, action } as never
    ),
    executeTool: async () => 'STDOUT:\n技能说明',
  } as never)
}

function makeStore(database: DatabaseManager) {
  let store!: ConversationScopeStore
  const referenceHints = new ReferenceHintService({
    db: database,
    mapConversationRow: (row) => store.mapConversationRow(row),
  })
  store = new ConversationScopeStore({
    ensureChannelAlias: () => {},
    db: database,
    emitConversationEvent() {},
    mapChannelRow() { throw new Error('unexpected_channel_mapping') },
    getScopedRemoteThreadKey() { throw new Error('unexpected_remote_scope') },
    getRemoteChannelSessionSettingKey() { throw new Error('unexpected_remote_scope') },
    restoreReferenceHintFromScope: (scope, id) => (
      referenceHints.restoreReferenceHintFromScope(scope, id)
    ),
    persistReferenceHintToScope: (id, expectedEpoch) => (
      referenceHints.persistReferenceHintToScope(id, expectedEpoch)
    ),
    resolveConversationAgentId: (agentId) => agentId,
    readAliasGeneration: () => null,
  })
  return { store, referenceHints }
}

async function replayViaSendScoped(
  database: DatabaseManager,
  store: ConversationScopeStore,
  referenceHints: ReferenceHintService,
  scopeId: string,
): Promise<void> {
  const result = await sendScoped.call({
    db: database,
    referenceHints,
    mapConversationRow: (row: Parameters<typeof store.mapConversationRow>[0]) => store.mapConversationRow(row),
    codexRuntime: { ensureReadyForUserIngress: async () => { throw new Error('fixture_stop_before_native_ingress') } },
  } as never, { scopeId, requestId: 'hint-replay', userMessage: { content: '继续' } } as never)
  assert.equal(result.errorKind, 'host_unavailable')
  assert.equal(result.error, 'fixture_stop_before_native_ingress')
}

function authorize(orchestrator: SkillContextOrchestrator, scopeId: string, content = '继续'): SkillToolAuthorization {
  return resolveSkillAuthorizationForTurn.call({
    domainAdapterHost: { getSkillContextOrchestrator: () => orchestrator },
  } as never, {
    mode: 'observe', sessionId: scopeId, messageVisibilityEpoch: 0,
    message: content,
  })
}

test('runtime replay reaches current-intent skill selection, while same-epoch boundary clears it', async (t) => {
  if (skipIfSqliteUnavailable(t, 'local scope reference hint replay')) return
  const database = new DatabaseManager(true)
  __setScopeContextEpochDatabaseForTests(database)
  _resetLastReferenceSkillHintsForTests()
  const scopeId = 'scope-local-hint-replay'
  try {
    const { store, referenceHints } = makeStore(database)
    store.createLocalScope('butler', scopeId)

    // Turn 1 arms the hint; the assistant append persists it into meta_json.
    rememberLastReferenceSkill(scopeId, {
      id: VIDEO_COPY_SKILL.id,
      name: VIDEO_COPY_SKILL.name,
      messageVisibilityEpoch: 0,
    })
    store.createConversationMessage(scopeId, { role: 'assistant', content: '已分析' }, 0)
    assert.equal(
      (JSON.parse(database.chat.getConversationScope(scopeId)!.meta_json || '{}') as {
        lastReferenceSkill?: { id?: string }
      }).lastReferenceSkill?.id,
      VIDEO_COPY_SKILL.id,
    )

    // Ready restarts: use the production host decision, not the retired typed
    // action list (those actions are excluded from Codex's model surface).
    _resetLastReferenceSkillHintsForTests()
    const orchestrator = makeOrchestrator()
    assert.equal(authorize(orchestrator, scopeId).mode, 'none')

    // The next turn replays it, and the gated action comes back.
    await replayViaSendScoped(database, store, referenceHints, scopeId)
    assert.equal(peekLastReferenceSkill(scopeId)?.id, VIDEO_COPY_SKILL.id)
    const selected = authorize(orchestrator, scopeId)
    assert.equal(selected.mode, 'selected')
    if (selected.mode === 'selected') {
      assert.equal(selected.skillId, VIDEO_COPY_SKILL.id)
      assert.equal(selected.source, 'active_task')
    }
    assert.equal(authorize(orchestrator, scopeId, '解释一下光合作用').mode, 'none',
      'history does not select a skill for an unrelated current request')

    // New context is not reset: the visible messages and epoch remain intact.
    const rawDb = database.getRawDb()
    assert.ok(rawDb)
    const repository = new CodexBindingRepository(rawDb, {
      runtimeManifestDigest: 'runtime-current', protocolSchemaDigest: 'protocol-current',
    })
    const retiredAt = new Date().toISOString()
    repository.createEmptyAliasGeneration({
      threadBindingId: 'hint-history-source', aliasId: scopeId, aliasGeneration: 1,
      readyScopeId: scopeId, runtimeManifestDigest: 'runtime-current',
      protocolSchemaDigest: 'protocol-current', createdAt: retiredAt,
    })
    // __breaksInvariants: seed a retired history-only source; retirement itself
    // is outside this replay/boundary test and is exercised by installed proof.
    rawDb.prepare(`UPDATE codex_thread_bindings SET retired_at = ?,
      retired_reason = 'publication_diverged', retirement_evidence_digest = ?,
      revision = revision + 1, updated_at = ? WHERE thread_binding_id = ?`)
      .run(retiredAt, digestCanonicalJson({ fixture: 'hint-history-source' }), retiredAt, 'hint-history-source')
    const historyOnly = repository.readHistoryOnlyScope(scopeId)
    assert.ok(historyOnly)
    const actionRef = repository.buildBeginNewContextActionRef({
      scopeId, scopeEpoch: 0, candidateEvidenceDigest: historyOnly.evidenceDigest,
      consequenceDigest: digestCanonicalJson(null), draftRevision: 1,
    })
    repository.beginNewContext({
      actionRef, issuedActionRef: actionRef, assertRecoveryEligible() {},
      runtimeManifestDigest: 'runtime-current', protocolSchemaDigest: 'protocol-current',
      committedAt: new Date().toISOString(),
    })
    assert.equal(database.chat.getConversationScope(scopeId)?.message_visibility_epoch, 0)
    assert.equal(database.chat.getChatMessages(scopeId).length, 1)
    _resetLastReferenceSkillHintsForTests()
    await replayViaSendScoped(database, store, referenceHints, scopeId)
    assert.equal(peekLastReferenceSkill(scopeId), null)
    assert.equal(authorize(orchestrator, scopeId).mode, 'none')
  } finally {
    __setScopeContextEpochDatabaseForTests(null)
    _resetLastReferenceSkillHintsForTests()
    database.close()
  }
})

test('replay never overwrites a hint the current process already armed', async (t) => {
  if (skipIfSqliteUnavailable(t, 'local scope reference hint replay precedence')) return
  const database = new DatabaseManager(true)
  __setScopeContextEpochDatabaseForTests(database)
  _resetLastReferenceSkillHintsForTests()
  const scopeId = 'scope-local-hint-precedence'
  try {
    const { store, referenceHints } = makeStore(database)
    store.createLocalScope('butler', scopeId)
    rememberLastReferenceSkill(scopeId, {
      id: VIDEO_COPY_SKILL.id,
      name: VIDEO_COPY_SKILL.name,
      messageVisibilityEpoch: 0,
    })
    store.createConversationMessage(scopeId, { role: 'assistant', content: '已分析' }, 0)

    // A later turn arms a different skill but fails before the assistant
    // append that would persist it. The next send must not resurrect the
    // stale persisted hint over the live one.
    rememberLastReferenceSkill(scopeId, {
      id: 'video-expert-analyzer',
      name: 'Video Expert Analyzer',
      messageVisibilityEpoch: 0,
    })
    await replayViaSendScoped(database, store, referenceHints, scopeId)
    assert.equal(peekLastReferenceSkill(scopeId)?.id, 'video-expert-analyzer')
  } finally {
    __setScopeContextEpochDatabaseForTests(null)
    _resetLastReferenceSkillHintsForTests()
    database.close()
  }
})
