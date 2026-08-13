import type { WorkflowRawDatabase } from '../../repositories/browser-workflow-unit-of-work'
import type {
  CodexBindingRepository,
  CodexProductTurnRuntimeRead,
} from './codex-binding-repository'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import { getAskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'
import { getFrozenCallStore } from '../safety/frozen-call-bridge'

const FROZEN_CALL_QUESTION_ID = 'frozen_call_confirm'

type FrozenCallRow = {
  id: string
  run_id: string | null
  task_id: string | null
  scope_id: string | null
  tool_name: string
  params_json: string
  created_at: string
  expires_at: string
  status: string
}

type AskUserCardRow = {
  id: string
  conversation_id: string
  timestamp: string
  meta_json: string | null
}

export type CodexPendingInteractionIdentity = {
  contract: 'codex_pending_interaction_identity_v1'
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string
  codexTurnId: string
  messageVisibilityEpoch: number
}

export type CodexPendingInteractionSnapshot =
  | {
      kind: 'frozen_call'
      interactionId: string
      readyRunId: string | null
      taskId: string | null
      scopeId: string | null
      sourceDigest: string
      sourcePayload: string
    }
  | {
      kind: 'ask_user_questions'
      interactionId: string
      readyRunId: string | null
      scopeId: string | null
      conversationId: string
      actionConfirmation: boolean
      codexIdentity: CodexPendingInteractionIdentity | null
      sourceDigest: string
      sourcePayload: string
    }

export type CodexPendingInteractionRestartPlan = {
  contract: 'codex_pending_interaction_restart_v1'
  cancelledAt: string
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string
  codexTurnId: string
  interactions: CodexPendingInteractionSnapshot[]
  evidenceDigest: string
}

export type CodexPendingInteractionRestartScan = {
  closeoutPlans: CodexPendingInteractionRestartPlan[]
  cancelOnly: CodexPendingInteractionSnapshot[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isInTransaction(db: WorkflowRawDatabase): boolean {
  return (db as WorkflowRawDatabase & { inTransaction?: boolean }).inTransaction === true
}

function parseRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseStoredIdentity(value: unknown): CodexPendingInteractionIdentity | null {
  if (!isRecord(value) || value.contract !== 'codex_pending_interaction_identity_v1') return null
  const readyRunId = nonEmptyString(value.readyRunId)
  const readyTaskId = nonEmptyString(value.readyTaskId)
  const readyScopeId = nonEmptyString(value.readyScopeId)
  const readyAliasId = nonEmptyString(value.readyAliasId)
  const threadBindingId = nonEmptyString(value.threadBindingId)
  const codexThreadId = nonEmptyString(value.codexThreadId)
  const codexTurnId = nonEmptyString(value.codexTurnId)
  const aliasGeneration = Number(value.aliasGeneration)
  const messageVisibilityEpoch = Number(value.messageVisibilityEpoch)
  if (!readyRunId || !readyTaskId || !readyScopeId || !readyAliasId
    || !threadBindingId || !codexThreadId || !codexTurnId
    || !Number.isInteger(aliasGeneration) || aliasGeneration < 1
    || !Number.isSafeInteger(messageVisibilityEpoch) || messageVisibilityEpoch < 0) return null
  return {
    contract: 'codex_pending_interaction_identity_v1',
    readyRunId,
    readyTaskId,
    readyScopeId,
    readyAliasId,
    aliasGeneration,
    threadBindingId,
    codexThreadId,
    codexTurnId,
    messageVisibilityEpoch,
  }
}

function frozenSourceDigest(row: FrozenCallRow): string {
  return digestCanonicalJson({
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    scopeId: row.scope_id,
    toolName: row.tool_name,
    paramsJson: row.params_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  })
}

function askCardSourceDigest(row: AskUserCardRow): string {
  return digestCanonicalJson({
    id: row.id,
    conversationId: row.conversation_id,
    timestamp: row.timestamp,
    metaJson: row.meta_json,
  })
}

function readPendingInteractions(db: WorkflowRawDatabase): CodexPendingInteractionSnapshot[] {
  const interactions: CodexPendingInteractionSnapshot[] = []
  const frozenRows = db.prepare(`
    SELECT id, run_id, task_id, scope_id, tool_name, params_json,
           created_at, expires_at, status
      FROM pending_confirmations
     WHERE status = 'pending'
     ORDER BY created_at ASC, id ASC
  `).all<FrozenCallRow>()
  for (const row of frozenRows) {
    const readyRunId = nonEmptyString(row.run_id)
    interactions.push({
      kind: 'frozen_call',
      interactionId: row.id,
      readyRunId,
      taskId: nonEmptyString(row.task_id),
      scopeId: nonEmptyString(row.scope_id),
      sourceDigest: frozenSourceDigest(row),
      sourcePayload: row.params_json,
    })
  }

  const cardRows = db.prepare(`
    SELECT id, conversation_id, timestamp, meta_json
      FROM chat_messages
     WHERE role = 'agent_card'
       AND meta_json LIKE '%"status":"pending"%'
     ORDER BY timestamp ASC, id ASC
  `).all<AskUserCardRow>()
  for (const row of cardRows) {
    const meta = parseRecord(row.meta_json)
    const ask = meta && isRecord(meta.askUserQuestions) ? meta.askUserQuestions : null
    if (!ask || ask.status !== 'pending') continue
    const readyRunId = nonEmptyString(ask.requestId)
    const questions = Array.isArray(ask.questions) ? ask.questions : []
    const actionConfirmation = ask.lifecycleType === 'action_confirmation'
      || questions.some((question) => isRecord(question) && question.id === FROZEN_CALL_QUESTION_ID)
    interactions.push({
      kind: 'ask_user_questions',
      interactionId: row.id,
      readyRunId,
      scopeId: nonEmptyString(ask.scopeId),
      conversationId: row.conversation_id,
      actionConfirmation,
      codexIdentity: parseStoredIdentity(ask.codexRunIdentity),
      sourceDigest: askCardSourceDigest(row),
      sourcePayload: row.meta_json || '{}',
    })
  }
  return interactions
}

function productIdentity(product: CodexProductTurnRuntimeRead): CodexPendingInteractionIdentity | null {
  if (!product.codexThreadId || !product.codexTurnId) return null
  return {
    contract: 'codex_pending_interaction_identity_v1',
    readyRunId: product.readyRunId,
    readyTaskId: product.readyTaskId,
    readyScopeId: product.readyScopeId,
    readyAliasId: product.readyAliasId,
    aliasGeneration: product.aliasGeneration,
    threadBindingId: product.threadBindingId,
    codexThreadId: product.codexThreadId,
    codexTurnId: product.codexTurnId,
    messageVisibilityEpoch: product.messageVisibilityEpoch,
  }
}

function sameIdentity(
  left: CodexPendingInteractionIdentity,
  right: CodexPendingInteractionIdentity,
): boolean {
  return digestCanonicalJson(left) === digestCanonicalJson(right)
}

function hasExactFence(
  repository: Pick<CodexBindingRepository, 'hasExactProductFence'>,
  identity: CodexPendingInteractionIdentity,
): boolean {
  return repository.hasExactProductFence({
    readyRunId: identity.readyRunId,
    threadBindingId: identity.threadBindingId,
  })
}

function hasCodexTurnBinding(
  repository: Pick<CodexBindingRepository, 'hasProductTurnBinding'>,
  readyRunId: string,
): boolean {
  return repository.hasProductTurnBinding(readyRunId)
}

function hasActiveReadyParent(
  db: WorkflowRawDatabase,
  identity: CodexPendingInteractionIdentity,
): boolean {
  const row = db.prepare(`
    SELECT run_id
      FROM run_meta
     WHERE run_id = ? AND task_id = ? AND scope_id = ?
       AND status IN ('working', 'running')
     LIMIT 1
  `).get<{ run_id: string }>(
    identity.readyRunId,
    identity.readyTaskId,
    identity.readyScopeId,
  )
  return row?.run_id === identity.readyRunId
}

function isExactInteraction(
  interaction: CodexPendingInteractionSnapshot,
  product: CodexProductTurnRuntimeRead,
  identity: CodexPendingInteractionIdentity,
  exactFrozenCalls: ReadonlyArray<CodexPendingInteractionSnapshot>,
): boolean {
  if (interaction.readyRunId !== product.readyRunId) return false
  if (interaction.kind === 'frozen_call') {
    return interaction.taskId === product.readyTaskId
      && interaction.scopeId === product.readyScopeId
  }
  if (interaction.conversationId !== product.readyScopeId
    || interaction.scopeId !== product.readyScopeId) return false
  if (interaction.actionConfirmation
    && !exactFrozenCalls.some((candidate) => candidate.kind === 'frozen_call')) return false
  return interaction.codexIdentity !== null
    && sameIdentity(interaction.codexIdentity, identity)
}

function buildPlan(
  identity: CodexPendingInteractionIdentity,
  interactions: CodexPendingInteractionSnapshot[],
  cancelledAt: string,
): CodexPendingInteractionRestartPlan {
  const { contract: _identityContract, ...identityFields } = identity
  const body = {
    contract: 'codex_pending_interaction_restart_v1' as const,
    cancelledAt,
    ...identityFields,
    interactions: interactions.map((interaction) => ({
      kind: interaction.kind,
      interactionId: interaction.interactionId,
      sourceDigest: interaction.sourceDigest,
    })),
  }
  return {
    ...body,
    interactions,
    evidenceDigest: digestCanonicalJson(body),
  }
}

export function scanCodexPendingInteractionsForRestart(input: {
  db: WorkflowRawDatabase
  repository: Pick<
    CodexBindingRepository,
    'hasExactProductFence' | 'hasProductTurnBinding' | 'readProductTurnRuntime' | 'readProductCloseout'
  >
  cancelledAt: string
}): CodexPendingInteractionRestartScan {
  const all = readPendingInteractions(input.db)
  const byRun = new Map<string, CodexPendingInteractionSnapshot[]>()
  const cancelOnly: CodexPendingInteractionSnapshot[] = []
  for (const interaction of all) {
    if (!interaction.readyRunId) {
      if (interaction.kind === 'ask_user_questions'
        && interaction.codexIdentity
        && hasCodexTurnBinding(input.repository, interaction.codexIdentity.readyRunId)) {
        cancelOnly.push(interaction)
      }
      continue
    }
    if (!hasCodexTurnBinding(input.repository, interaction.readyRunId)) {
      continue
    }
    const group = byRun.get(interaction.readyRunId) || []
    group.push(interaction)
    byRun.set(interaction.readyRunId, group)
  }
  const closeoutPlans: CodexPendingInteractionRestartPlan[] = []
  for (const [readyRunId, interactions] of byRun) {
    let product: CodexProductTurnRuntimeRead
    try {
      product = input.repository.readProductTurnRuntime(readyRunId)
    } catch {
      cancelOnly.push(...interactions)
      continue
    }
    if (input.repository.readProductCloseout(readyRunId)) {
      cancelOnly.push(...interactions)
      continue
    }
    const identity = productIdentity(product)
    if (!identity
      || !hasExactFence(input.repository, identity)
      || !hasActiveReadyParent(input.db, identity)) {
      cancelOnly.push(...interactions)
      continue
    }
    const exactFrozenCalls = interactions.filter((interaction) => (
      interaction.kind === 'frozen_call'
      && interaction.taskId === product.readyTaskId
      && interaction.scopeId === product.readyScopeId
    ))
    const exact = interactions.filter((interaction) => (
      isExactInteraction(interaction, product, identity, exactFrozenCalls)
    ))
    const exactIds = new Set(exact.map((interaction) => interaction.interactionId))
    const unproven = interactions.filter((interaction) => !exactIds.has(interaction.interactionId))
    if (unproven.length > 0) {
      cancelOnly.push(...interactions)
      continue
    }
    if (exact.length === 0) continue
    closeoutPlans.push(buildPlan(identity, exact, input.cancelledAt))
  }
  return { closeoutPlans, cancelOnly }
}

export function assertCodexPendingInteractionRestartSweepComplete(input: {
  db: WorkflowRawDatabase
  repository: Pick<
    CodexBindingRepository,
    'hasExactProductFence' | 'hasProductTurnBinding' | 'readProductTurnRuntime' | 'readProductCloseout'
  >
  cancelledAt: string
}): void {
  const remaining = scanCodexPendingInteractionsForRestart(input)
  if (remaining.closeoutPlans.length > 0 || remaining.cancelOnly.length > 0) {
    throw new Error('codex_pending_interaction_restart_sweep_incomplete')
  }
}

function updatedAskCardMeta(
  sourcePayload: string,
  input: { cancelledAt: string; evidenceDigest: string; disposition: string },
): string {
  const meta = parseRecord(sourcePayload)
  if (!meta || !isRecord(meta.askUserQuestions) || meta.askUserQuestions.status !== 'pending') {
    throw new Error('codex_pending_ask_user_source_invalid')
  }
  return JSON.stringify({
    ...meta,
    askUserQuestions: {
      ...meta.askUserQuestions,
      status: 'cancelled',
      cancelReason: 'app_restart',
      cancelDisposition: input.disposition,
      cancelledAt: input.cancelledAt,
      cancellationEvidenceDigest: input.evidenceDigest,
    },
  })
}

function updatedFrozenAudit(
  sourcePayload: string,
  input: { cancelledAt: string; evidenceDigest: string; disposition: string },
): string {
  const audit = parseRecord(sourcePayload)
  if (!audit) throw new Error('codex_pending_frozen_call_source_invalid')
  return JSON.stringify({
    ...audit,
    restartCancellation: {
      reason: 'app_restart',
      disposition: input.disposition,
      cancelledAt: input.cancelledAt,
      evidenceDigest: input.evidenceDigest,
    },
  })
}

function settleInteractionInOpenTransaction(input: {
  db: WorkflowRawDatabase
  interaction: CodexPendingInteractionSnapshot
  cancelledAt: string
  evidenceDigest: string
  disposition: string
}): void {
  if (!isInTransaction(input.db)) throw new Error('codex_pending_interaction_transaction_missing')
  const interaction = input.interaction
  if (interaction.kind === 'frozen_call') {
    const row = input.db.prepare(`
      SELECT id, run_id, task_id, scope_id, tool_name, params_json,
             created_at, expires_at, status
        FROM pending_confirmations WHERE id = ? LIMIT 1
    `).get<FrozenCallRow>(interaction.interactionId)
    if (!row || frozenSourceDigest(row) !== interaction.sourceDigest || row.status !== 'pending') {
      throw new Error('codex_pending_frozen_call_cas_conflict')
    }
    const result = input.db.prepare(`
      UPDATE pending_confirmations
         SET status = 'expired', params_json = ?
       WHERE id = ? AND status = 'pending' AND params_json = ?
    `).run(
      updatedFrozenAudit(row.params_json, input),
      interaction.interactionId,
      interaction.sourcePayload,
    )
    if (Number((result as { changes?: unknown }).changes || 0) !== 1) {
      throw new Error('codex_pending_frozen_call_cas_conflict')
    }
    return
  }
  const row = input.db.prepare(`
    SELECT id, conversation_id, timestamp, meta_json
      FROM chat_messages WHERE id = ? LIMIT 1
  `).get<AskUserCardRow>(interaction.interactionId)
  if (!row || askCardSourceDigest(row) !== interaction.sourceDigest) {
    throw new Error('codex_pending_ask_user_cas_conflict')
  }
  const result = input.db.prepare(`
    UPDATE chat_messages SET meta_json = ?
     WHERE id = ? AND meta_json = ?
  `).run(
    updatedAskCardMeta(row.meta_json || '{}', input),
    interaction.interactionId,
    interaction.sourcePayload,
  )
  if (Number((result as { changes?: unknown }).changes || 0) !== 1) {
    throw new Error('codex_pending_ask_user_cas_conflict')
  }
}

export function completeCodexPendingInteractionRestartInOpenTransaction(input: {
  db: WorkflowRawDatabase
  plan: CodexPendingInteractionRestartPlan
  readyRunId: string
  closeoutAt: string
  recoveryEvidenceDigest: string
}): void {
  if (input.plan.readyRunId !== input.readyRunId
    || input.plan.cancelledAt !== input.closeoutAt
    || input.plan.evidenceDigest !== input.recoveryEvidenceDigest) {
    throw new Error('codex_pending_interaction_closeout_identity_mismatch')
  }
  for (const interaction of input.plan.interactions) {
    settleInteractionInOpenTransaction({
      db: input.db,
      interaction,
      cancelledAt: input.closeoutAt,
      evidenceDigest: input.recoveryEvidenceDigest,
      disposition: 'run_closed',
    })
  }
}

export function cancelCodexPendingInteractionsWithoutRunCloseout(input: {
  db: WorkflowRawDatabase
  interactions: ReadonlyArray<CodexPendingInteractionSnapshot>
  cancelledAt: string
  disposition?: string
}): number {
  if (input.interactions.length === 0) return 0
  if (isInTransaction(input.db)) throw new Error('codex_pending_interaction_nested_transaction')
  input.db.exec('BEGIN IMMEDIATE')
  try {
    for (const interaction of input.interactions) {
      const evidenceDigest = digestCanonicalJson({
        contract: 'codex_pending_interaction_cancel_only_v1',
        kind: interaction.kind,
        interactionId: interaction.interactionId,
        readyRunId: interaction.readyRunId,
        sourceDigest: interaction.sourceDigest,
        cancelledAt: input.cancelledAt,
        disposition: input.disposition || 'identity_unproven',
      })
      settleInteractionInOpenTransaction({
        db: input.db,
        interaction,
        cancelledAt: input.cancelledAt,
        evidenceDigest,
        disposition: input.disposition || 'identity_unproven',
      })
    }
    input.db.exec('COMMIT')
    return input.interactions.length
  } catch (error) {
    if (isInTransaction(input.db)) input.db.exec('ROLLBACK')
    throw error
  }
}

export function settleCodexPendingInteractionsInMemoryAfterCommit(
  interactions: ReadonlyArray<CodexPendingInteractionSnapshot>,
): { askUserQuestions: number; frozenCalls: number } {
  const askStore = getAskUserQuestionsStore()
  const frozenStore = getFrozenCallStore()
  let askUserQuestions = 0
  let frozenCalls = 0
  for (const interaction of interactions) {
    if (interaction.kind === 'ask_user_questions') {
      if (askStore.reject(interaction.interactionId, new Error('app_restart'))) {
        askUserQuestions += 1
      }
    } else if (frozenStore?.retireAfterDurableSettlement(interaction.interactionId)) {
      frozenCalls += 1
    }
  }
  return { askUserQuestions, frozenCalls }
}

export function readCodexPendingInteractionIdentityForCard(input: {
  repository: Pick<CodexBindingRepository, 'readPendingInteractionBinding'>
  readyRunId: string | null | undefined
  scopeId: string | null | undefined
}): CodexPendingInteractionIdentity | null {
  const readyRunId = nonEmptyString(input.readyRunId)
  const scopeId = nonEmptyString(input.scopeId)
  if (!readyRunId || !scopeId) return null
  const row = input.repository.readPendingInteractionBinding({
    readyRunId,
    readyScopeId: scopeId,
  })
  if (!row) return null
  return {
    contract: 'codex_pending_interaction_identity_v1',
    ...row,
  }
}
