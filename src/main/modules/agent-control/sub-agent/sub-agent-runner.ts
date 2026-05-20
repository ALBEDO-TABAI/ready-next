import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tool-error-metrics'
import type {
  SubAgent,
  SubAgentCloseEvent,
  SubAgentCloseState,
  SubAgentContext,
  SubAgentError,
  SubAgentEvent,
  SubAgentRunResult,
  SubAgentTerminalReason,
  SubAgentWorkEvent,
} from './sub-agent-types'

type NextResult =
  | { kind: 'next'; result: IteratorResult<SubAgentWorkEvent, SubAgentRunResult | void> }
  | { kind: 'aborted' }

export async function* runSubAgent(
  subagent: SubAgent,
  context: SubAgentContext,
): AsyncGenerator<SubAgentEvent, SubAgentCloseEvent, void> {
  yield {
    type: 'started',
    lifecycleId: subagent.lifecycleId,
    durableRunId: subagent.durableRunId,
    subagentName: subagent.subagentName,
    artifactDir: subagent.artifactDir,
    startedAt: new Date().toISOString(),
  }

  let iterator: AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult | void, void> | null = null

  if (context.abortSignal.aborted) {
    const closeEvent = await finalizeSubAgent(subagent, context, {
      state: 'cancelled',
      terminalReason: 'aborted',
    })
    yield makeTerminalEvent(subagent, closeEvent)
    return closeEvent
  }

  try {
    iterator = subagent.run(context)
    while (true) {
      const next = await raceNextWithAbort(iterator.next(), context.abortSignal)
      if (next.kind === 'aborted') {
        // fire-and-forget: iterator.return() is best-effort cleanup on abort; finalizeSubAgent below owns the canonical cancellation close event.
        void iterator.return(undefined).catch(() => undefined)
        const closeEvent = await finalizeSubAgent(subagent, context, {
          state: 'cancelled',
          terminalReason: 'aborted',
        })
        yield makeTerminalEvent(subagent, closeEvent)
        return closeEvent
      }

      if (next.result.done) {
        const closeEvent = await finalizeSubAgent(subagent, context, normalizeRunResult(next.result.value))
        yield makeTerminalEvent(subagent, closeEvent)
        return closeEvent
      }

      if (context.abortSignal.aborted) {
        // fire-and-forget: iterator.return() is best-effort cleanup on abort; finalizeSubAgent below owns the canonical cancellation close event.
        void iterator.return(undefined).catch(() => undefined)
        const closeEvent = await finalizeSubAgent(subagent, context, {
          state: 'cancelled',
          terminalReason: 'aborted',
        })
        yield makeTerminalEvent(subagent, closeEvent)
        return closeEvent
      }

      yield frameWorkEvent(subagent, next.result.value)
    }
  } catch (error) {
    if (context.abortSignal.aborted) {
      // fire-and-forget: best-effort iterator cleanup during abort recovery; the surrounding catch builds the canonical cancellation close event.
      void iterator?.return(undefined).catch(() => undefined)
      const closeEvent = await finalizeSubAgent(subagent, context, {
        state: 'cancelled',
        terminalReason: 'aborted',
      })
      yield makeTerminalEvent(subagent, closeEvent)
      return closeEvent
    }

    const closeEvent = await finalizeSubAgent(subagent, context, {
      state: 'failed',
      terminalReason: 'failed_subagent',
      error: normalizeError(error),
    })
    yield makeTerminalEvent(subagent, closeEvent)
    return closeEvent
  }
}

function raceNextWithAbort(
  nextPromise: Promise<IteratorResult<SubAgentWorkEvent, SubAgentRunResult | void>>,
  signal: AbortSignal,
): Promise<NextResult> {
  if (signal.aborted) return Promise.resolve({ kind: 'aborted' })
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      resolve({ kind: 'aborted' })
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    nextPromise.then(
      (result) => {
        cleanup()
        resolve({ kind: 'next', result })
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function normalizeRunResult(result: SubAgentRunResult | void): SubAgentRunResult {
  return result ?? {
    state: 'completed',
    terminalReason: 'completed',
  }
}

async function finalizeSubAgent(
  subagent: SubAgent,
  context: SubAgentContext,
  result: SubAgentRunResult,
): Promise<SubAgentCloseEvent> {
  try {
    await context.cleanup.drain()
  } catch (error) {
    logAgentMetric(TOOL_ERROR_METRICS.subagentCleanupDrainFailed, {
      lifecycleId: subagent.lifecycleId,
      subagentName: subagent.subagentName,
      errorMessage: normalizeError(error).message,
    })
  }

  const state = result.state ?? 'completed'
  return {
    lifecycleId: subagent.lifecycleId,
    durableRunId: subagent.durableRunId,
    subagentName: subagent.subagentName,
    state,
    terminalReason: result.terminalReason ?? defaultTerminalReason(state),
    terminalAt: new Date().toISOString(),
    artifactDir: subagent.artifactDir,
    outputDir: result.outputDir ?? null,
    runStatePath: result.runStatePath ?? null,
    sceneScoresPath: result.sceneScoresPath ?? null,
    deliveryReportPath: result.deliveryReportPath ?? null,
    progress: result.progress ?? null,
    framePatch: result.framePatch,
    projectionPatch: result.projectionPatch,
    error: result.error ?? null,
    parentScopeId: context.parentScopeId ?? null,
    parentSessionId: context.parentSessionId ?? null,
    metadata: result.metadata,
  }
}

function defaultTerminalReason(state: SubAgentCloseState): SubAgentTerminalReason {
  if (state === 'completed') return 'completed'
  if (state === 'cancelled') return 'aborted'
  if (state === 'blocked') return 'blocked_external'
  return 'failed_subagent'
}

function makeTerminalEvent(
  subagent: SubAgent,
  closeEvent: SubAgentCloseEvent,
): Extract<SubAgentEvent, { type: 'terminal' }> {
  return {
    type: 'terminal',
    lifecycleId: subagent.lifecycleId,
    durableRunId: subagent.durableRunId,
    subagentName: subagent.subagentName,
    state: closeEvent.state,
    terminalReason: closeEvent.terminalReason,
    closeEvent,
  }
}

function frameWorkEvent(subagent: SubAgent, event: SubAgentWorkEvent): SubAgentEvent {
  return {
    ...event,
    lifecycleId: subagent.lifecycleId,
    durableRunId: subagent.durableRunId,
    subagentName: subagent.subagentName,
  }
}

function normalizeError(error: unknown): SubAgentError {
  if (error instanceof Error) {
    return {
      kind: error.name || 'Error',
      message: error.message,
      cause: error.cause,
    }
  }
  return {
    kind: 'unknown',
    message: String(error),
  }
}
