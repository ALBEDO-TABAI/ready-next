/**
 * P0-4 (2026-07-02 P0 visibility batch) — run quality stats aggregated from
 * the agent metrics JSONL log (single source: run_close /
 * adjudicator_enforce_divergence / provider_stream_first_delta /
 * provider_stream_fallback all land there; zero DB surface).
 *
 * `aggregateRunQualityStats` is pure; `readMetricsLogTailLines` is the thin
 * IO shell (bounded tail read so a long-lived log cannot balloon the IPC).
 * Malformed lines are skipped, never fatal（账本消费纪律：坏行不带病显示）。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface RunQualityDay {
  date: string
  total: number
  done: number
  proofGap: number
  degraded: number
  unconfirmed: number
}

export interface RunQualityStats {
  windowDays: number
  sampleSize: number
  days: RunQualityDay[]
  divergenceCount: number
  firstDelta: { count: number; p50Ms: number | null; avgMs: number | null }
  streamFallbacks: Record<string, number>
}

const DEFAULT_WINDOW_DAYS = 14
export const METRICS_TAIL_MAX_BYTES = 5 * 1024 * 1024

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

export function aggregateRunQualityStats(
  lines: Iterable<string>,
  options: { now: Date; windowDays?: number },
): RunQualityStats {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const windowStartMs = options.now.getTime() - windowDays * 86_400_000
  const dayBuckets = new Map<string, RunQualityDay>()
  const firstDeltaSamples: number[] = []
  const streamFallbacks: Record<string, number> = {}
  let divergenceCount = 0
  let sampleSize = 0

  for (const line of lines) {
    const event = parseLine(line)
    if (!event) continue
    const at = typeof event.at === 'string' ? Date.parse(event.at) : Number.NaN
    if (!Number.isFinite(at) || at < windowStartMs || at > options.now.getTime() + 60_000) continue
    const metric = typeof event.metric === 'string' ? event.metric : ''
    if (metric === 'run_close') {
      sampleSize += 1
      const date = new Date(at).toISOString().slice(0, 10)
      const bucket = dayBuckets.get(date)
        || { date, total: 0, done: 0, proofGap: 0, degraded: 0, unconfirmed: 0 }
      bucket.total += 1
      const reason = typeof event.terminalReason === 'string' ? event.terminalReason : ''
      if (reason === 'done') bucket.done += 1
      else if (reason === 'proof_gap') bucket.proofGap += 1
      else if (reason === 'adjudication_degraded') bucket.degraded += 1
      else if (reason === 'browser_transaction_unconfirmed') bucket.unconfirmed += 1
      dayBuckets.set(date, bucket)
      continue
    }
    if (metric === 'adjudicator_enforce_divergence') {
      divergenceCount += 1
      continue
    }
    if (metric === 'provider_stream_first_delta') {
      const ms = Number(event.ms)
      if (Number.isFinite(ms) && ms >= 0) firstDeltaSamples.push(ms)
      continue
    }
    if (metric === 'provider_stream_fallback') {
      const reason = typeof event.reason === 'string' && event.reason ? event.reason : 'unknown'
      streamFallbacks[reason] = (streamFallbacks[reason] || 0) + 1
    }
  }

  const sortedFirstDelta = [...firstDeltaSamples].sort((a, b) => a - b)
  const avgMs = sortedFirstDelta.length > 0
    ? Math.round(sortedFirstDelta.reduce((sum, value) => sum + value, 0) / sortedFirstDelta.length)
    : null
  return {
    windowDays,
    sampleSize,
    days: [...dayBuckets.values()].sort((a, b) => a.date.localeCompare(b.date)),
    divergenceCount,
    firstDelta: {
      count: sortedFirstDelta.length,
      p50Ms: percentile(sortedFirstDelta, 0.5),
      avgMs,
    },
    streamFallbacks,
  }
}

function readFileTail(path: string, maxBytes: number): string {
  if (!existsSync(path)) return ''
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const readBytes = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(readBytes)
    readSync(fd, buffer, 0, readBytes, size - readBytes)
    const text = buffer.toString('utf-8')
    // Drop the first (possibly partial) line when the read was truncated.
    if (readBytes < size) {
      const firstNewline = text.indexOf('\n')
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return text
  } finally {
    closeSync(fd)
  }
}

/** Reads the rotated file first (older events) then the live file, bounded
 *  per file, so the aggregate window survives a recent rotation. */
export function readMetricsLogTailLines(options: { maxBytes?: number } = {}): string[] {
  const maxBytes = options.maxBytes ?? METRICS_TAIL_MAX_BYTES
  const base = join(tmpdir(), 'ready-agent-metrics.log')
  const lines: string[] = []
  for (const path of [`${base}.1`, base]) {
    try {
      const text = readFileTail(path, maxBytes)
      if (text) lines.push(...text.split('\n'))
    } catch {
      // silent-catch: 读取失败按空日志处理：看板显示空数据，绝不打断设置页。
    }
  }
  return lines
}
