#!/usr/bin/env node
/**
 * EP2-Q4a — divergence list exporter (the Q4b promotion gate tool).
 *
 * Usage:
 *   node scripts/export-adjudicator-divergence.cjs [--since <ISO>] [--file <metrics.log>]
 *
 * Reads the agent metrics log (JSONL), filters `adjudicator_shadow_divergence`
 * rows at/after --since, and prints a JSON report:
 *   { count, totalTerminalRuns, taskTypes, rows: [...] }
 * `totalTerminalRuns` counts run_close rows in the same window so the Q4b
 * sample-size precondition (≥50 terminal runs) is checkable from one output.
 */

const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const args = process.argv.slice(2)
function argOf(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : null
}

const sinceArg = argOf('--since')
const since = sinceArg ? Date.parse(sinceArg) : 0
if (sinceArg && !Number.isFinite(since)) {
  console.error(`invalid --since: ${sinceArg}`)
  process.exit(2)
}
const file = argOf('--file') || join(tmpdir(), 'ready-agent-metrics.log')

if (!existsSync(file)) {
  console.log(JSON.stringify({ count: 0, totalTerminalRuns: 0, taskTypes: {}, rows: [], note: `metrics log not found: ${file}` }))
  process.exit(0)
}

const rows = []
const taskTypes = {}            // coverage: ALL terminal runs (run_close rows) — P0-4
const divergenceTaskTypes = {}  // divergence rows only, reported separately
let totalTerminalRuns = 0
let typedTerminalRuns = 0
for (const line of readFileSync(file, 'utf-8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed) continue
  let event
  try { event = JSON.parse(trimmed) } catch { continue } // malformed line: skipped, never fatal
  const at = Date.parse(event.at || '')
  if (!Number.isFinite(at) || at < since) continue
  if (event.metric === 'run_close') {
    totalTerminalRuns += 1
    if (event.taskType) {
      typedTerminalRuns += 1
      const key = String(event.taskType)
      taskTypes[key] = (taskTypes[key] ?? 0) + 1
    } else {
      taskTypes.unknown = (taskTypes.unknown ?? 0) + 1
    }
    continue
  }
  if (event.metric !== 'adjudicator_shadow_divergence') continue
  rows.push({
    at: event.at,
    runId: event.runId ?? null,
    taskId: event.taskId ?? null,
    taskType: event.taskType ?? null,
    verdict: event.verdict ?? null,
    actualStatus: event.actualStatus ?? null,
    terminalReason: event.terminalReason ?? null,
    proofCount: event.proofCount ?? null,
    blockers: event.blockers ?? [],
    /** Q4b review fills this: false_reject | true_reject | template_fixed */
    disposition: null,
  })
  const key = String(event.taskType ?? 'unknown')
  divergenceTaskTypes[key] = (divergenceTaskTypes[key] ?? 0) + 1
}

console.log(JSON.stringify({ count: rows.length, totalTerminalRuns, typedTerminalRuns, taskTypes, divergenceTaskTypes, rows }, null, 2))
