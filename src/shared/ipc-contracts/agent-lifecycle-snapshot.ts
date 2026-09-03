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

export type LifecycleActionBlockingReason =
  | 'no_active_operation'
  | 'thread_busy'
  | 'interrupt_state_unknown'
  | 'manual_compaction_pending'
  | 'manual_compaction_unknown'
  | 'history_materializing'
  | 'history_outcome_unknown'
  | 'legacy_context_boundary'
  | 'head_contract_drift'
  | 'legacy_prepared_contract'

export type LifecycleActionRequestRef =
  | {
      ownerKind: 'run_owner'
      action: 'stop' | 'reset' | 'close'
      aliasId: string
      scopeId: string
      scopeEpoch: number
      aliasGeneration: number
      targetReadyRunId: string
      lifecycleEvidenceDigest: string
      headProjectionDigest: string
      digest: string
    }
  | {
      ownerKind: 'head_owner'
      action: 'reset' | 'close' | 'manual_compact'
      aliasId: string
      scopeId: string
      scopeEpoch: number
      aliasGeneration: number
      threadBindingId: string
      headRevision: number
      materializationIntentRef: { id: string; digest: string } | null
      lifecycleEvidenceDigest: string
      headProjectionDigest: string
      digest: string
    }

export type LifecycleActionGate = {
  availability: 'ready' | 'blocked' | 'not_applicable'
  blockers: LifecycleActionBlockingReason[]
  requestRef: LifecycleActionRequestRef | null
}

export type LifecycleOperationProjectionV2 = LifecycleOperationProjection & {
  contractVersion: 'ready_lifecycle_operation_projection_v2'
  scopeId: string
  scopeEpoch: number
  headProjectionRef: {
    version: { scopeEpoch: number; headGeneration: number; actionProjectionSequence: number }
    digest: string
  }
  actions: {
    stop: LifecycleActionGate
    reset: LifecycleActionGate
    close: LifecycleActionGate
    manual_compact: LifecycleActionGate
  }
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

const lifecycleOperationProjectionObjectSchema = z.object({
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

export const lifecycleOperationProjectionSchema: z.ZodType<LifecycleOperationProjection> =
  lifecycleOperationProjectionObjectSchema

const lifecycleActionRequestRefSchema: z.ZodType<LifecycleActionRequestRef> = z.discriminatedUnion(
  'ownerKind',
  [
    z.object({
      ownerKind: z.literal('run_owner'),
      action: z.enum(['stop', 'reset', 'close']),
      aliasId: z.string().min(1),
      scopeId: z.string().min(1),
      scopeEpoch: z.number().int().nonnegative(),
      aliasGeneration: z.number().int().positive(),
      targetReadyRunId: z.string().min(1),
      lifecycleEvidenceDigest: z.string().min(1),
      headProjectionDigest: z.string().min(1),
      digest: z.string().min(1),
    }).strict(),
    z.object({
      ownerKind: z.literal('head_owner'),
      action: z.enum(['reset', 'close', 'manual_compact']),
      aliasId: z.string().min(1),
      scopeId: z.string().min(1),
      scopeEpoch: z.number().int().nonnegative(),
      aliasGeneration: z.number().int().positive(),
      threadBindingId: z.string().min(1),
      headRevision: z.number().int().positive(),
      materializationIntentRef: z.object({
        id: z.string().min(1),
        digest: z.string().min(1),
      }).strict().nullable(),
      lifecycleEvidenceDigest: z.string().min(1),
      headProjectionDigest: z.string().min(1),
      digest: z.string().min(1),
    }).strict(),
  ],
)

export { lifecycleActionRequestRefSchema }

const lifecycleActionGateSchema: z.ZodType<LifecycleActionGate> = z.object({
  availability: z.enum(['ready', 'blocked', 'not_applicable']),
  blockers: z.array(z.enum([
    'no_active_operation',
    'thread_busy',
    'interrupt_state_unknown',
    'manual_compaction_pending',
    'manual_compaction_unknown',
    'history_materializing',
    'history_outcome_unknown',
    'legacy_context_boundary',
    'head_contract_drift',
    'legacy_prepared_contract',
  ])),
  requestRef: lifecycleActionRequestRefSchema.nullable(),
}).strict()

export const lifecycleOperationProjectionV2Schema: z.ZodType<LifecycleOperationProjectionV2> =
  lifecycleOperationProjectionObjectSchema.extend({
    contractVersion: z.literal('ready_lifecycle_operation_projection_v2'),
    scopeId: z.string().min(1),
    scopeEpoch: z.number().int().nonnegative(),
    headProjectionRef: z.object({
      version: z.object({
        scopeEpoch: z.number().int().nonnegative(),
        headGeneration: z.number().int().positive(),
        actionProjectionSequence: z.number().int().nonnegative(),
      }).strict(),
      digest: z.string().min(1),
    }).strict(),
    actions: z.object({
      stop: lifecycleActionGateSchema,
      reset: lifecycleActionGateSchema,
      close: lifecycleActionGateSchema,
      manual_compact: lifecycleActionGateSchema,
    }).strict(),
  }).strict()

export function parseLifecycleOperationProjection(value: unknown): LifecycleOperationProjection {
  return lifecycleOperationProjectionV2Schema.safeParse(value).success
    ? lifecycleOperationProjectionV2Schema.parse(value)
    : lifecycleOperationProjectionSchema.parse(value)
}

export function parseLifecycleOperationProjectionV2(value: unknown): LifecycleOperationProjectionV2 {
  return lifecycleOperationProjectionV2Schema.parse(value)
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
