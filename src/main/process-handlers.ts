import { logAgentMetric } from './modules/agent-control/metrics'
import { createRotatingLogger } from './utils/rotating-logger'
import { PROCESS_METRICS, type ProcessMetricName } from './utils/process-metrics'

type FatalProcessEvent = 'unhandledRejection' | 'uncaughtException'
type RuntimeGoneEvent = 'render-process-gone' | 'child-process-gone'

export interface MainProcessEventRecord {
  at: string
  kind: FatalProcessEvent | RuntimeGoneEvent
  error?: {
    name?: string
    message: string
    stack?: string
  }
  details?: Record<string, unknown>
}

interface AppLike {
  on(event: RuntimeGoneEvent, listener: (...args: unknown[]) => void): unknown
  exit(code?: number): void
}

interface ProcessLike {
  on(event: FatalProcessEvent, listener: (...args: unknown[]) => void): unknown
}

export interface MainProcessHandlerDeps {
  app: AppLike
  cleanup: () => Promise<void> | void
  processTarget?: ProcessLike
  emitMetric?: (name: ProcessMetricName, payload?: Record<string, unknown>) => void
  recordEvent?: (event: MainProcessEventRecord) => Promise<void> | void
  timeoutMs?: number
  logger?: Pick<Console, 'warn' | 'error'>
  now?: () => Date
}

const DEFAULT_FATAL_CLEANUP_TIMEOUT_MS = 5_000
const processEventLogger = createRotatingLogger('ready-process-events.log', { buffered: true })

function serializeError(error: unknown): MainProcessEventRecord['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return { message: String(error) }
}

function summarizeDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== 'object') return {}
  const input = details as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  for (const key of ['reason', 'type', 'exitCode', 'serviceName']) {
    if (key in input) summary[key] = input[key]
  }
  return summary
}

function safeEmitMetric(
  emitMetric: (name: ProcessMetricName, payload?: Record<string, unknown>) => void,
  name: ProcessMetricName,
  payload: Record<string, unknown>,
): void {
  try {
    emitMetric(name, payload)
  } catch {
    // Process handlers must never fail while reporting the failure.
  }
}

async function safeRecordEvent(
  recordEvent: (event: MainProcessEventRecord) => Promise<void> | void,
  event: MainProcessEventRecord,
): Promise<void> {
  try {
    await recordEvent(event)
  } catch {
    // Process handlers must never fail while reporting the failure.
  }
}

async function runCleanupWithTimeout(
  cleanup: () => Promise<void> | void,
  timeoutMs: number,
  logger: Pick<Console, 'warn'>,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref()
    }
  })
  const cleanupPromise = Promise.resolve()
    .then(() => cleanup())
    .catch((error) => {
      logger.warn('[process-handlers] fatal cleanup failed', error)
    })

  const winner = await Promise.race([cleanupPromise, timeout])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (winner === 'timeout') {
    logger.warn(`[process-handlers] fatal cleanup timed out after ${timeoutMs}ms`)
  }
}

export function registerMainProcessHandlers(deps: MainProcessHandlerDeps): void {
  const processTarget = deps.processTarget ?? process
  const emitMetric = deps.emitMetric ?? logAgentMetric
  const recordEvent = deps.recordEvent ?? ((event) => {
    processEventLogger.append(`${JSON.stringify(event)}\n`)
  })
  const logger = deps.logger ?? console
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FATAL_CLEANUP_TIMEOUT_MS
  const now = deps.now ?? (() => new Date())
  let fatalExitStarted = false

  const handleFatal = (kind: FatalProcessEvent, error: unknown, details: Record<string, unknown>): void => {
    if (fatalExitStarted) return
    fatalExitStarted = true
    const event: MainProcessEventRecord = {
      at: now().toISOString(),
      kind,
      error: serializeError(error),
      details,
    }
    const metricName = kind === 'unhandledRejection'
      ? PROCESS_METRICS.processUnhandledRejection
      : PROCESS_METRICS.processUncaughtException
    safeEmitMetric(emitMetric, metricName, {
      errorName: event.error?.name,
      errorMessage: event.error?.message,
    })
    void safeRecordEvent(recordEvent, event)
      .then(() => runCleanupWithTimeout(deps.cleanup, timeoutMs, logger))
      .finally(() => {
        deps.app.exit(1)
      })
  }

  processTarget.on('unhandledRejection', (reason, promise) => {
    handleFatal('unhandledRejection', reason, { hasPromise: Boolean(promise) })
  })
  processTarget.on('uncaughtException', (error) => {
    handleFatal('uncaughtException', error, {})
  })

  deps.app.on('render-process-gone', (_event, _webContents, details) => {
    const event: MainProcessEventRecord = {
      at: now().toISOString(),
      kind: 'render-process-gone',
      details: summarizeDetails(details),
    }
    safeEmitMetric(emitMetric, PROCESS_METRICS.renderProcessGone, event.details ?? {})
    void safeRecordEvent(recordEvent, event)
  })
  deps.app.on('child-process-gone', (_event, details) => {
    const event: MainProcessEventRecord = {
      at: now().toISOString(),
      kind: 'child-process-gone',
      details: summarizeDetails(details),
    }
    safeEmitMetric(emitMetric, PROCESS_METRICS.childProcessGone, event.details ?? {})
    void safeRecordEvent(recordEvent, event)
  })
}
