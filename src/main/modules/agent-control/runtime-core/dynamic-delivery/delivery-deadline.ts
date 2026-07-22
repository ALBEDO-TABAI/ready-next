import type { DeliveryMode } from '../../../../../shared/dynamic-delivery'
import { logAgentMetric } from '../../metrics'
import { createInitiatorAbort } from '../agent-sdk-run-lifecycle'
import type { RunHandle } from '../agent-sdk-types'
import { getInteractionLifecycleRegistry } from '../interaction-lifecycle-registry'

export const DYNAMIC_DELIVERY_HARD_WALL_CLOCK_MS = 300_000

export interface DynamicDeliveryDeadlineHandle {
  noteProgress(reason: 'text_delta' | 'tool_result' | 'user_input_resolved'): void
  suspend(interactionId: string): void
  resume(interactionId: string): void
  dispose(): void
}

export type DynamicDeliveryDeadlineProfile = 'default' | 'tag_forge_folder_batch'

export function resolveDynamicDeliveryWallClockMs(
  mode: DeliveryMode,
  profile: DynamicDeliveryDeadlineProfile = 'default',
): number | null {
  if (mode === 'standard') return null
  const configuredMs = mode === 'thorough' || profile === 'tag_forge_folder_batch' ? 240_000 : 120_000
  return Math.min(configuredMs, DYNAMIC_DELIVERY_HARD_WALL_CLOCK_MS)
}

export function armDynamicDeliveryDeadline(input: {
  mode: DeliveryMode
  profile?: DynamicDeliveryDeadlineProfile
  runId: string
  abortController: AbortController
  runHandle: RunHandle
  startedAtMs?: number
  timeoutMsForTest?: number
  isAwaitingUserInput?: () => boolean
  agentId?: string
  scopeId?: string | null
}): DynamicDeliveryDeadlineHandle {
  const configuredMs = resolveDynamicDeliveryWallClockMs(input.mode, input.profile)
  if (configuredMs === null) {
    return { noteProgress: () => undefined, suspend: () => undefined, resume: () => undefined, dispose: () => undefined }
  }
  const elapsedAtArmMs = input.startedAtMs === undefined
    ? 0
    : Math.max(0, Date.now() - input.startedAtMs)
  const progressWindowMs = input.timeoutMsForTest ?? configuredMs
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let progressRevision = 0
  const suspendedInteractions = new Set<string>()

  const arm = (timeoutMs: number): void => {
    if (timer) clearTimeout(timer)
    const armedRevision = progressRevision
    timer = setTimeout(() => {
      if (disposed || input.abortController.signal.aborted || armedRevision !== progressRevision) return
      if (suspendedInteractions.size > 0) return
      const error = createInitiatorAbort(
        input.runHandle,
        'timeout',
        'delivery_wall_clock_exceeded',
      )
      logAgentMetric('delivery_wall_clock_exceeded', {
        runId: input.runId,
        mode: input.mode,
        profile: input.profile || 'default',
        timeoutMs,
        wallClockMs: configuredMs,
        noProgressWindowMs: progressWindowMs,
        elapsedAtArmMs,
        semantics: 'no_progress',
      })
      input.abortController.abort(error)
    }, timeoutMs)
    const unref = (timer as { unref?: unknown }).unref
    if (typeof unref === 'function') unref.call(timer)
  }

  arm(input.timeoutMsForTest ?? Math.max(0, configuredMs - elapsedAtArmMs))
  const registry = getInteractionLifecycleRegistry()
  let handle: DynamicDeliveryDeadlineHandle
  const offLifecycle = input.agentId && input.scopeId
    ? registry.subscribe((event) => {
        if (event.runId !== input.runId || event.agentId !== input.agentId || event.scopeId !== input.scopeId) return
        if (event.phase === 'suspended') handle.suspend(event.interactionId)
        else if (event.phase === 'resumed') handle.resume(event.interactionId)
        else if (event.phase === 'checkpointed' || event.phase === 'terminated') handle.suspend(event.interactionId)
      })
    : () => undefined
  handle = {
    noteProgress(reason) {
      if (disposed || input.abortController.signal.aborted) return
      progressRevision += 1
      logAgentMetric('dynamic_delivery_progress_window_refreshed', {
        runId: input.runId,
        mode: input.mode,
        profile: input.profile || 'default',
        reason,
        progressRevision,
        nextTimeoutMs: progressWindowMs,
      })
      arm(progressWindowMs)
    },
    suspend(interactionId) {
      if (disposed || !interactionId) return
      suspendedInteractions.add(interactionId)
      progressRevision += 1
      if (timer) clearTimeout(timer)
      timer = null
      logAgentMetric('dynamic_delivery_deadline_suspended_for_user_input', {
        runId: input.runId,
        interactionId,
        pendingCount: suspendedInteractions.size,
      })
    },
    resume(interactionId) {
      if (disposed || !suspendedInteractions.delete(interactionId)) return
      if (suspendedInteractions.size > 0) return
      this.noteProgress('user_input_resolved')
    },
    dispose() {
      disposed = true
      offLifecycle()
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
  return handle
}
