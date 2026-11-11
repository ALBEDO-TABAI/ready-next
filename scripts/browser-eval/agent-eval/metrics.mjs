// Measurements for one live attempt. Each attempt runs in its own throwaway profile, so every
// row and every Codex rollout in that profile belongs to the attempt.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const INTERVENTION_ERROR_KINDS = [
  'challenge_required',
  'login_required',
  'auth_required',
  'verification_required',
  'credential_confirmation_required',
  'foreground_required',
  'browser_surface_required',
]

function findTokenUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null
  if (value.total_token_usage && typeof value.total_token_usage === 'object') return value.total_token_usage
  for (const child of Object.values(value)) {
    const found = findTokenUsage(child, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Codex writes `token_count` events with a running `total_token_usage` into each rollout file.
 * The last one per file is that thread's total; threads are summed.
 */
export function tokensFromRolloutText(text) {
  let last = null
  for (const line of String(text).split('\n')) {
    if (!line.includes('total_token_usage')) continue
    try {
      const usage = findTokenUsage(JSON.parse(line))
      if (usage) last = usage
    } catch { /* a partially written last line is ignored */ }
  }
  if (!last) return null
  return {
    input: Number(last.input_tokens || 0),
    cachedInput: Number(last.cached_input_tokens || 0),
    output: Number(last.output_tokens || 0) + Number(last.reasoning_output_tokens || 0),
    total: Number(last.total_tokens || 0) || Number(last.input_tokens || 0) + Number(last.output_tokens || 0),
  }
}

function listFiles(dir, predicate, out = [], depth = 0) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth < 6) listFiles(path, predicate, out, depth + 1)
    else if (entry.isFile() && predicate(entry.name)) out.push(path)
  }
  return out
}

/** Sum token totals over every rollout under the attempt's Codex home. */
export function tokensFromCodexHome(codexHome) {
  const files = listFiles(codexHome, (name) => /^rollout-.*\.jsonl$/.test(name))
  const sum = { input: 0, cachedInput: 0, output: 0, total: 0, threads: 0 }
  for (const file of files) {
    let text = ''
    try { text = statSync(file).size > 0 ? readFileSync(file, 'utf8') : '' } catch { continue }
    const tokens = tokensFromRolloutText(text)
    if (!tokens) continue
    sum.input += tokens.input
    sum.cachedInput += tokens.cachedInput
    sum.output += tokens.output
    sum.total += tokens.total
    sum.threads += 1
  }
  return sum.threads > 0 ? { ...sum, method: 'codex_rollout' } : null
}

/**
 * Fallback when no rollout carries token counts: the gateway keeps the byte size of every
 * request it forwarded. Input ≈ bytes / 3 overstates English and roughly fits Chinese JSON;
 * output is unknown and budgeted as 10 % of input. Marked as an estimate everywhere.
 */
export function estimatedTokensFromGateway(db) {
  const row = db.prepare(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(body_bytes), 0) AS bytes
       FROM ready_model_gateway_exchange_events
      WHERE event_kind = 'request_admitted'`,
  ).get()
  if (!row || Number(row.requests) === 0) return null
  const input = Math.ceil(Number(row.bytes) / 3)
  const output = Math.ceil(input * 0.1)
  return { input, cachedInput: 0, output, total: input + output, requests: Number(row.requests), method: 'estimated' }
}

export function modelRequestCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM ready_model_gateway_request_receipts').get()?.n || 0)
}

/** Model tool calls admitted for the run, total and by tool. */
export function toolCalls(db, runId) {
  const rows = db.prepare(
    `SELECT tool_name AS tool, COUNT(*) AS n
       FROM codex_tool_call_admissions
      WHERE ready_run_id = ?
      GROUP BY tool_name
      ORDER BY n DESC`,
  ).all(runId)
  const byTool = Object.fromEntries(rows.map((row) => [row.tool, Number(row.n)]))
  return { total: rows.reduce((sum, row) => sum + Number(row.n), 0), byTool }
}

/** Tool results that stopped on something only a person can resolve. */
export function blockingResults(db) {
  const counts = {}
  const rows = db.prepare(
    `SELECT result_json FROM ready_tool_action_receipts WHERE result_json IS NOT NULL`,
  ).all()
  for (const row of rows) {
    const text = String(row.result_json)
    for (const kind of INTERVENTION_ERROR_KINDS) {
      if (text.includes(`"${kind}"`) || text.includes(`\\"${kind}\\"`)) counts[kind] = (counts[kind] || 0) + 1
    }
  }
  return counts
}

export function tokensForAttempt({ codexHome, db }) {
  return tokensFromCodexHome(codexHome) || (db ? estimatedTokensFromGateway(db) : null)
}
