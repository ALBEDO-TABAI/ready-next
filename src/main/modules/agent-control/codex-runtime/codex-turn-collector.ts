import { createHash } from 'node:crypto'

import type {
  CodexAgentMessageItem,
  CodexNativeNotification,
  CodexNativeRuntime,
  CodexThreadItem,
  CodexTurn,
} from './codex-native-runtime'

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
          | 'native_host_failure'
      }
  candidateText: string | null
  candidateDigest: string | null
  usedToolCalls: Array<{ itemId: string; tool: string; status: string }>
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
  onAutomaticCompactionObserved: (event: {
    threadId: string
    turnId: string
    itemId: string
  }) => void
  onProvisionalDelta: (event: {
    threadId: string
    turnId: string
    itemId: string
    delta: string
    reversible: true
  }) => void
}

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
  constructor(private readonly nativeRuntime: CodexNativeRuntime) {}

  async collect(context: CodexTurnCollectionContext): Promise<CoreTurnCandidate> {
    const pending: CodexNativeNotification[] = []
    const items: Array<{ item: CodexThreadItem; order: number }> = []
    const itemStarts = new Map<string, CodexThreadItem>()
    const deltas = new Map<string, string[]>()
    let expectedTurnId: string | null = null
    let terminal: CodexTurn | null = null
    let nativeErrorWithoutTerminal: { turnId: string; message: string } | null = null
    let resolveTerminal: (() => void) | null = null
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve })

    const processNotification = (notification: CodexNativeNotification): void => {
      if (notification.method === 'thread/started') return
      if (notification.method === 'error') {
        if (notification.params.threadId !== context.codexThreadId) return
        if (!expectedTurnId) {
          pending.push(notification)
          return
        }
        if (notification.params.turnId !== expectedTurnId) return
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

      if (notification.method === 'item/started') {
        itemStarts.set(notification.params.item.id, notification.params.item)
        return
      }
      if (notification.method === 'item/agentMessage/delta') {
        const itemDeltas = deltas.get(notification.params.itemId) || []
        itemDeltas.push(notification.params.delta)
        deltas.set(notification.params.itemId, itemDeltas)
        const started = itemStarts.get(notification.params.itemId)
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
        if (notification.params.item.type === 'contextCompaction') {
          context.onAutomaticCompactionObserved({
            threadId: notification.params.threadId,
            turnId: notification.params.turnId,
            itemId: notification.params.item.id,
          })
          return
        }
        items.push({ item: notification.params.item, order: items.length })
        return
      }
      if (notification.method === 'turn/completed') {
        terminal = notification.params.turn
        resolveTerminal?.()
      }
    }

    const unsubscribe = this.nativeRuntime.subscribe(processNotification)
    try {
      let started: { turn: CodexTurn }
      try {
        started = await context.startTurn()
      } catch (error) {
        return createHostFailureCandidate(context, {
          stage: 'turn_start',
          code: 'turn_start_failed',
          error,
          codexTurnId: null,
        })
      }
      expectedTurnId = started.turn.id
      for (const notification of pending.splice(0)) processNotification(notification)

      if (!terminal) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve('timeout'),
            context.terminalTimeoutMs,
          )
        })
        const settledBy = await Promise.race([
          terminalPromise.then(() => 'notification' as const),
          timeoutPromise,
        ])
        if (timeoutHandle) clearTimeout(timeoutHandle)
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
      unsubscribe()
    }
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

    const explicitFinals = messages.filter(({ item }) => item.phase === 'final_answer')
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
    context: CodexTurnCollectionContext,
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
        ? [{ itemId: item.id, tool: item.tool, status: item.status }]
        : []),
      actionReceiptRefs: [...context.actionReceiptRefs],
      interactionState: context.interactionState,
      waitingFor: context.waitingFor,
      terminalReasonCandidate: context.terminalReasonCandidate,
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
