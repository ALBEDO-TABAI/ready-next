export interface ScopedRunMatch {
  agent: string
  sessionId?: string
  requestId?: string
}

export interface OutputEventLike {
  agent: string
  sessionId?: string
  runId?: string
  chunk: string
  type: string
}

export interface StatusEventLike {
  agent: string
  sessionId?: string
  runId?: string
  status: string
  terminalReason?: import('../turn-frame').TurnTerminalReason | null
}

export interface ErrorEventLike {
  agent: string
  sessionId?: string
  runId?: string
  error: string
}

export interface SendAndCollectResult {
  success: boolean
  finalText: string
  cancelled: boolean
  usedTools: string[]
  error?: string
  taskId?: string | null
  taskType?: import('../run-contracts').TaskType
  interactionState?: import('../run-contracts').TaskInteractionState
  taskProjectionId?: string | null
  executionDiagnostics?: import('../run-contracts').ExecutionRunDiagnostics | null
  projectionTruth?: import('../run-contracts').ProjectionTruthSnapshot | null
  terminalReason?: import('../turn-frame').TurnTerminalReason | null
}

function matchesScope(match: ScopedRunMatch, payload: { agent: string; sessionId?: string; runId?: string }): boolean {
  if (payload.agent !== match.agent) return false
  if ((payload.sessionId || undefined) !== (match.sessionId || undefined)) return false
  if (match.requestId && payload.runId !== match.requestId) return false
  return true
}

export function createScopedRunCollector(match: ScopedRunMatch) {
  const finalChunks: string[] = []
  const usedTools = new Set<string>()
  let cancelled = false
  let runtimeError: string | undefined
  let resolveResult: ((result: SendAndCollectResult) => void) | null = null

  const result = new Promise<SendAndCollectResult>((resolve) => {
    resolveResult = resolve
  })

  const finish = (payload: SendAndCollectResult) => {
    if (!resolveResult) return
    const resolve = resolveResult
    resolveResult = null
    resolve(payload)
  }

  return {
    result,
    handleOutput(payload: OutputEventLike) {
      if (!matchesScope(match, payload)) return
      if (payload.type === 'text' && payload.chunk) {
        finalChunks.push(payload.chunk)
        return
      }
      if (payload.type === 'tool_use' && payload.chunk) {
        const toolName = payload.chunk.split('(')[0]?.trim()
        if (toolName) usedTools.add(toolName)
      }
    },
    handleError(payload: ErrorEventLike) {
      if (!matchesScope(match, payload)) return
      runtimeError = payload.error
    },
    handleStatus(payload: StatusEventLike) {
      if (!matchesScope(match, payload)) return
      if (payload.status === 'cancelled') {
        cancelled = true
        finish({
          success: true,
          finalText: finalChunks.join(''),
          cancelled: true,
          usedTools: Array.from(usedTools),
          terminalReason: payload.terminalReason ?? null,
        })
        return
      }
      if (payload.status === 'error') {
        finish({
          success: false,
          finalText: finalChunks.join(''),
          cancelled: false,
          usedTools: Array.from(usedTools),
          error: runtimeError || 'Agent execution failed',
          terminalReason: payload.terminalReason ?? null,
        })
        return
      }
      if (payload.status === 'done' || payload.status === 'checkpoint') {
        finish({
          success: !runtimeError,
          finalText: finalChunks.join(''),
          cancelled,
          usedTools: Array.from(usedTools),
          error: runtimeError,
          terminalReason: payload.terminalReason ?? null,
        })
      }
    },
  }
}
