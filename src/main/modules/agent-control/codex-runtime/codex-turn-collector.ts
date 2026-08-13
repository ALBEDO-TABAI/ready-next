import { createHash } from 'node:crypto'

import type {
  CodexAgentMessageItem,
  CodexNativeNotification,
  CodexNativeRuntime,
  CodexThreadItem,
  CodexTurn,
} from './codex-native-runtime'
import { digestCanonicalJson } from './codex-model-gateway-contract'

type CoreTurnCandidateBase = {
  readyTaskId: string
  readyRunId: string
  scopeId: string
  engineOutcome: 'completed' | 'interrupted' | 'failed'
  candidateSelection:
    | { kind: 'accepted'; itemId: string }
    | { kind: 'none'; code: 'terminal_not_completed' }
    | {
        kind: 'protocol_failure'
        code:
          | 'unknown_message_phase'
          | 'delta_completed_mismatch'
          | 'multiple_explicit_finals'
          | 'null_after_explicit_final'
          | 'no_legal_candidate'
          | 'turn_identity_mismatch'
          | 'model_rerouted'
          | 'native_host_failure'
      }
  candidateText: string | null
  candidateDigest: string | null
  usedToolCalls: Array<{
    itemId: string
    tool: string
    status: string
    success: boolean | null
    responseDigest?: string | null
  }>
  actionReceiptRefs: string[]
  interactionState: string | null
  waitingFor: string | null
  terminalReasonCandidate: string
  abortInitiator: string | null
  budgetState: Record<string, unknown>
  contextState: Record<string, unknown>
  providerDiagnostics: Record<string, unknown>
  recoveryCheckpointRef: string | null
  browserContinuationRef: string | null
  browserProofRefs: string[]
  otherProofRefs: string[]
  projectionPatchRefs: string[]
  runtimeDiagnostics: {
    finalDeltaItemIds: string[]
    commentaryItemIds: string[]
    nativeTurnError: string | null
  }
}

export type CodexHostFailureStage =
  | 'prepared_run_validation'
  | 'started_projection'
  | 'prepared_run_context'
  | 'identity_read'
  | 'thread_resolution'
  | 'turn_input'
  | 'turn_start'
  | 'terminal_timeout'
  | 'native_error_notification'
  | 'collection'

export type CoreTurnCandidate =
  | CoreTurnCandidateBase & {
      kind: 'native_terminal'
      codexThreadId: string
      codexTurnId: string
      hostFailure?: never
    }
  | CoreTurnCandidateBase & {
      kind: 'host_failure'
      codexThreadId: string | null
      codexTurnId: string | null
      engineOutcome: 'failed'
      candidateSelection: { kind: 'protocol_failure'; code: 'native_host_failure' }
      candidateText: null
      candidateDigest: null
      hostFailure: {
        stage: CodexHostFailureStage
        code: string
        message: string
        evidenceDigest: string
      }
    }

export type CodexTurnCollectionContext = {
  readyTaskId: string
  readyRunId: string
  scopeId: string
  codexThreadId: string
  startTurn: () => Promise<{ turn: CodexTurn }>
  terminalTimeoutMs: number
  actionReceiptRefs: string[]
  interactionState: string | null
  waitingFor: string | null
  terminalReasonCandidate: string
  abortInitiator: string | null
  budgetState: Record<string, unknown>
  contextState: Record<string, unknown>
  providerDiagnostics: Record<string, unknown>
  recoveryCheckpointRef: string | null
  browserContinuationRef: string | null
  browserProofRefs: string[]
  otherProofRefs: string[]
  projectionPatchRefs: string[]
  allowNullPhaseFallback: boolean
  allowDirectProvisionalStream: boolean
  onProvisionalDelta: (event: {
    threadId: string
    turnId: string
    itemId: string
    delta: string
    reversible: true
  }) => void
  onActivity?: (event: CodexTurnActivityEvent) => void
}

export type CodexTurnActivityEvent =
  | {
      kind: 'item'
      stage: 'started' | 'completed'
      atMs: number
      item: CodexThreadItem
    }
  | {
      kind: 'narration'
      source: 'commentary' | 'reasoning_summary'
      stage: 'streaming' | 'completed'
      atMs: number
      itemId: string
      text: string
    }

export type CodexTurnReadbackContext = Pick<
  CodexTurnCollectionContext,
  | 'readyTaskId'
  | 'readyRunId'
  | 'scopeId'
  | 'codexThreadId'
  | 'actionReceiptRefs'
  | 'interactionState'
  | 'waitingFor'
  | 'terminalReasonCandidate'
  | 'abortInitiator'
  | 'budgetState'
  | 'contextState'
  | 'providerDiagnostics'
  | 'recoveryCheckpointRef'
  | 'browserContinuationRef'
  | 'browserProofRefs'
  | 'otherProofRefs'
  | 'projectionPatchRefs'
  | 'allowNullPhaseFallback'
>

type AgentMessageRecord = {
  item: CodexAgentMessageItem
  order: number
  deltas: string[]
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeEngineOutcome(status: CodexTurn['status']): CoreTurnCandidate['engineOutcome'] {
  if (status === 'interrupted') return 'interrupted'
  if (status === 'failed') return 'failed'
  return 'completed'
}

function resolveTerminalReasonCandidate(
  hint: string,
  status: CodexTurn['status'],
): string {
  if (hint !== 'done') return hint
  if (status === 'failed') return 'blocked_external'
  if (status === 'interrupted') return 'cancelled_runtime'
  return hint
}

type HostFailureCandidateContext = Pick<
  CodexTurnCollectionContext,
  | 'readyTaskId'
  | 'readyRunId'
  | 'scopeId'
  | 'actionReceiptRefs'
  | 'interactionState'
  | 'waitingFor'
  | 'abortInitiator'
  | 'budgetState'
  | 'contextState'
  | 'providerDiagnostics'
  | 'recoveryCheckpointRef'
  | 'browserContinuationRef'
  | 'browserProofRefs'
  | 'otherProofRefs'
  | 'projectionPatchRefs'
> & {
  codexThreadId: string | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createHostFailureCandidate(
  context: HostFailureCandidateContext,
  failure: {
    stage: CodexHostFailureStage
    code: string
    error: unknown
    codexTurnId: string | null
  },
): Extract<CoreTurnCandidate, { kind: 'host_failure' }> {
  const message = errorMessage(failure.error)
  return {
    kind: 'host_failure',
    readyTaskId: context.readyTaskId,
    readyRunId: context.readyRunId,
    scopeId: context.scopeId,
    codexThreadId: context.codexThreadId,
    codexTurnId: failure.codexTurnId,
    engineOutcome: 'failed',
    candidateSelection: { kind: 'protocol_failure', code: 'native_host_failure' },
    candidateText: null,
    candidateDigest: null,
    usedToolCalls: [],
    actionReceiptRefs: [...context.actionReceiptRefs],
    interactionState: context.interactionState,
    waitingFor: context.waitingFor,
    terminalReasonCandidate: 'persistence_failed',
    abortInitiator: context.abortInitiator,
    budgetState: { ...context.budgetState },
    contextState: { ...context.contextState },
    providerDiagnostics: {
      ...context.providerDiagnostics,
      nativeHostFailureStage: failure.stage,
      nativeHostFailureCode: failure.code,
    },
    recoveryCheckpointRef: context.recoveryCheckpointRef,
    browserContinuationRef: context.browserContinuationRef,
    browserProofRefs: [...context.browserProofRefs],
    otherProofRefs: [...context.otherProofRefs],
    projectionPatchRefs: [...context.projectionPatchRefs],
    runtimeDiagnostics: {
      finalDeltaItemIds: [],
      commentaryItemIds: [],
      nativeTurnError: message,
    },
    hostFailure: {
      stage: failure.stage,
      code: failure.code,
      message,
      evidenceDigest: createHash('sha256')
        .update([
          context.readyTaskId,
          context.readyRunId,
          context.scopeId,
          context.codexThreadId || '',
          failure.codexTurnId || '',
          failure.stage,
          failure.code,
          message,
        ].join('\u0000'))
        .digest('hex'),
    },
  }
}

export class CodexTurnCollector {
  private readonly activeRuns = new Set<string>()
  private readonly recoveryWaiters = new Map<string, {
    readyTaskId: string
    scopeId: string
    codexThreadId: string
    resolve: (candidate: CoreTurnCandidate) => void
  }>()

  constructor(private readonly nativeRuntime: CodexNativeRuntime) {}

  deliverRecoveredCandidate(candidate: CoreTurnCandidate): boolean {
    const waiter = this.recoveryWaiters.get(candidate.readyRunId)
    if (!waiter) return this.activeRuns.has(candidate.readyRunId)
    if (candidate.readyTaskId !== waiter.readyTaskId
      || candidate.scopeId !== waiter.scopeId
      || candidate.codexThreadId !== waiter.codexThreadId) return false
    waiter.resolve(candidate)
    return true
  }

  releaseRun(readyRunId: string): void {
    this.activeRuns.delete(readyRunId)
    this.recoveryWaiters.delete(readyRunId)
  }

  async collect(context: CodexTurnCollectionContext): Promise<CoreTurnCandidate> {
    if (this.activeRuns.has(context.readyRunId)) throw new Error('codex_turn_collection_duplicate')
    this.activeRuns.add(context.readyRunId)
    const pending: CodexNativeNotification[] = []
    const items: Array<{ item: CodexThreadItem; order: number }> = []
    const itemStarts = new Map<string, CodexThreadItem>()
    const deltas = new Map<string, string[]>()
    const reasoningSummaryParts = new Map<string, Map<number, string>>()
    let expectedTurnId: string | null = null
    let terminal: CodexTurn | null = null
    let modelReroute: Extract<
      CodexNativeNotification,
      { method: 'model/rerouted' }
    >['params'] | null = null
    let nativeErrorWithoutTerminal: { turnId: string; message: string } | null = null
    let resolveTerminal: (() => void) | null = null
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve })
    let resolveRecovered: ((candidate: CoreTurnCandidate) => void) | null = null
    const recoveredPromise = new Promise<CoreTurnCandidate>((resolve) => {
      resolveRecovered = resolve
    })
    const recoveryWaiter = {
      readyTaskId: context.readyTaskId,
      scopeId: context.scopeId,
      codexThreadId: context.codexThreadId,
      resolve: (candidate: CoreTurnCandidate) => resolveRecovered?.(candidate),
    }
    this.recoveryWaiters.set(context.readyRunId, recoveryWaiter)
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let timeoutSettled = false
    let resolveTimeout: ((value: 'timeout') => void) | null = null
    const timeoutPromise = new Promise<'timeout'>((resolve) => { resolveTimeout = resolve })
    const resetTerminalTimeout = (): void => {
      if (timeoutSettled) return
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null
        timeoutSettled = true
        resolveTimeout?.('timeout')
      }, context.terminalTimeoutMs)
    }

    const processNotification = (notification: CodexNativeNotification): void => {
      if (notification.method === 'thread/started') return
      if (notification.method === 'error') {
        if (notification.params.threadId !== context.codexThreadId) return
        if (!expectedTurnId) {
          pending.push(notification)
          return
        }
        if (notification.params.turnId !== expectedTurnId) return
        resetTerminalTimeout()
        if (notification.params.willRetry) return
        nativeErrorWithoutTerminal = {
          turnId: notification.params.turnId,
          message: notification.params.error.message,
        }
        return
      }
      if (notification.params.threadId !== context.codexThreadId) return
      const turnId = notification.method === 'turn/started' || notification.method === 'turn/completed'
        ? notification.params.turn.id
        : notification.params.turnId
      if (!expectedTurnId) {
        pending.push(notification)
        return
      }
      if (turnId !== expectedTurnId) return
      resetTerminalTimeout()

      if (notification.method === 'model/rerouted') {
        modelReroute = { ...notification.params }
        return
      }
      if (modelReroute && notification.method !== 'turn/completed') return

      const publishActivity = (event: CodexTurnActivityEvent): void => {
        try {
          context.onActivity?.(event)
        } catch {
          // A projection observer never owns the native turn or its result.
        }
      }

      if (notification.method === 'item/started') {
        itemStarts.set(notification.params.item.id, notification.params.item)
        publishActivity({
          kind: 'item',
          stage: 'started',
          atMs: notification.params.startedAtMs,
          item: notification.params.item,
        })
        return
      }
      if (notification.method === 'item/reasoning/summaryPartAdded') {
        const started = itemStarts.get(notification.params.itemId)
        if (started?.type !== 'other' || started.nativeType !== 'reasoning') return
        const parts = reasoningSummaryParts.get(notification.params.itemId) || new Map<number, string>()
        if (!parts.has(notification.params.summaryIndex)) parts.set(notification.params.summaryIndex, '')
        reasoningSummaryParts.set(notification.params.itemId, parts)
        return
      }
      if (notification.method === 'item/reasoning/summaryTextDelta') {
        const started = itemStarts.get(notification.params.itemId)
        if (started?.type !== 'other' || started.nativeType !== 'reasoning') return
        const parts = reasoningSummaryParts.get(notification.params.itemId) || new Map<number, string>()
        const current = parts.get(notification.params.summaryIndex) || ''
        parts.set(notification.params.summaryIndex, `${current}${notification.params.delta}`)
        reasoningSummaryParts.set(notification.params.itemId, parts)
        publishActivity({
          kind: 'narration',
          source: 'reasoning_summary',
          stage: 'streaming',
          atMs: Date.now(),
          itemId: notification.params.itemId,
          text: [...parts.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, text]) => text)
            .join('\n'),
        })
        return
      }
      if (notification.method === 'item/agentMessage/delta') {
        const itemDeltas = deltas.get(notification.params.itemId) || []
        itemDeltas.push(notification.params.delta)
        deltas.set(notification.params.itemId, itemDeltas)
        const started = itemStarts.get(notification.params.itemId)
        if (started?.type === 'agentMessage' && started.phase === 'commentary') {
          publishActivity({
            kind: 'narration',
            source: 'commentary',
            stage: 'streaming',
            atMs: Date.now(),
            itemId: notification.params.itemId,
            text: itemDeltas.join(''),
          })
        }
        if (
          context.allowDirectProvisionalStream
          && started?.type === 'agentMessage'
          && started.phase === 'final_answer'
        ) {
          context.onProvisionalDelta({
            threadId: context.codexThreadId,
            turnId: expectedTurnId,
            itemId: notification.params.itemId,
            delta: notification.params.delta,
            reversible: true,
          })
        }
        return
      }
      if (notification.method === 'item/completed') {
        items.push({ item: notification.params.item, order: items.length })
        publishActivity({
          kind: 'item',
          stage: 'completed',
          atMs: notification.params.completedAtMs,
          item: notification.params.item,
        })
        if (
          notification.params.item.type === 'agentMessage'
          && notification.params.item.phase === 'commentary'
        ) {
          publishActivity({
            kind: 'narration',
            source: 'commentary',
            stage: 'completed',
            atMs: notification.params.completedAtMs,
            itemId: notification.params.item.id,
            text: notification.params.item.text,
          })
        }
        if (
          notification.params.item.type === 'other'
          && notification.params.item.nativeType === 'reasoning'
        ) {
          const parts = reasoningSummaryParts.get(notification.params.item.id)
          if (parts) {
            publishActivity({
              kind: 'narration',
              source: 'reasoning_summary',
              stage: 'completed',
              atMs: notification.params.completedAtMs,
              itemId: notification.params.item.id,
              text: [...parts.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, text]) => text)
                .join('\n'),
            })
          }
        }
        return
      }
      if (notification.method === 'turn/completed') {
        terminal = notification.params.turn
        resolveTerminal?.()
      }
    }

    const unsubscribe = this.nativeRuntime.subscribe(processNotification)
    try {
      const startOutcome = await Promise.race([
        context.startTurn().then(
          (started) => ({ kind: 'started' as const, started }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        ),
        recoveredPromise.then((candidate) => ({ kind: 'recovered' as const, candidate })),
      ])
      if (startOutcome.kind === 'recovered') return startOutcome.candidate
      if (startOutcome.kind === 'failed') {
        return createHostFailureCandidate(context, {
          stage: 'turn_start',
          code: 'turn_start_failed',
          error: startOutcome.error,
          codexTurnId: null,
        })
      }
      const started = startOutcome.started
      expectedTurnId = started.turn.id
      for (const notification of pending.splice(0)) processNotification(notification)

      if (!terminal) {
        resetTerminalTimeout()
        const settledBy = await Promise.race([
          terminalPromise.then(() => 'notification' as const),
          timeoutPromise,
          recoveredPromise.then((candidate) => ({ recovered: candidate } as const)),
        ])
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (typeof settledBy === 'object') return settledBy.recovered
        if (settledBy === 'timeout') {
          const settledNativeError = nativeErrorWithoutTerminal as {
            turnId: string
            message: string
          } | null
          if (settledNativeError) {
            return createHostFailureCandidate(context, {
              stage: 'native_error_notification',
              code: 'codex_nonretry_error_without_terminal',
              error: new Error(settledNativeError.message),
              codexTurnId: settledNativeError.turnId,
            })
          }
          return createHostFailureCandidate(context, {
            stage: 'terminal_timeout',
            code: 'codex_turn_terminal_timeout',
            error: new Error('codex_turn_terminal_timeout'),
            codexTurnId: expectedTurnId,
          })
        }
      }

      const settledTurn = terminal as CodexTurn | null
      if (!settledTurn || settledTurn.id !== expectedTurnId) {
        return this.buildCandidate(context, started.turn, items, deltas, {
          kind: 'protocol_failure',
          code: 'turn_identity_mismatch',
        }, null)
      }
      const settledModelReroute = modelReroute as Extract<
        CodexNativeNotification,
        { method: 'model/rerouted' }
      >['params'] | null
      if (settledModelReroute) {
        const rejected = this.buildCandidate(
          {
            ...context,
            providerDiagnostics: {
              ...context.providerDiagnostics,
              modelReroute: { ...settledModelReroute },
              nativeTurnStatusAfterModelReroute: settledTurn.status,
            },
          },
          {
            ...settledTurn,
            status: 'failed',
            error: { message: 'codex_model_rerouted' },
          },
          items,
          deltas,
          { kind: 'protocol_failure', code: 'model_rerouted' },
          null,
        )
        rejected.runtimeDiagnostics.nativeTurnError = 'codex_model_rerouted'
        return rejected
      }
      const sourceItems = items.length > 0
        ? items
        : settledTurn.items.map((item, order) => ({ item, order }))
      const selection = this.selectCandidate(settledTurn, sourceItems, deltas, context.allowNullPhaseFallback)
      return this.buildCandidate(
        context,
        settledTurn,
        sourceItems,
        deltas,
        selection.result,
        selection.message,
      )
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      unsubscribe()
      if (this.recoveryWaiters.get(context.readyRunId) === recoveryWaiter) {
        this.recoveryWaiters.delete(context.readyRunId)
      }
    }
  }

  buildReadbackCandidate(context: CodexTurnReadbackContext, turn: CodexTurn): CoreTurnCandidate {
    if (turn.status === 'inProgress') throw new Error('codex_turn_readback_not_terminal')
    const items = turn.items.map((item, order) => ({ item, order }))
    const deltas = new Map<string, string[]>()
    const selection = this.selectCandidate(turn, items, deltas, context.allowNullPhaseFallback)
    return this.buildCandidate(context, turn, items, deltas,
      selection.result, selection.message)
  }

  private selectCandidate(
    turn: CodexTurn,
    items: Array<{ item: CodexThreadItem; order: number }>,
    deltas: Map<string, string[]>,
    allowNullPhaseFallback: boolean,
  ): {
    result: CoreTurnCandidate['candidateSelection']
    message: CodexAgentMessageItem | null
  } {
    if (turn.status !== 'completed') {
      return { result: { kind: 'none', code: 'terminal_not_completed' }, message: null }
    }

    let lastToolOrder = -1
    const messages: AgentMessageRecord[] = []
    for (const { item, order } of items) {
      if (item.type === 'dynamicToolCall') {
        lastToolOrder = order
        continue
      }
      if (item.type !== 'agentMessage') continue
      if (!['commentary', 'final_answer', null].includes(item.phase)) {
        return {
          result: { kind: 'protocol_failure', code: 'unknown_message_phase' },
          message: null,
        }
      }
      const itemDeltas = deltas.get(item.id) || []
      if (itemDeltas.length > 0 && itemDeltas.join('') !== item.text) {
        return {
          result: { kind: 'protocol_failure', code: 'delta_completed_mismatch' },
          message: null,
        }
      }
      messages.push({ item, order, deltas: itemDeltas })
    }

    const explicitFinals = messages.filter(({ item, order }) => (
      item.phase === 'final_answer' && order > lastToolOrder
    ))
    if (explicitFinals.length > 1) {
      return {
        result: { kind: 'protocol_failure', code: 'multiple_explicit_finals' },
        message: null,
      }
    }
    if (explicitFinals.length === 1) {
      const selected = explicitFinals[0]
      if (messages.some(({ item, order }) => item.phase === null && order > selected.order)) {
        return {
          result: { kind: 'protocol_failure', code: 'null_after_explicit_final' },
          message: null,
        }
      }
      return {
        result: { kind: 'accepted', itemId: selected.item.id },
        message: selected.item,
      }
    }

    if (allowNullPhaseFallback) {
      const fallback = messages
        .filter(({ item, order }) => item.phase === null && order > lastToolOrder)
        .at(-1)
      if (fallback) {
        return {
          result: { kind: 'accepted', itemId: fallback.item.id },
          message: fallback.item,
        }
      }
    }
    return {
      result: { kind: 'protocol_failure', code: 'no_legal_candidate' },
      message: null,
    }
  }

  private buildCandidate(
    context: CodexTurnReadbackContext,
    turn: CodexTurn,
    items: Array<{ item: CodexThreadItem; order: number }>,
    deltas: Map<string, string[]>,
    selection: CoreTurnCandidate['candidateSelection'],
    selectedMessage: CodexAgentMessageItem | null,
  ): CoreTurnCandidate {
    return {
      kind: 'native_terminal',
      readyTaskId: context.readyTaskId,
      readyRunId: context.readyRunId,
      scopeId: context.scopeId,
      codexThreadId: context.codexThreadId,
      codexTurnId: turn.id,
      engineOutcome: normalizeEngineOutcome(turn.status),
      candidateSelection: selection,
      candidateText: selectedMessage?.text ?? null,
      candidateDigest: selectedMessage ? digestText(selectedMessage.text) : null,
      usedToolCalls: items.flatMap(({ item }) => item.type === 'dynamicToolCall'
        ? [{
            itemId: item.id,
            tool: item.tool,
            status: item.status,
            success: item.success ?? null,
            responseDigest: item.contentItems && typeof item.success === 'boolean'
              ? digestCanonicalJson({ contentItems: item.contentItems, success: item.success })
              : null,
          }]
        : []),
      actionReceiptRefs: [...context.actionReceiptRefs],
      interactionState: context.interactionState,
      waitingFor: context.waitingFor,
      terminalReasonCandidate: resolveTerminalReasonCandidate(
        context.terminalReasonCandidate,
        turn.status,
      ),
      abortInitiator: context.abortInitiator,
      budgetState: { ...context.budgetState },
      contextState: { ...context.contextState },
      providerDiagnostics: { ...context.providerDiagnostics },
      recoveryCheckpointRef: context.recoveryCheckpointRef,
      browserContinuationRef: context.browserContinuationRef,
      browserProofRefs: [...context.browserProofRefs],
      otherProofRefs: [...context.otherProofRefs],
      projectionPatchRefs: [...context.projectionPatchRefs],
      runtimeDiagnostics: {
        finalDeltaItemIds: [...deltas.keys()],
        commentaryItemIds: items.flatMap(({ item }) => (
          item.type === 'agentMessage' && item.phase === 'commentary' ? [item.id] : []
        )),
        nativeTurnError: turn.error?.message ?? null,
      },
    }
  }
}
