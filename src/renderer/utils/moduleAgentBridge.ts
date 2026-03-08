export type ModuleAgentName = 'design' | 'video' | 'rss' | 'calendar'

export interface ModuleAgentActionRequest<TArgs = Record<string, unknown>> {
  module: ModuleAgentName
  action: string
  args: TArgs
}

export type ModuleAgentActionHandler = (
  request: ModuleAgentActionRequest,
) => Promise<unknown> | unknown

interface ReadyWindowWithModuleHandlers extends Window {
  __readyModuleAgentHandlers?: Partial<Record<ModuleAgentName, ModuleAgentActionHandler>>
}

function getReadyWindow(): ReadyWindowWithModuleHandlers | null {
  if (typeof window === 'undefined') return null
  return window as ReadyWindowWithModuleHandlers
}

export function registerModuleAgentHandler(
  module: ModuleAgentName,
  handler: ModuleAgentActionHandler,
): () => void {
  const readyWindow = getReadyWindow()
  if (!readyWindow) return () => { /* noop */ }

  readyWindow.__readyModuleAgentHandlers = {
    ...(readyWindow.__readyModuleAgentHandlers || {}),
    [module]: handler,
  }

  return () => {
    const current = readyWindow.__readyModuleAgentHandlers || {}
    if (current[module] !== handler) return
    const next = { ...current }
    delete next[module]
    readyWindow.__readyModuleAgentHandlers = next
  }
}

export async function requestModuleAgentAction<TResult = unknown>(
  request: ModuleAgentActionRequest,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<TResult> {
  const readyWindow = getReadyWindow()
  if (!readyWindow) {
    throw new Error('Window is not available for module agent action dispatch')
  }

  const timeoutMs = Math.max(0, options?.timeoutMs ?? 2500)
  const pollIntervalMs = Math.max(16, options?.pollIntervalMs ?? 32)
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    const handler = readyWindow.__readyModuleAgentHandlers?.[request.module]
    if (handler) {
      return await handler(request) as TResult
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(`Module agent handler is unavailable for ${request.module}.${request.action}`)
}
