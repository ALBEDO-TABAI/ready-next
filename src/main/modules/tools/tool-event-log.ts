import { createRotatingLogger } from '../../utils/rotating-logger'

const logger = createRotatingLogger('ready-tools.log', { buffered: true })

export interface ToolEventLogPayload {
  type: 'dispatch' | 'ack' | 'watchdog' | 'cancel' | 'self-rescue' | 'duplicate'
  requestId: string
  tool: string
  scopeId?: string | null
  elapsedMs?: number
  error?: string
}

export function appendToolEventLog(payload: ToolEventLogPayload): void {
  if (!payload || !payload.type || !payload.requestId) return
  const parts: string[] = [
    `runtimeDriver type=${payload.type}`,
    `requestId=${payload.requestId}`,
    `tool=${payload.tool || 'unknown'}`,
  ]
  if (payload.scopeId) parts.push(`scopeId=${payload.scopeId}`)
  if (typeof payload.elapsedMs === 'number' && Number.isFinite(payload.elapsedMs)) {
    parts.push(`elapsedMs=${Math.round(payload.elapsedMs)}`)
  }
  if (payload.error) parts.push(`error=${String(payload.error).slice(0, 120)}`)
  try {
    logger.append(`[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch {
    /* best-effort */
  }
}

export function appendToolCapabilityLog(message: string): void {
  const line = String(message || '').trim()
  if (!line) return
  try {
    logger.append(`[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* best-effort */
  }
}
