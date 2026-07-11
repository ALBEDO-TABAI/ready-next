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
  terminalReason?: import('../runtime-core/turn-frame').TurnTerminalReason | null
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
  taskType?: import('../contracts/run-contracts').TaskType
  interactionState?: import('../contracts/run-contracts').TaskInteractionState
  taskProjectionId?: string | null
  executionDiagnostics?: import('../contracts/run-contracts').ExecutionRunDiagnostics | null
  projectionTruth?: import('../contracts/run-contracts').ProjectionTruthSnapshot | null
  terminalReason?: import('../runtime-core/turn-frame').TurnTerminalReason | null
}

/**
 * 2026-07-03 真机回归 R1 — error 终态的用户可读原因（E2：终态四选一里
 * blocked/degraded 必须带原因与下一步）。只登记已证实会以 error status 收口
 * 且此前呈现为泛化"Agent execution failed"的 reason；未知 reason 回 null
 * 走兜底文案。
 */
export function userFacingTerminalErrorText(terminalReason: string | null): string | null {
  switch (terminalReason) {
    case 'browser_transaction_unconfirmed':
      return '网页操作还没有拿到成功确认：任务停在当前页面，可以继续操作，或让我重试并确认结果。'
    case 'proof_gap':
      return '本次运行缺少完成证据，已按未完成收口；可以让我重试，或补充完成判定所需的材料。'
    case 'no_artifact':
      return '本次运行没有产出可验证的成果文件，已按未完成收口；可以让我重试。'
    case 'blocked_tool_error':
      return '有关键工具在本轮被拦截或不可用，目标没有完成，已按未完成收口；上面保留了已完成的进展说明，可以让我重试。'
    default:
      return null
  }
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
          // 2026-07-03 真机回归 R1：error 终态必须携带 terminalReason 对应的
          // 用户可读原因（E2：失败有出路），泛化文案只作最终兜底。
          error: runtimeError
            || userFacingTerminalErrorText(payload.terminalReason ?? null)
            || 'Agent execution failed',
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
