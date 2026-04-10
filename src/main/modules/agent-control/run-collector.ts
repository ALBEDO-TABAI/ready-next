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
  executionDiagnostics?: {
    compression?: {
      historyCompressed: boolean
      toolTraceCompressed: boolean
      artifactSummaryUsed: boolean
    } | null
    budget?: {
      maxIterations: number
      maxToolCalls: number
      maxParallelToolGroups: number
      iterationsUsed?: number
      toolCallsUsed?: number
      parallelToolGroupsUsed?: number
    } | null
    fallback?: {
      happened: boolean
      kind: string
      attempts: number
    } | null
  } | null
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
        })
        return
      }
      if (payload.status === 'done') {
        finish({
          success: !runtimeError,
          finalText: finalChunks.join(''),
          cancelled,
          usedTools: Array.from(usedTools),
          error: runtimeError,
        })
      }
    },
  }
}
