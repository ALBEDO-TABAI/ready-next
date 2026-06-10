/**
 * S4-4 — daily-memory scope filter (C4.3).
 *
 * The L1 bootstrap used to inject the whole `memory/<day>.md` file verbatim,
 * so checkpoint entries from UNRELATED scopes leaked imperative text like
 * "请继续这项任务，我会沿着当前进度接着处理" into the current conversation —
 * steering the model toward someone else's task (observed in the 2026-06-09
 * forensics: a reddit-research checkpoint injected into a collection chat).
 *
 * Contract:
 *  - entries whose `- scope:` line prefix-matches the current scope title
 *    keep their full block;
 *  - entries from other scopes keep factual metadata lines but DROP summary
 *    lines and any line carrying task-imperative phrasing;
 *  - the daily file format has no scope id, only a (truncated) title — when
 *    matching is uncertain we err toward stripping imperatives.
 */

const ENTRY_HEADER = /^## \d{4}-\d{2}-\d{2}T/
const SCOPE_LINE = /^-\s*scope:\s*(.*)$/
const SUMMARY_LINE = /^-\s*summary:/
const IMPERATIVE_PATTERN = /(?:请继续|请接着|继续这项任务|接着处理|请立即|继续推进|resume this task|please continue)/i

const SCOPE_MATCH_MIN_PREFIX = 6

function scopeMatches(entryScope: string, currentScopeTitle: string): boolean {
  const a = entryScope.trim()
  const b = String(currentScopeTitle || '').trim()
  if (!a || !b) return false
  const len = Math.min(a.length, b.length)
  if (len < SCOPE_MATCH_MIN_PREFIX) return a === b
  return a.slice(0, len) === b.slice(0, len)
}

export function filterDailyMemoryForScope(content: string, currentScopeTitle: string): string {
  const raw = String(content || '')
  if (!raw.trim()) return raw
  const lines = raw.split('\n')

  type Block = { header: string | null; lines: string[] }
  const blocks: Block[] = []
  let current: Block = { header: null, lines: [] }
  for (const line of lines) {
    if (ENTRY_HEADER.test(line)) {
      blocks.push(current)
      current = { header: line, lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  blocks.push(current)

  const out: string[] = []
  for (const block of blocks) {
    if (block.header === null) {
      // preamble before the first timestamp entry — pass through
      out.push(...block.lines)
      continue
    }
    const scopeLine = block.lines.find((line) => SCOPE_LINE.test(line))
    const entryScope = scopeLine ? (SCOPE_LINE.exec(scopeLine)?.[1] ?? '') : ''
    const isOwnScope = scopeMatches(entryScope, currentScopeTitle)
    if (isOwnScope) {
      out.push(block.header, ...block.lines)
      continue
    }
    // foreign scope: factual metadata stays, summaries and imperatives go
    out.push(block.header)
    for (const line of block.lines) {
      if (SUMMARY_LINE.test(line)) continue
      if (IMPERATIVE_PATTERN.test(line)) continue
      out.push(line)
    }
  }
  return out.join('\n')
}
