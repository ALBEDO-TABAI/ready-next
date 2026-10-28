import { CodexBindingRepositoryError } from '../codex-binding-error'
import type { CodexBindingContext } from './context'
import { requireThread, requireTurn } from './core'
import { changes, codexLifecycleActionEvidence, nonEmpty, safePositive } from './shared'
import type { CodexLifecycleAction, CodexProductInterruptOwnerRead, CodexProductLifecycleActionRead } from './types'

// Product interrupt ownership and acknowledgement.

export function resolveProductInterruptOwner(context: CodexBindingContext, input: {
  aliasId: string
  aliasGeneration: number
  readyRunId?: string
  codexThreadId: string
  codexTurnId: string
}): CodexProductInterruptOwnerRead {
  nonEmpty(input.aliasId, 'interrupt_alias_id_invalid')
  safePositive(input.aliasGeneration, 'interrupt_alias_generation_invalid')
  if (input.readyRunId !== undefined) nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.codexThreadId, 'interrupt_thread_id_invalid')
  nonEmpty(input.codexTurnId, 'interrupt_turn_id_invalid')
  const rows = context.db.prepare(`
      SELECT turn.ready_run_id, turn.ready_task_id,
             thread.ready_scope_id, thread.ready_conversation_alias
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread
          ON thread.thread_binding_id = turn.thread_binding_id
        JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = turn.thread_binding_id
         AND fence.operation_kind = 'product_turn'
         AND fence.owner_ready_run_id = turn.ready_run_id
       WHERE thread.ready_conversation_alias = ?
         AND thread.alias_generation = ?
         AND (? IS NULL OR turn.ready_run_id = ?)
         AND thread.retired_at IS NULL
         AND thread.codex_thread_id = ?
         AND turn.codex_thread_id = ?
         AND turn.codex_turn_id = ?
         AND turn.product_terminal_digest IS NULL
         AND turn.host_failure_product_terminal_digest IS NULL
         AND fence.quarantined_at IS NULL
    `).all<{
    ready_run_id: string
    ready_task_id: string
    ready_scope_id: string
    ready_conversation_alias: string
  }>(
    input.aliasId,
    input.aliasGeneration,
    input.readyRunId ?? null,
    input.readyRunId ?? null,
    input.codexThreadId,
    input.codexThreadId,
    input.codexTurnId,
  )
  if (rows.length !== 1) {
    throw new CodexBindingRepositoryError('product_interrupt_owner_mismatch')
  }
  return {
    readyRunId: rows[0].ready_run_id,
    readyTaskId: rows[0].ready_task_id,
    readyScopeId: rows[0].ready_scope_id,
    readyAliasId: rows[0].ready_conversation_alias,
  }
}

export function requestProductInterrupt(context: CodexBindingContext, input: {
  action: CodexLifecycleAction
  aliasId: string
  aliasGeneration: number
  readyRunId?: string
  codexThreadId: string
  codexTurnId: string
  requestedAt: string
}): CodexProductLifecycleActionRead

export function requestProductInterrupt(context: CodexBindingContext, input: {
  action?: null
  aliasId: string
  aliasGeneration: number
  readyRunId?: string
  codexThreadId: string
  codexTurnId: string
  requestedAt: string
}): CodexProductInterruptOwnerRead

export function requestProductInterrupt(context: CodexBindingContext, input: {
  action?: CodexLifecycleAction | null
  aliasId: string
  aliasGeneration: number
  readyRunId?: string
  codexThreadId: string
  codexTurnId: string
  requestedAt: string
}): CodexProductInterruptOwnerRead | CodexProductLifecycleActionRead {
  nonEmpty(input.requestedAt, 'interrupt_requested_at_invalid')
  const owner = context.self.resolveProductInterruptOwner(input)
  return context.immediate(() => {
    const row = requireTurn(context, owner.readyRunId)
    if (input.action && row.lifecycle_action) {
      if (row.lifecycle_action !== input.action) {
        throw new CodexBindingRepositoryError('product_lifecycle_action_conflict')
      }
      if (!row.lifecycle_action_requested_at || !row.lifecycle_action_evidence_digest) {
        throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_missing')
      }
      const expectedDigest = codexLifecycleActionEvidence({
        ...owner,
        action: row.lifecycle_action,
        aliasGeneration: input.aliasGeneration,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        requestedAt: row.lifecycle_action_requested_at,
      })
      if (expectedDigest !== row.lifecycle_action_evidence_digest) {
        throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_mismatch')
      }
      return {
        ...owner,
        aliasGeneration: input.aliasGeneration,
        threadBindingId: row.thread_binding_id,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        lifecycleAction: row.lifecycle_action,
        lifecycleActionRequestedAt: row.lifecycle_action_requested_at,
        lifecycleActionEvidenceDigest: row.lifecycle_action_evidence_digest,
      }
    }
    if (input.action && row.interrupt_requested_at && !row.lifecycle_action) {
      throw new CodexBindingRepositoryError('product_lifecycle_action_conflict')
    }
    if (!input.action && row.interrupt_requested_at) return owner
    const lifecycleActionEvidenceDigest = input.action
      ? codexLifecycleActionEvidence({
          ...owner,
          action: input.action,
          aliasGeneration: input.aliasGeneration,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          requestedAt: input.requestedAt,
        })
      : null
    const updated = context.db.prepare(`
        UPDATE codex_turn_bindings
           SET interrupt_requested_at = ?, lifecycle_action = ?,
               lifecycle_action_requested_at = ?, lifecycle_action_evidence_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND interrupt_requested_at IS NULL
           AND lifecycle_action IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(
      input.requestedAt,
      input.action || null,
      input.action ? input.requestedAt : null,
      lifecycleActionEvidenceDigest,
      input.requestedAt,
      owner.readyRunId,
      row.revision,
    )
    if (changes(updated) !== 1) {
      throw new CodexBindingRepositoryError('interrupt_request_cas_failed')
    }
    return input.action
      ? {
          ...owner,
          aliasGeneration: input.aliasGeneration,
          threadBindingId: row.thread_binding_id,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          lifecycleAction: input.action,
          lifecycleActionRequestedAt: input.requestedAt,
          lifecycleActionEvidenceDigest: lifecycleActionEvidenceDigest as string,
        }
      : owner
  })
}

export function readProductLifecycleAction(context: CodexBindingContext, readyRunId: string): CodexProductLifecycleActionRead | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const turn = requireTurn(context, readyRunId)
  if (!turn.lifecycle_action) return null
  if (!turn.lifecycle_action_requested_at || !turn.lifecycle_action_evidence_digest
    || !turn.codex_thread_id || !turn.codex_turn_id) {
    throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_missing')
  }
  const thread = requireThread(context, turn.thread_binding_id)
  const owner: CodexProductInterruptOwnerRead = {
    readyRunId: turn.ready_run_id,
    readyTaskId: turn.ready_task_id,
    readyScopeId: thread.ready_scope_id,
    readyAliasId: thread.ready_conversation_alias,
  }
  if (codexLifecycleActionEvidence({
    ...owner,
    action: turn.lifecycle_action,
    aliasGeneration: thread.alias_generation,
    codexThreadId: turn.codex_thread_id,
    codexTurnId: turn.codex_turn_id,
    requestedAt: turn.lifecycle_action_requested_at,
  }) !== turn.lifecycle_action_evidence_digest) {
    throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_mismatch')
  }
  return {
    ...owner,
    aliasGeneration: thread.alias_generation,
    threadBindingId: turn.thread_binding_id,
    codexThreadId: turn.codex_thread_id,
    codexTurnId: turn.codex_turn_id,
    lifecycleAction: turn.lifecycle_action,
    lifecycleActionRequestedAt: turn.lifecycle_action_requested_at,
    lifecycleActionEvidenceDigest: turn.lifecycle_action_evidence_digest,
  }
}

export function acknowledgeProductInterrupt(context: CodexBindingContext, input: {
  readyRunId: string
  acknowledgedAt: string
}): void {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.acknowledgedAt, 'interrupt_ack_at_invalid')
  context.immediate(() => {
    const row = requireTurn(context, input.readyRunId)
    if (!row.interrupt_requested_at) {
      throw new CodexBindingRepositoryError('interrupt_request_missing')
    }
    if (row.interrupt_ack_at) return
    const updated = context.db.prepare(`
        UPDATE codex_turn_bindings
           SET interrupt_ack_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND interrupt_requested_at IS NOT NULL AND interrupt_ack_at IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(input.acknowledgedAt, input.acknowledgedAt, input.readyRunId, row.revision)
    if (changes(updated) !== 1) {
      throw new CodexBindingRepositoryError('interrupt_ack_cas_failed')
    }
  })
}

export function markProductInterruptUnknown(context: CodexBindingContext, input: {
  readyRunId: string
  unknownAt: string
}): void {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.unknownAt, 'interrupt_unknown_at_invalid')
  context.immediate(() => {
    const row = requireTurn(context, input.readyRunId)
    if (!row.interrupt_requested_at) {
      throw new CodexBindingRepositoryError('interrupt_request_missing')
    }
    if (row.interrupt_state_unknown_at) return
    const updated = context.db.prepare(`
        UPDATE codex_turn_bindings
           SET interrupt_state_unknown_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND interrupt_requested_at IS NOT NULL AND interrupt_state_unknown_at IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(input.unknownAt, input.unknownAt, input.readyRunId, row.revision)
    if (changes(updated) !== 1) {
      throw new CodexBindingRepositoryError('interrupt_unknown_cas_failed')
    }
  })
}
