import { createHash } from 'node:crypto'

export interface DirectAnswerHistoryMigrationDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all<T = unknown>(...params: unknown[]): T[]
  }
}

interface CandidateRow {
  task_id: string
  scope_id: string
  run_id: string
  budget_json: string | null
  criteria_json: string | null
  checkins_json: string | null
  proof_refs_json: string | null
  steps_json: string
  recent_artifacts_json: string | null
  resumable_actions_json: string | null
  delivery_state_json: string | null
  run_budget_json: string | null
  last_message_text: string | null
}

interface MessageRow {
  id: string
  content: string
  meta_json: string | null
}

const OBSOLETE_CRITERION_TEXT = '至少一次工具调用，或结构化声明"无需工具"（C1.2 守卫的数据化）'
const DIRECT_ANSWER_CRITERION_TEXT = '最终回复存在且非空（assistant_response digest 即合法 proof）'

function parseRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseArray(raw: string | null | undefined): unknown[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasOnlyString(values: unknown, expected: string): boolean {
  return Array.isArray(values) && values.length === 1 && values[0] === expected
}

function hasStrictObsoleteCriteria(raw: string | null): boolean {
  const criteria = parseRecord(raw)
  const items = criteria?.items
  if (!Array.isArray(items) || items.length !== 1) return false
  const item = record(items[0])
  return Boolean(
    item
    && item.id === 'c1'
    && item.kind === 'tool_call'
    && item.source === 'template'
    && item.text === OBSOLETE_CRITERION_TEXT
    && criteria?.satisfiedCount === 0
    && criteria?.totalCount === 1
  )
}

function strictObsoleteCheckIn(raw: string | null): Record<string, unknown> | null {
  const checkIns = parseArray(raw)
  if (!checkIns || checkIns.length !== 1) return null
  const checkIn = record(checkIns[0])
  if (
    !checkIn
    || checkIn.kind !== 'enforce'
    || checkIn.verdict !== 'degraded'
    || checkIn.terminalStatus !== 'done'
    || checkIn.terminalReason !== 'done'
    || checkIn.satisfiedCount !== 0
    || checkIn.totalCount !== 1
    || checkIn.proofCount !== 1
    || !hasOnlyString(checkIn.blockers, 'criteria_unsatisfied:c1')
    || typeof checkIn.ts !== 'string'
    || !checkIn.ts
  ) {
    return null
  }
  return checkIn
}

function strictAssistantProof(raw: string | null): Record<string, unknown> | null {
  const proofs = parseArray(raw)
  if (!proofs || proofs.length !== 1) return null
  const proof = record(proofs[0])
  if (
    !proof
    || proof.kind !== 'assistant_response'
    || typeof proof.ref !== 'string'
    || !proof.ref.trim()
    || typeof proof.digest !== 'string'
    || !proof.digest.trim()
  ) {
    return null
  }
  return proof
}

function hasStrictBootstrapBudget(raw: string | null): boolean {
  const budget = parseRecord(raw)
  return Boolean(
    budget
    && budget.taskType === 'short_task'
    && budget.bootstrapBudget === true
    && budget.maxIterations === 24
    && budget.maxToolCalls === 24
    && budget.maxParallelToolGroups === 5
    && budget.reservedToolCalls === 0
    && budget.iterationsUsed === 1
    && budget.toolCallsUsed === 0
    && budget.parallelToolGroupsUsed === 0
    && budget.stepBudget === null
    && budget.frozen === false
  )
}

function hasStrictRunBudget(raw: string | null): boolean {
  const budget = parseRecord(raw)
  return Boolean(
    budget
    && budget.maxIterations === 24
    && budget.maxToolCalls === 24
    && budget.maxParallelToolGroups === 5
    && budget.reservedToolCalls === 0
    && budget.iterationsUsed === 1
    && budget.toolCallsUsed === 0
    && budget.parallelToolGroupsUsed === 0
  )
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
}

function hasStrictInertSinglePathDeliveryState(raw: string | null): boolean {
  if (raw === null) return true
  const state = parseRecord(raw)
  const verifier = record(state?.verifier)
  const usage = record(state?.usage)
  if (!state || !verifier || !usage) return false
  return Boolean(
    hasExactKeys(state, [
      'decision',
      'packages',
      'parentGeneration',
      'stateRevision',
      'usage',
      'verifier',
      'version',
    ])
    && hasExactKeys(verifier, ['repaired', 'status'])
    && hasExactKeys(usage, [
      'inputTokens',
      'missingCallCount',
      'outputTokens',
      'providerCallCount',
      'totalTokens',
      'usageSource',
    ])
    && state.version === 1
    && state.stateRevision === 0
    && state.decision === 'single_path'
    && Number.isInteger(state.parentGeneration)
    && Number(state.parentGeneration) >= 0
    && Array.isArray(state.packages)
    && state.packages.length === 0
    && verifier.status === 'not_required'
    && verifier.repaired === false
    && usage.inputTokens === 0
    && usage.outputTokens === 0
    && usage.totalTokens === 0
    && usage.usageSource === 'missing'
    && usage.providerCallCount === 0
    && usage.missingCallCount === 0
  )
}

function directAnswerProjectionBudget(raw: string): string {
  const budget = parseRecord(raw)!
  return JSON.stringify({
    ...budget,
    taskType: 'direct_answer',
    maxIterations: 8,
    maxToolCalls: 8,
    bootstrapBudget: false,
  })
}

function directAnswerRunBudget(raw: string): string {
  const budget = parseRecord(raw)!
  return JSON.stringify({
    ...budget,
    maxIterations: 8,
    maxToolCalls: 8,
  })
}

function matchesMessage(
  row: MessageRow,
  candidate: CandidateRow,
  proof: Record<string, unknown>
): boolean {
  const meta = parseRecord(row.meta_json)
  const snapshot = record(meta?.taskSnapshot)
  const fullText = row.content.trim()
  const proofRef = typeof proof.ref === 'string' ? proof.ref.trim() : ''
  const proofDigest = typeof proof.digest === 'string' ? proof.digest.trim() : ''
  return Boolean(
    meta
    && snapshot
    && meta.runId === candidate.run_id
    && snapshot.scopeId === candidate.scope_id
    && snapshot.taskId === candidate.task_id
    && snapshot.phase === 'error'
    && snapshot.terminalReason === 'adjudication_degraded'
    && fullText
    && proofRef === fullText.slice(0, 120)
    && proofDigest === createHash('sha256').update(fullText).digest('hex')
    && fullText === String(candidate.last_message_text || '').trim()
  )
}

function completedMessageMeta(raw: string): string {
  const meta = parseRecord(raw)!
  const snapshot = record(meta.taskSnapshot)!
  return JSON.stringify({
    ...meta,
    taskSnapshot: {
      ...snapshot,
      phase: 'done',
      terminalReason: 'done',
      waitingFor: 'none',
      resumableActions: [],
      blockedReason: null,
      error: null,
    },
  })
}

/** Repair only the production signature created by the stale bootstrap type bug. */
// run-finalizer-exempt: migration-077 repairs persisted legacy false failures only
export function migrateFalseFailedDirectAnswers(
  db: DirectAnswerHistoryMigrationDatabase
): number {
  const candidates = db.prepare(`
    SELECT
      p.task_id,
      p.scope_id,
      p.run_id,
      p.budget_json,
      p.criteria_json,
      p.checkins_json,
      p.proof_refs_json,
      p.steps_json,
      p.recent_artifacts_json,
      p.resumable_actions_json,
      p.delivery_state_json,
      r.budget_json AS run_budget_json,
      r.last_message_text
    FROM task_projections p
    JOIN run_meta r
      ON r.run_id = p.run_id
      AND r.task_id = p.task_id
      AND r.scope_id = p.scope_id
    WHERE p.status = 'failed'
      AND p.task_type = 'direct_answer'
      AND p.module = 'system'
      AND p.interaction_state = 'suspended'
      AND p.waiting_for = 'none'
      AND p.model_criteria_json IS NULL
      AND p.expected_outputs_json IS NULL
      AND p.continuation_ref_json IS NULL
      AND p.blocked_reason IS NULL
      AND p.degradation_reason IS NULL
      AND r.status = 'error'
      AND r.task_type = 'short_task'
      AND r.terminal_reason = 'adjudication_degraded'
  `).all<CandidateRow>()
  const findMessages = db.prepare(`
    SELECT id, content, meta_json
    FROM chat_messages
    WHERE conversation_id = ?
      AND role = 'assistant'
      AND TRIM(content) <> ''
  `)
  const updateProjection = db.prepare(`
    UPDATE task_projections
    SET status = 'completed',
        interaction_state = 'suspended',
        waiting_for = 'none',
        resumable_actions_json = '[]',
        blocked_reason = NULL,
        degradation_reason = NULL,
        task_type = 'direct_answer',
        budget_json = ?,
        budget_usage_percent = 13,
        budget_warning_level = 'none',
        criteria_json = ?,
        checkins_json = ?
    WHERE task_id = ?
      AND status = 'failed'
  `)
  const updateRun = db.prepare(`
    UPDATE run_meta
    SET status = 'done',
        task_type = 'direct_answer',
        terminal_reason = 'done',
        budget_json = ?
    WHERE run_id = ?
      AND task_id = ?
      AND status = 'error'
      AND terminal_reason = 'adjudication_degraded'
  `)
  const updateMessage = db.prepare(`
    UPDATE chat_messages
    SET meta_json = ?
    WHERE id = ?
  `)

  let repaired = 0
  for (const candidate of candidates) {
    if (
      !hasStrictBootstrapBudget(candidate.budget_json)
      || !hasStrictRunBudget(candidate.run_budget_json)
      || !hasStrictInertSinglePathDeliveryState(candidate.delivery_state_json)
      || !hasStrictObsoleteCriteria(candidate.criteria_json)
      || parseArray(candidate.steps_json)?.length !== 0
      || parseArray(candidate.recent_artifacts_json)?.length !== 0
      || !hasOnlyString(parseArray(candidate.resumable_actions_json), 'retry')
    ) {
      continue
    }
    const checkIn = strictObsoleteCheckIn(candidate.checkins_json)
    const proof = strictAssistantProof(candidate.proof_refs_json)
    if (!checkIn || !proof) continue
    const messages = findMessages
      .all<MessageRow>(candidate.scope_id)
      .filter((message) => matchesMessage(message, candidate, proof))
    if (messages.length !== 1) continue

    const acceptedCheckIn = {
      ...checkIn,
      verdict: 'accept',
      satisfiedCount: 1,
      blockers: [],
    }
    updateProjection.run(
      directAnswerProjectionBudget(candidate.budget_json!),
      JSON.stringify({
        items: [{
          id: 'c1',
          kind: 'response_digest',
          text: DIRECT_ANSWER_CRITERION_TEXT,
          source: 'template',
        }],
        satisfiedCount: 1,
        totalCount: 1,
      }),
      JSON.stringify([acceptedCheckIn]),
      candidate.task_id,
    )
    updateRun.run(
      directAnswerRunBudget(candidate.run_budget_json!),
      candidate.run_id,
      candidate.task_id,
    )
    updateMessage.run(completedMessageMeta(messages[0].meta_json!), messages[0].id)
    repaired += 1
  }
  return repaired
}
