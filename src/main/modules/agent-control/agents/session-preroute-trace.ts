import {
  classifyFollowupIntent,
} from '../../../../shared/agent-followup-intent'
import type {
  AgentSystemStudioPrerouteTrace,
  AgentSystemStudioPrerouteTraceReason,
  AgentSystemStudioRoutingCard,
} from '../../../../shared/agent-system-studio'
import type {
  PrerouteOwnedTaskRef,
  PrerouteResult,
  SessionPrerouteMode,
} from './session-preroute'
import { isOpenTaskStatus } from '../contracts/task-open-status'

function isOpenTask(ref: PrerouteOwnedTaskRef): boolean {
  return isOpenTaskStatus(ref.status) || ref.interactionState === 'check_in_pending'
}

function addReason(out: AgentSystemStudioPrerouteTraceReason[], reason: AgentSystemStudioPrerouteTraceReason): void {
  if (!out.includes(reason)) out.push(reason)
}

function preview(text: string): string {
  return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 160)
}

export function buildSessionPrerouteTrace(input: {
  id: string
  now: Date
  firstMessage: string
  mode: SessionPrerouteMode
  result: PrerouteResult
  recentOwnedTasks: ReadonlyArray<PrerouteOwnedTaskRef>
  routingInventory: ReadonlyArray<AgentSystemStudioRoutingCard>
  isAgentActive: (agentId: string) => boolean
}): AgentSystemStudioPrerouteTrace {
  const reasons: AgentSystemStudioPrerouteTraceReason[] = []
  if (input.mode === 'off') addReason(reasons, 'routing_off')
  if (input.mode === 'suggest' && input.result.effect === 'suggest') addReason(reasons, 'suggest_only')
  if (input.result.decision.tier === 'fallback') {
    if (input.result.decision.reason === 'precedent_conflict') addReason(reasons, 'precedent_conflict')
    if (input.result.decision.reason === 'no_match') addReason(reasons, 'no_keyword_match')
  }

  for (const card of input.routingInventory) {
    if (card.disabledReason === 'card_staged') addReason(reasons, 'card_staged')
    if (card.disabledReason === 'missing_triggers') addReason(reasons, 'missing_triggers')
    if (card.disabledReason === 'target_inactive') addReason(reasons, 'target_inactive')
  }

  const intent = classifyFollowupIntent(input.firstMessage, {
    hasActiveTaskContext: input.recentOwnedTasks.length > 0,
    taskRefs: input.recentOwnedTasks,
  })
  if (intent.kind === 'continue_task' || intent.kind === 'status_query') {
    const pinned = intent.targetTaskId
      ? input.recentOwnedTasks.find((ref) => ref.taskId === intent.targetTaskId)
      : undefined
    const target = pinned ?? input.recentOwnedTasks.find(isOpenTask)
    if (target?.ownerAgentId && !input.isAgentActive(String(target.ownerAgentId))) {
      addReason(reasons, 'state_owner_inactive')
    }
  }

  return {
    id: input.id,
    createdAt: input.now.toISOString(),
    firstMessagePreview: preview(input.firstMessage),
    mode: input.mode,
    effect: input.result.effect,
    decisionTier: input.result.decision.tier,
    targetAgentId: input.result.decision.targetAgentId,
    reasons,
  }
}

export function pushSessionPrerouteTraceSafely(input: {
  sink: { push(trace: AgentSystemStudioPrerouteTrace): void }
  id: string
  now: Date
  firstMessage: string
  mode: SessionPrerouteMode
  result: PrerouteResult
  recentOwnedTasks: ReadonlyArray<PrerouteOwnedTaskRef>
  getRoutingInventory: () => ReadonlyArray<AgentSystemStudioRoutingCard>
  isAgentActive: (agentId: string) => boolean
  warn?: (message: string) => void
}): void {
  try {
    input.sink.push(buildSessionPrerouteTrace({
      id: input.id,
      now: input.now,
      firstMessage: input.firstMessage,
      mode: input.mode,
      result: input.result,
      recentOwnedTasks: input.recentOwnedTasks,
      routingInventory: input.getRoutingInventory(),
      isAgentActive: input.isAgentActive,
    }))
  } catch (error) {
    const message = `[session-preroute-trace] failed: ${error instanceof Error ? error.message : String(error)}`
    if (input.warn) input.warn(message)
    else console.warn(message)
  }
}

export class SessionPrerouteTraceRingBuffer {
  private readonly traces: AgentSystemStudioPrerouteTrace[] = []

  constructor(private readonly limit = 50) {}

  push(trace: AgentSystemStudioPrerouteTrace): void {
    this.traces.push(trace)
    while (this.traces.length > this.limit) this.traces.shift()
  }

  listRecent(limit = 10): AgentSystemStudioPrerouteTrace[] {
    const normalizedLimit = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(this.limit, Math.trunc(Number(limit))))
      : 10
    return [...this.traces].reverse().slice(0, normalizedLimit)
  }
}
