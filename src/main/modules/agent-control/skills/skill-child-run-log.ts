/**
 * Phase 1 — Append-only JSONL event log helpers for skill child runs.
 *
 * Each child run owns a single JSONL file under
 * `<runtimeRoot>/.ready/child-runs/<childRunId>.jsonl`. Legacy runs may
 * still have logs at `<outputDir>/.ready/child-runs/<childRunId>.jsonl`.
 * Lines are written
 * one event per line, compact JSON, terminated by `\n`. The reader is
 * tolerant of corrupt lines so a partial flush does not poison recovery.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SkillChildRunEvent } from './skill-child-run-types'

const CHILD_RUNS_SUBDIR = path.join('.ready', 'child-runs')

export interface AppendChildRunEventOptions {
  logPath: string
  event: SkillChildRunEvent
}

export interface ReadChildRunLogResult {
  events: SkillChildRunEvent[]
  parseErrors: { line: number; raw: string; error: string }[]
}

export interface ReadChildRunLogForResumeOptions {
  runtimeRoot: string
  outputDir: string
  childRunId: string
  persistedEventLogPath?: string | null
}

export interface ReadChildRunLogForResumeResult extends ReadChildRunLogResult {
  logPath: string
}

export function deriveRuntimeChildRunLogPath(runtimeRoot: string, childRunId: string): string {
  return path.join(runtimeRoot, CHILD_RUNS_SUBDIR, `${childRunId}.jsonl`)
}

export function deriveLegacyChildRunLogPath(outputDir: string, childRunId: string): string {
  return path.join(outputDir, CHILD_RUNS_SUBDIR, `${childRunId}.jsonl`)
}

export const deriveChildRunLogPath = deriveLegacyChildRunLogPath

export async function resolveChildRunLogPathForResume(
  opts: ReadChildRunLogForResumeOptions,
): Promise<string> {
  if (opts.persistedEventLogPath) return opts.persistedEventLogPath
  const runtimePath = deriveRuntimeChildRunLogPath(opts.runtimeRoot, opts.childRunId)
  if (await isNonEmptyFile(runtimePath)) return runtimePath
  const legacyPath = deriveLegacyChildRunLogPath(opts.outputDir, opts.childRunId)
  if (await isNonEmptyFile(legacyPath)) return legacyPath
  return runtimePath
}

export async function appendChildRunEvent(opts: AppendChildRunEventOptions): Promise<void> {
  const { logPath, event } = opts
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  // Stage T (W9.1) — Worker Event Ledger. The new fields
  // `event_kind / ts / terminal_reason / rollback_target` are written
  // through unchanged — callers are responsible for setting them when
  // relevant (terminal events set `event_kind` + `terminal_reason`;
  // cancel terminals also set `rollback_target`). Pass-through keeps
  // backward-compat with pre-Stage-T callers that emit only the legacy
  // shape.
  // Compact JSON, single line, trailing newline. `appendFile` opens the
  // file in append mode each call, which is atomic enough for the
  // single-writer (driver) child-run model.
  const line = `${JSON.stringify(event)}\n`
  await fs.appendFile(logPath, line, { encoding: 'utf8' })
}

/**
 * Stage T (W9.2) — diagnostic helper for renderer / debugging consumers.
 * Reads the JSONL log and returns the `rollback_target` from the most
 * recent close event tagged with `event_kind === 'cancelled'` (or any
 * close carrying a `rollback_target` field for future-proofing).
 *
 * Returns `undefined` when no cancel close exists; `null` when a cancel
 * close exists but no safe step was recorded; otherwise the safe step id.
 *
 * Explicitly does NOT trigger any rollback action — pure read.
 */
export async function readChildRunRollbackTarget(
  logPath: string,
): Promise<string | null | undefined> {
  const result = await readChildRunLog(logPath)
  for (let i = result.events.length - 1; i >= 0; i--) {
    const event = result.events[i]
    if (!event || event.type !== 'close') continue
    if (event.event_kind !== 'cancelled') continue
    return event.rollback_target ?? null
  }
  return undefined
}

export async function readChildRunLog(logPath: string): Promise<ReadChildRunLogResult> {
  let raw: string
  try {
    raw = await fs.readFile(logPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      return { events: [], parseErrors: [] }
    }
    // Non-ENOENT errors (permissions, IO) are surfaced — they are not
    // recoverable by skipping a line.
    throw err
  }

  const events: SkillChildRunEvent[] = []
  const parseErrors: { line: number; raw: string; error: string }[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue // skip blank lines (including final trailing newline)
    try {
      const parsed = JSON.parse(line) as SkillChildRunEvent
      events.push(parsed)
    } catch (err) {
      parseErrors.push({
        line: i + 1,
        raw: line,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { events, parseErrors }
}

export async function readChildRunLogForResume(
  opts: ReadChildRunLogForResumeOptions,
): Promise<ReadChildRunLogForResumeResult> {
  const logPath = await resolveChildRunLogPathForResume(opts)
  const result = await readChildRunLog(logPath)
  return { logPath, ...result }
}

async function isNonEmptyFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() && stat.size > 0
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return false
    throw err
  }
}
