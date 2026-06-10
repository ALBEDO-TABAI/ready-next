export type ExecutionErrorKind =
  | 'rate_limit'
  | 'context_overflow'
  | 'timeout_model'
  | 'timeout_tool'
  | 'auth'
  | 'transient'
  | 'host_unavailable'
  | 'unknown'

export interface ErrorClassifierResult {
  kind: ExecutionErrorKind
  source: 'model_request' | 'tool_execution' | 'runtime'
  retryable: boolean
  suggestedDelayMs?: number
  shouldCompressContext: boolean
  shouldEscalateToFallback: boolean
  message: string
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isToolExecutionSource(source?: ErrorClassifierResult['source']): boolean {
  return source === 'tool_execution'
}

export function classifyExecutionError(
  error: unknown,
  options?: { source?: ErrorClassifierResult['source'] },
): ErrorClassifierResult {
  const message = stringifyError(error)
  const normalized = message.toLowerCase()
  const source = options?.source || 'model_request'

  if (/http 429|rate limit|too many requests/.test(normalized)) {
    return {
      kind: 'rate_limit',
      source,
      retryable: true,
      suggestedDelayMs: 350,
      shouldCompressContext: false,
      shouldEscalateToFallback: false,
      message,
    }
  }

  if (/context length|context window|maximum context|prompt is too long|too many tokens/.test(normalized)) {
    return {
      kind: 'context_overflow',
      source,
      retryable: true,
      shouldCompressContext: true,
      shouldEscalateToFallback: false,
      message,
    }
  }

  if (/http 401|http 403|invalid api key|unauthorized|forbidden|auth/.test(normalized)) {
    return {
      kind: 'auth',
      source,
      retryable: false,
      shouldCompressContext: false,
      shouldEscalateToFallback: false,
      message,
    }
  }

  if (/browser controller is not available|sidecar is not running|tool not allowed in current context|channel is not connected/.test(normalized)) {
    return {
      kind: 'host_unavailable',
      source: 'runtime',
      retryable: false,
      shouldCompressContext: false,
      shouldEscalateToFallback: false,
      message,
    }
  }

  if (/timed out|timeout|请求超时/.test(normalized)) {
    return {
      kind: isToolExecutionSource(options?.source) ? 'timeout_tool' : 'timeout_model',
      source,
      retryable: true,
      suggestedDelayMs: 500,
      shouldCompressContext: false,
      shouldEscalateToFallback: false,
      message,
    }
  }

  if (/http 408|http 409|http 500|http 502|http 503|http 504|econnreset|socket hang up|network error|premature close|err_stream_premature_close|incomplete chunked encoding|fetch failed|und_err_socket|\bterminated\b/.test(normalized)) {
    return {
      kind: 'transient',
      source,
      retryable: true,
      suggestedDelayMs: 500,
      shouldCompressContext: false,
      shouldEscalateToFallback: false,
      message,
    }
  }

  return {
    kind: 'unknown',
    source,
    retryable: false,
    shouldCompressContext: false,
    shouldEscalateToFallback: true,
    message,
  }
}
