import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  readLifecycle,
  shouldRetain,
} from '../agent-control/output-dir-lifecycle'
import {
  deriveRuntimeChildRunLogPath,
} from '../agent-control/skill-child-run-log'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'

const DEFAULT_OUTPUT_DIR_RETENTION_DAYS = 7
const DEFAULT_LEGACY_GRACE_DAYS = 30
const DEFAULT_CHILD_RUN_LOG_RETENTION_DAYS = 30

export interface SweepMetricPayload {
  removedCount?: number
  skippedCount?: number
  failedCount?: number
  error?: string
}

export type SweepMetricEmitter = (
  metric: string,
  payload: SweepMetricPayload,
) => void

export interface SweepOutputDirsOptions {
  runtimeRoot: string
  now?: Date
  retentionDays?: number
  legacyGraceDays?: number
  emitMetric?: SweepMetricEmitter
}

export interface SweepChildRunLogsOptions {
  runtimeRoot: string
  now?: Date
  retentionDays?: number
  emitMetric?: SweepMetricEmitter
}

export interface SweepResult {
  scannedCount: number
  removedCount: number
  skippedCount: number
  failedCount: number
}

export async function sweepOutputDirs(opts: SweepOutputDirsOptions): Promise<SweepResult> {
  const now = opts.now ?? new Date()
  const retentionMs = daysToMs(opts.retentionDays ?? DEFAULT_OUTPUT_DIR_RETENTION_DAYS)
  const legacyGraceMs = daysToMs(opts.legacyGraceDays ?? DEFAULT_LEGACY_GRACE_DAYS)
  const outputsRoot = path.join(opts.runtimeRoot, 'outputs')
  const result: SweepResult = {
    scannedCount: 0,
    removedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  }

  let skillIds: string[]
  try {
    skillIds = await listDirectoryNames(outputsRoot)
  } catch {
    emit(opts.emitMetric, TOOL_ERROR_METRICS.outputDirGc, result)
    return result
  }

  for (const skillId of skillIds) {
    const skillRoot = path.join(outputsRoot, skillId)
    const childRunIds = await listDirectoryNames(skillRoot)
    for (const childRunId of childRunIds) {
      const outputDir = path.join(skillRoot, childRunId)
      result.scannedCount += 1
      try {
        if (!(await shouldRemoveOutputDir(outputDir, now, retentionMs, legacyGraceMs))) {
          result.skippedCount += 1
          continue
        }
        await fs.rm(outputDir, { recursive: true, force: true })
        result.removedCount += 1
      } catch {
        result.failedCount += 1
      }
    }
  }

  emit(opts.emitMetric, TOOL_ERROR_METRICS.outputDirGc, result)
  if (result.failedCount > 0) {
    emit(opts.emitMetric, TOOL_ERROR_METRICS.outputDirSweepFailed, result)
  }
  return result
}

export async function sweepChildRunLogs(opts: SweepChildRunLogsOptions): Promise<SweepResult> {
  const now = opts.now ?? new Date()
  const retentionMs = daysToMs(opts.retentionDays ?? DEFAULT_CHILD_RUN_LOG_RETENTION_DAYS)
  const logDir = path.dirname(deriveRuntimeChildRunLogPath(opts.runtimeRoot, 'placeholder'))
  const result: SweepResult = {
    scannedCount: 0,
    removedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  }

  let entries: string[]
  try {
    entries = await fs.readdir(logDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'ENOENT') result.failedCount += 1
    emit(opts.emitMetric, TOOL_ERROR_METRICS.childRunLogGc, result)
    return result
  }

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const file = path.join(logDir, entry)
    result.scannedCount += 1
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) {
        result.skippedCount += 1
        continue
      }
      if (now.getTime() - stat.mtimeMs <= retentionMs) {
        result.skippedCount += 1
        continue
      }
      await fs.rm(file, { force: true })
      result.removedCount += 1
    } catch {
      result.failedCount += 1
    }
  }

  emit(opts.emitMetric, TOOL_ERROR_METRICS.childRunLogGc, result)
  return result
}

async function shouldRemoveOutputDir(
  outputDir: string,
  now: Date,
  retentionMs: number,
  legacyGraceMs: number,
): Promise<boolean> {
  const lifecycle = readLifecycle(outputDir)
  if (lifecycle) {
    if (lifecycle.state === 'active') return false
    if (lifecycle.state === 'retained' && !lifecycle.retainUntil && lifecycle.terminalAt) {
      const terminalAtMs = Date.parse(lifecycle.terminalAt)
      if (Number.isFinite(terminalAtMs)) return now.getTime() - terminalAtMs > retentionMs
    }
    return !shouldRetain(lifecycle, now)
  }

  const stat = await fs.stat(outputDir)
  return now.getTime() - stat.mtimeMs > legacyGraceMs
}

async function listDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return []
    throw error
  }
}

function emit(
  emitter: SweepMetricEmitter | undefined,
  metric: string,
  payload: SweepMetricPayload,
): void {
  if (emitter) {
    emitter(metric, payload)
    return
  }
  logAgentMetric(metric, payload as Record<string, unknown>)
}

function daysToMs(days: number): number {
  return Math.max(0, days) * 24 * 60 * 60 * 1000
}
