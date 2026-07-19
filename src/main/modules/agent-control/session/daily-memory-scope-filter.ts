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
 *  - entries whose `- scope-id:` exactly matches the current scope keep their
 *    full block;
 *  - entries from every other scope are omitted as a whole;
 *  - legacy title-only entries are not guessed into a scope. Current messages,
 *    task projection and auto-recall already provide bounded continuity.
 */

const ENTRY_HEADER = /^## \d{4}-\d{2}-\d{2}T/
const SCOPE_ID_LINE = /^-\s*scope-id:\s*(.*)$/

export function filterDailyMemoryForScope(content: string, currentScopeId: string): string {
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
    const scopeIdLine = block.lines.find((line) => SCOPE_ID_LINE.test(line))
    const entryScopeId = scopeIdLine ? (SCOPE_ID_LINE.exec(scopeIdLine)?.[1] ?? '').trim() : ''
    const isOwnScope = Boolean(entryScopeId && entryScopeId === String(currentScopeId || '').trim())
    if (isOwnScope) {
      out.push(block.header, ...block.lines)
    }
  }
  return out.join('\n')
}
