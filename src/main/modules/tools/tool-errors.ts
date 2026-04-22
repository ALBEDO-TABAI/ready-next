/**
 * Tool error contract (Phase 1).
 *
 * The dispatch layer (tool-executor.ts) converts every unrecognized throw from
 * a tool handler into a structured ToolExecutionOutput with errorKind, so the
 * model can react instead of the turn being killed. Handlers may still throw;
 * the dispatch layer just has to recognize which errors are terminal (i.e.
 * must bubble past the turn) vs which should be surfaced as a tool_result.
 *
 * Terminal class is kept deliberately narrow:
 *   - AbortError: user-initiated interruption; the orchestrator needs to stop.
 *   - ToolHostUnavailableError: the host capability the tool needs is offline
 *     (e.g. BrowserController missing). Retrying in the same turn won't help.
 *
 * Everything else (including a bare `new Error('something broke')`) becomes
 * a structured recoverable result with errorKind='tool_handler_failure'.
 */

export interface ToolDomainErrorDetail {
  [key: string]: unknown
}

/**
 * Preferred throw from a domain tool handler when the error should be fed
 * back to the model as a structured, hint-rich tool result.
 *
 * Example:
 *   throw new ToolDomainError('widget_not_found', `Widget ${id} does not exist`, { widgetId: id })
 */
export class ToolDomainError extends Error {
  readonly errorKind: string
  readonly detail: ToolDomainErrorDetail | null

  constructor(errorKind: string, message: string, detail?: ToolDomainErrorDetail) {
    super(message)
    this.name = 'ToolDomainError'
    this.errorKind = errorKind
    this.detail = detail ?? null
  }
}

/**
 * Thrown when a tool needs a host capability that is not currently attached
 * (e.g. BrowserController not wired). Terminal because retrying without the
 * capability is pointless.
 */
export class ToolHostUnavailableError extends Error {
  readonly toolName: string

  constructor(toolName: string, message: string) {
    super(message)
    this.name = 'ToolHostUnavailableError'
    this.toolName = toolName
  }
}

/**
 * Thrown when the current attempt was cancelled (user interrupt / signal).
 * Terminal because the turn itself is over.
 *
 * We keep the legacy shape `new Error('...'); error.name = 'AbortError'` working
 * by matching on `error.name` in isTerminalInfrastructureError. That lets
 * existing callers (tool-executor.ts:72-76) continue to use the cheap throw.
 */
export class ToolAbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * Return true iff the error must bubble past the dispatch layer and end the
 * turn. Everything else is surfaced to the model as a recoverable tool_result.
 *
 * Kept deliberately narrow and instanceof/name-based so it is cheap and
 * minify-safe (error.name is set in the constructor and survives bundling).
 */
export function isTerminalInfrastructureError(error: unknown): boolean {
  if (error instanceof ToolHostUnavailableError) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return false
}

export function errorKindFor(error: unknown): string {
  if (error instanceof ToolDomainError) return error.errorKind
  if (error instanceof ToolHostUnavailableError) return 'host_unavailable'
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'tool_handler_failure'
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
