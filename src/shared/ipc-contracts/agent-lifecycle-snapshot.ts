import { z } from 'zod'

export type LifecycleOperationSnapshot =
  | 'idle_never_started'
  | 'idle_ready_terminal_no_native'
  | 'idle_native_thread'
  | 'thread_start_pending'
  | 'turn_start_pending'
  | 'product_turn_interruptible'
  | 'product_turn_interrupt_unknown'
  | 'product_turn_engine_terminal_closeout_pending'
  | 'host_failure_closeout_pending'
  | 'manual_compaction_pending'
  | 'manual_compaction_unknown'
  | 'invariant_violation'

/** Read-only projection of the database-owned lifecycle state for Renderer reloads. */
export type LifecycleOperationProjection = {
  identity: { aliasId: string; aliasGeneration: number }
  activeReadyRunId: string | null
  latestReadyRunId: string | null
  snapshot: LifecycleOperationSnapshot
  interruptRequested: boolean
  interruptAcknowledged: boolean
  requestedAction: 'stop' | 'close' | 'reset' | null
  evidenceDigest: string
}

const lifecycleOperationSnapshotSchema = z.enum([
  'idle_never_started',
  'idle_ready_terminal_no_native',
  'idle_native_thread',
  'thread_start_pending',
  'turn_start_pending',
  'product_turn_interruptible',
  'product_turn_interrupt_unknown',
  'product_turn_engine_terminal_closeout_pending',
  'host_failure_closeout_pending',
  'manual_compaction_pending',
  'manual_compaction_unknown',
  'invariant_violation',
])

export const lifecycleOperationProjectionSchema: z.ZodType<LifecycleOperationProjection> = z.object({
  identity: z.object({
    aliasId: z.string().min(1),
    aliasGeneration: z.number().int().positive(),
  }).strict(),
  activeReadyRunId: z.string().min(1).nullable(),
  latestReadyRunId: z.string().min(1).nullable(),
  snapshot: lifecycleOperationSnapshotSchema,
  interruptRequested: z.boolean(),
  interruptAcknowledged: z.boolean(),
  requestedAction: z.enum(['stop', 'close', 'reset']).nullable(),
  evidenceDigest: z.string().min(1),
}).strict()

export function parseLifecycleOperationProjection(value: unknown): LifecycleOperationProjection {
  return lifecycleOperationProjectionSchema.parse(value)
}

export type LifecycleOperationFacts = {
  readyRunCreated: boolean
  codexThreadId: string | null
  codexTurnId: string | null
  activeFence: 'product_turn' | 'manual_compaction' | null
  threadStartUnreconciled: boolean
  turnStartUnreconciled: boolean
  productRunNonterminal: boolean
  interruptStateUnknown: boolean
  engineTerminalRecorded: boolean
  readyCloseoutCommitted: boolean
  readyTerminalWithoutNativeThread: boolean
  allNativeThreadAttemptsSettled: boolean
  hostFailureEvidenceComplete: boolean
  hostFailureProductTerminalCommitted: boolean
  manualCompactionState: 'none' | 'pending' | 'unknown' | 'consumed'
}

function exactlyOne(values: LifecycleOperationSnapshot[]): LifecycleOperationSnapshot {
  return values.length === 1 ? values[0] : 'invariant_violation'
}

export function classifyLifecycleOperation(
  facts: LifecycleOperationFacts,
): LifecycleOperationSnapshot {
  const matches: LifecycleOperationSnapshot[] = []

  if (
    facts.hostFailureEvidenceComplete
    && !facts.hostFailureProductTerminalCommitted
  ) {
    matches.push('host_failure_closeout_pending')
  }

  if (
    facts.manualCompactionState === 'unknown'
    && facts.activeFence === 'manual_compaction'
  ) {
    matches.push('manual_compaction_unknown')
  }
  if (
    facts.manualCompactionState === 'pending'
    && facts.activeFence === 'manual_compaction'
  ) {
    matches.push('manual_compaction_pending')
  }

  if (
    facts.threadStartUnreconciled
    && !facts.codexThreadId
    && !(facts.hostFailureEvidenceComplete && !facts.hostFailureProductTerminalCommitted)
  ) {
    matches.push('thread_start_pending')
  }
  if (
    facts.turnStartUnreconciled
    && Boolean(facts.codexThreadId)
    && !facts.codexTurnId
    && !facts.hostFailureEvidenceComplete
  ) {
    matches.push('turn_start_pending')
  }

  if (
    facts.activeFence === 'product_turn'
    && Boolean(facts.codexThreadId)
    && Boolean(facts.codexTurnId)
    && !facts.engineTerminalRecorded
    && !facts.interruptStateUnknown
  ) {
    matches.push('product_turn_interruptible')
  }
  if (
    facts.activeFence === 'product_turn'
    && Boolean(facts.codexThreadId)
    && Boolean(facts.codexTurnId)
    && !facts.engineTerminalRecorded
    && facts.interruptStateUnknown
  ) {
    matches.push('product_turn_interrupt_unknown')
  }
  if (
    facts.activeFence === 'product_turn'
    && Boolean(facts.codexThreadId)
    && Boolean(facts.codexTurnId)
    && facts.engineTerminalRecorded
    && !facts.readyCloseoutCommitted
  ) {
    matches.push('product_turn_engine_terminal_closeout_pending')
  }

  const idleBase =
    facts.activeFence === null
    && !facts.threadStartUnreconciled
    && !facts.turnStartUnreconciled
    && !facts.productRunNonterminal
    && !(facts.hostFailureEvidenceComplete && !facts.hostFailureProductTerminalCommitted)
    && (facts.manualCompactionState === 'none' || facts.manualCompactionState === 'consumed')

  if (
    idleBase
    && !facts.readyRunCreated
    && !facts.codexThreadId
    && !facts.readyTerminalWithoutNativeThread
  ) {
    matches.push('idle_never_started')
  }
  if (
    idleBase
    && !facts.codexThreadId
    && facts.readyTerminalWithoutNativeThread
  ) {
    matches.push('idle_ready_terminal_no_native')
  }
  if (
    idleBase
    && Boolean(facts.codexThreadId)
    && facts.allNativeThreadAttemptsSettled
  ) {
    matches.push('idle_native_thread')
  }

  return exactlyOne(matches)
}
