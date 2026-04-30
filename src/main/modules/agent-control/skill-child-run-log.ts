/**
 * Phase 1 — Append-only JSONL event log helpers for skill child runs.
 *
 * Each child run owns a single JSONL file under
 * `<outputDir>/.ready/child-runs/<childRunId>.jsonl`. Lines are written
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

export function deriveChildRunLogPath(outputDir: string, childRunId: string): string {
  return path.join(outputDir, CHILD_RUNS_SUBDIR, `${childRunId}.jsonl`)
}

export async function appendChildRunEvent(opts: AppendChildRunEventOptions): Promise<void> {
  const { logPath, event } = opts
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  // Compact JSON, single line, trailing newline. `appendFile` opens the
  // file in append mode each call, which is atomic enough for the
  // single-writer (driver) child-run model.
  const line = `${JSON.stringify(event)}\n`
  await fs.appendFile(logPath, line, { encoding: 'utf8' })
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
