import type { DeliveryMode } from '../../../../../shared/dynamic-delivery'
import { logAgentMetric } from '../../metrics'
import { createInitiatorAbort } from '../agent-sdk-run-lifecycle'
import type { RunHandle } from '../agent-sdk-types'

export const DYNAMIC_DELIVERY_HARD_WALL_CLOCK_MS = 300_000

export interface DynamicDeliveryDeadlineHandle {
  noteProgress(reason: 'text_delta' | 'tool_result'): void
  dispose(): void
}

export function resolveDynamicDeliveryWallClockMs(mode: DeliveryMode): number | null {
  if (mode === 'standard') return null
  return Math.min(mode === 'thorough' ? 240_000 : 120_000, DYNAMIC_DELIVERY_HARD_WALL_CLOCK_MS)
}

export function armDynamicDeliveryDeadline(input: {
  mode: DeliveryMode
  runId: string
  abortController: AbortController
  runHandle: RunHandle
  startedAtMs?: number
  timeoutMsForTest?: number
  isAwaitingUserInput?: () => boolean
}): DynamicDeliveryDeadlineHandle {
  const configuredMs = resolveDynamicDeliveryWallClockMs(input.mode)
  if (configuredMs === null) {
    return { noteProgress: () => undefined, dispose: () => undefined }
  }
  const elapsedAtArmMs = input.startedAtMs === undefined
    ? 0
    : Math.max(0, Date.now() - input.startedAtMs)
  const progressWindowMs = input.timeoutMsForTest ?? configuredMs
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let progressRevision = 0

  const arm = (timeoutMs: number): void => {
    if (timer) clearTimeout(timer)
    const armedRevision = progressRevision
    timer = setTimeout(() => {
      if (disposed || input.abortController.signal.aborted || armedRevision !== progressRevision) return
      if (input.isAwaitingUserInput?.()) {
        logAgentMetric('dynamic_delivery_deadline_suspended_for_user_input', {
          runId: input.runId,
          mode: input.mode,
        })
        arm(Math.min(progressWindowMs, 1_000))
        return
      }
      const error = createInitiatorAbort(
        input.runHandle,
        'timeout',
        'delivery_wall_clock_exceeded',
      )
      logAgentMetric('delivery_wall_clock_exceeded', {
        runId: input.runId,
        mode: input.mode,
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
  return {
    noteProgress(reason) {
      if (disposed || input.abortController.signal.aborted) return
      progressRevision += 1
      logAgentMetric('dynamic_delivery_progress_window_refreshed', {
        runId: input.runId,
        mode: input.mode,
        reason,
        progressRevision,
        nextTimeoutMs: progressWindowMs,
      })
      arm(progressWindowMs)
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
