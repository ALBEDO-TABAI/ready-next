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
  flush(): void
}

export interface RotatingLoggerOptions {
  maxBytes?: number
  maxFiles?: number
  resolvePath?: (filename: string) => string
  emitMetric?: ((name: ProcessMetricName, payload?: Record<string, unknown>) => void) | null
  buffered?: boolean
  flushIntervalMs?: number
  flushBytes?: number
}

interface BufferedSink {
  append(text: string): void
  flush(): void
}

const DEFAULT_FLUSH_INTERVAL_MS = 250
const DEFAULT_FLUSH_BYTES = 64 * 1024
const bufferedSinks = new Map<string, BufferedSink>()
let exitFlushInstalled = false

export function flushBufferedRotatingLoggers(): void {
  for (const sink of bufferedSinks.values()) sink.flush()
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
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const flushBytes = options.flushBytes ?? DEFAULT_FLUSH_BYTES
  const existingBufferedSink = options.buffered ? bufferedSinks.get(path) : undefined
  if (existingBufferedSink) {
    return {
      path,
      append: (text) => existingBufferedSink.append(text),
      appendAsync: async (text) => existingBufferedSink.append(text),
      flush: () => existingBufferedSink.flush(),
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  let currentBytes = fileSize(path)

  const rotateIfNeeded = (incomingBytes: number): void => {
    if (currentBytes === 0 || currentBytes + incomingBytes <= maxBytes) return
    try {
      rotate(path, maxFiles)
      currentBytes = 0
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

  const appendSync = (text: string): void => {
    const bytes = Buffer.byteLength(text)
    rotateIfNeeded(bytes)
    appendFileSync(path, text, 'utf8')
    currentBytes += bytes
  }

  if (options.buffered) {
    let sink = bufferedSinks.get(path)
    if (!sink) {
      let chunks: string[] = []
      let bufferedBytes = 0
      let timer: ReturnType<typeof setTimeout> | null = null

      const flush = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (bufferedBytes === 0) return
        const text = chunks.join('')
        chunks = []
        bufferedBytes = 0
        try {
          appendSync(text)
        } catch (error) {
          chunks.unshift(text)
          bufferedBytes += Buffer.byteLength(text)
          throw error
        }
      }

      const schedule = (): void => {
        if (timer) return
        timer = setTimeout(() => {
          try {
            flush()
          } catch {
            // Logging failures must not surface as uncaught timer exceptions.
          }
        }, flushIntervalMs)
        timer.unref?.()
      }

      sink = {
        append(text: string): void {
          chunks.push(text)
          bufferedBytes += Buffer.byteLength(text)
          if (bufferedBytes >= flushBytes) {
            flush()
          } else {
            schedule()
          }
        },
        flush,
      }
      bufferedSinks.set(path, sink)
    }

    if (!exitFlushInstalled) {
      exitFlushInstalled = true
      process.on('exit', () => {
        try {
          flushBufferedRotatingLoggers()
        } catch {
          // Exit-time log preservation is best effort and cannot delay shutdown.
        }
      })
    }

    const activeSink = sink
    return {
      path,
      append: (text) => activeSink.append(text),
      appendAsync: async (text) => activeSink.append(text),
      flush: () => activeSink.flush(),
    }
  }

  return {
    path,
    append: appendSync,
    async appendAsync(text: string): Promise<void> {
      const bytes = Buffer.byteLength(text)
      rotateIfNeeded(bytes)
      await appendFile(path, text, 'utf8')
      currentBytes += bytes
    },
    flush(): void {},
  }
}
