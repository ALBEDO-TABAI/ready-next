import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getLogPath } from './platform'
import { PROCESS_METRICS, type ProcessMetricName } from './process-metrics'

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_FILES = 5
export const READY_LOG_MAX_BYTES = 'READY_LOG_MAX_BYTES'
export const READY_LOG_MAX_FILES = 'READY_LOG_MAX_FILES'

export interface RotatingLogger {
  readonly path: string
  append(text: string): void
  appendAsync(text: string): Promise<void>
}

export interface RotatingLoggerOptions {
  maxBytes?: number
  maxFiles?: number
  resolvePath?: (filename: string) => string
  emitMetric?: ((name: ProcessMetricName, payload?: Record<string, unknown>) => void) | null
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeLimit(value: number | undefined, envName: string, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  return parsePositiveInteger(process.env[envName], fallback)
}

function defaultEmitMetric(name: ProcessMetricName, payload: Record<string, unknown> = {}): void {
  try {
    const metricPath = getLogPath('ready-agent-metrics.log')
    mkdirSync(dirname(metricPath), { recursive: true })
    appendFileSync(metricPath, `${JSON.stringify({
      at: new Date().toISOString(),
      metric: name,
      ...payload,
    })}\n`, 'utf8')
  } catch {
    // Observability must not break the path that is already handling logging.
  }
}

function fileSize(path: string): number {
  if (!existsSync(path)) return 0
  return statSync(path).size
}

function rotate(path: string, maxFiles: number): void {
  if (maxFiles <= 0) {
    if (existsSync(path)) unlinkSync(path)
    return
  }
  const oldest = `${path}.${maxFiles}`
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = `${path}.${index}`
    const to = `${path}.${index + 1}`
    if (existsSync(from)) renameSync(from, to)
  }
  if (existsSync(path)) renameSync(path, `${path}.1`)
}

export function createRotatingLogger(
  filename: string,
  options: RotatingLoggerOptions = {},
): RotatingLogger {
  const resolvePath = options.resolvePath ?? getLogPath
  const path = resolvePath(filename)
  const maxBytes = normalizeLimit(options.maxBytes, READY_LOG_MAX_BYTES, DEFAULT_MAX_BYTES)
  const maxFiles = normalizeLimit(options.maxFiles, READY_LOG_MAX_FILES, DEFAULT_MAX_FILES)
  const emitMetric = options.emitMetric === undefined ? defaultEmitMetric : options.emitMetric

  const rotateIfNeeded = (incomingBytes: number): void => {
    mkdirSync(dirname(path), { recursive: true })
    const currentSize = fileSize(path)
    if (currentSize === 0 || currentSize + incomingBytes <= maxBytes) return
    try {
      rotate(path, maxFiles)
    } catch (error) {
      try {
        emitMetric?.(PROCESS_METRICS.logRotationFailed, {
          filename,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      } catch {
        // Metric failures must never break log append.
      }
    }
  }

  return {
    path,
    append(text: string): void {
      rotateIfNeeded(Buffer.byteLength(text))
      appendFileSync(path, text, 'utf8')
    },
    async appendAsync(text: string): Promise<void> {
      rotateIfNeeded(Buffer.byteLength(text))
      await appendFile(path, text, 'utf8')
    },
  }
}
