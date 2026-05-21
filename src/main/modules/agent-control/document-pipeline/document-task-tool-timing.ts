export const DOCUMENT_TOOL_TIMEOUT_MS: Record<string, number> = {
  'document.insertWidget': 30_000,
  'document.updateWidget': 30_000,
  'document.removeWidget': 30_000,
  'document.saveTab': 45_000,
  'document.listWidgets': 15_000,
  'document.inspectActive': 15_000,
  'document.openTab': 15_000,
}

export const DEFAULT_DOCUMENT_TOOL_TIMEOUT_MS = 30_000

export function getDocumentToolTimeout(tool: string): number {
  return DOCUMENT_TOOL_TIMEOUT_MS[tool] ?? DEFAULT_DOCUMENT_TOOL_TIMEOUT_MS
}

export function throwIfAborted(signal: AbortSignal | null | undefined, toolHint?: string): void {
  if (signal?.aborted) {
    const reason = toolHint ? `${toolHint} aborted` : 'Aborted'
    throw new DOMException(reason, 'AbortError')
  }
}

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
  toolHint?: string,
): Promise<T> {
  throwIfAborted(signal, toolHint)
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let abortHandler: (() => void) | null = null
  const guard = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const label = toolHint ? `${toolHint} timed out after ${timeoutMs}ms` : `Timed out after ${timeoutMs}ms`
      reject(new Error(label))
    }, timeoutMs)
    if (signal) {
      abortHandler = () => {
        const label = toolHint ? `${toolHint} aborted` : 'Aborted'
        reject(new DOMException(label, 'AbortError'))
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

export function wrapToolCall<T extends Record<string, unknown>>(
  requestModuleToolAction: (tool: string, args: Record<string, unknown>) => Promise<T>,
  signal: AbortSignal | null | undefined,
): (tool: string, args: Record<string, unknown>) => Promise<T> {
  return (tool, args) => raceWithTimeout(
    requestModuleToolAction(tool, args),
    signal,
    getDocumentToolTimeout(tool),
    tool,
  )
}
