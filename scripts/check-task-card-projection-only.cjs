#!/usr/bin/env node
/**
 * Stage O §3.1 gate.
 *
 * Asserts that every `taskProjectionToTaskCardRun({...})` call (renderer
 * task-card constructor — there are exactly four call sites today) sources
 * its blacklist fields ONLY from a `projection`-named identifier, a small
 * set of named projection helpers, or bare literals. The renderer must not
 * fall back to scopeRunStates ("run.X") for any field that drives task
 * card display state.
 *
 * Why a hard whitelist?
 *   v1/v2 of the gate banned `run.X` patterns; v3 review showed that
 *   identifiers named `snapshot`, `cached`, etc. would slip through. v5
 *   inverts the rule: blacklist fields must satisfy ONE of these forms.
 *
 *   (1) projection chain: `projection.X` / `projection?.X` / arbitrary depth.
 *   (2) projection chain + literal tail: `(1) ?? <literal>` or `(1) || <literal>`
 *       where literal is `null|undefined|[]|{}|'<str>'|"<str>"|<int>|true|false|'none'`.
 *       Multiple `(1)` chains may be coalesced as long as no non-projection
 *       identifier appears.
 *   (3) named helper: `resolveProjectionWaitingFor(projection)`,
 *       `resolveProjectionBlockedReason(projection)`, or
 *       `normalizeProjectionSteps(projection?.steps)` /
 *       `normalizeProjectionSteps(projection.steps)`. May be wrapped in
 *       `?? <literal>` / `|| <literal>` for empty-collection coalescing.
 *   (4) bare literal: same set as case-2 tail. Used by `inMemoryTaskRuns`
 *       to blank fields when projection has not yet caught up.
 *
 * Spread expressions (`...run`, `...persistedRun`, etc.) inside the
 * `taskProjectionToTaskCardRun({...})` call body are unconditionally
 * rejected — they implicitly carry blacklist fields from the spread
 * source.
 *
 * Files in scope:
 *   - `src/renderer/components/agent/ChatPanel.tsx`
 *   - `src/renderer/modules/agent/taskCardViewModel.ts`
 *   (Today only ChatPanel actually calls the constructor.)
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SCAN_FILES = [
  'src/renderer/components/agent/ChatPanel.tsx',
  'src/renderer/modules/agent/taskCardViewModel.ts',
]

const BLACKLIST_FIELDS = new Set([
  'status',
  'interactionState',
  'waitingFor',
  'blockedReason',
  'resumableActions',
  'taskContinuation',
  'recentArtifacts',
  'progress',
  'budgetUsagePercent',
  'stepBudget',
  'budgetWarningLevel',
  'degradationReason',
  'recoveryHistory',
  'taskType',
  'currentStepId',
  'steps',
  'taskTitle',
  'taskSummary',
])

const NAMED_HELPERS = new Set([
  'resolveProjectionWaitingFor(projection)',
  'resolveProjectionBlockedReason(projection)',
  'normalizeProjectionSteps(projection?.steps)',
  'normalizeProjectionSteps(projection.steps)',
])

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

/**
 * Walk forward from `start` (a `{` index) using brace depth so we can
 * locate the matching `}` even if the body contains nested `{ … }`.
 * Returns the index AFTER the matching `}`.
 */
function findMatchingBrace(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Split a `{ key: expr, key: expr, ... }` body into top-level
 * `<key>: <expr>` segments. Tracks braces / parens / brackets / strings
 * so a comma inside a nested function call doesn't split the expression.
 */
function splitTopLevelEntries(body) {
  const out = []
  let depth = 0
  let start = 0
  let inString = null // null | "'" | '"' | '`'
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (inString) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
  }
  if (start < body.length) out.push(body.slice(start))
  return out
}

/**
 * Strip line / block comments from an expression text (keeps positions
 * correct enough for our regex needs since the expression is small).
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Trim and collapse internal whitespace for canonical helper match.
 */
function canonical(s) {
  return s.replace(/\s+/g, ' ').trim()
}

const LITERAL_RE = /^(?:null|undefined|\[\]|\{\}|true|false|0|'[^']*'|"[^"]*"|\d+)$/
const PROJECTION_CHAIN_RE = /^projection(?:\?\.|\.)[A-Za-z_$][\w$.?]*$/

function isProjectionChain(expr) {
  return PROJECTION_CHAIN_RE.test(expr.trim())
}

function isLiteral(expr) {
  return LITERAL_RE.test(expr.trim())
}

/**
 * Verify a blacklist-field RHS satisfies one of the four allowed forms.
 * Returns `null` on success or a short reason string on failure.
 */
function validateBlacklistRhs(rhs) {
  const cleaned = canonical(stripComments(rhs))
  if (!cleaned) return 'empty RHS'

  // Case (3): named helper, optionally with a literal tail.
  for (const helper of NAMED_HELPERS) {
    if (cleaned === helper) return null
    const tailRe = new RegExp(`^${helper.replace(/[?.()]/g, (m) => `\\${m}`)}\\s*(\\?\\?|\\|\\|)\\s*(.+)$`)
    const tailMatch = tailRe.exec(cleaned)
    if (tailMatch && isLiteral(tailMatch[2])) return null
  }

  // Case (4): bare literal.
  if (isLiteral(cleaned)) return null

  // Case (1)+(2): projection chain(s), optionally chained with `??` /
  // `||` and a final literal. Split on `??` / `||` and require every
  // intermediate segment to be a projection chain, with the last
  // segment EITHER a projection chain OR a literal.
  const segments = cleaned.split(/\s*(?:\?\?|\|\|)\s*/)
  if (segments.length === 0) return 'no segments'
  // First N-1 segments must be projection chains (otherwise a non-projection
  // source is leaking in via fallback chain).
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!isProjectionChain(segments[i])) {
      return `non-projection source in chain segment "${segments[i]}"`
    }
  }
  const last = segments[segments.length - 1]
  if (isProjectionChain(last) || isLiteral(last)) return null

  return `RHS "${cleaned}" does not match any allowed form`
}

function scanFile(rel, violations) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return
  const text = fs.readFileSync(abs, 'utf8')

  const callRe = /\btaskProjectionToTaskCardRun\s*\(/g
  let cm
  while ((cm = callRe.exec(text))) {
    // The constructor takes an object literal as its first argument.
    // Walk past `(` and any whitespace to find the opening `{`.
    let i = cm.index + cm[0].length
    while (i < text.length && /\s/.test(text[i])) i += 1
    if (text[i] !== '{') continue
    const closeIdx = findMatchingBrace(text, i)
    if (closeIdx < 0) continue
    const body = text.slice(i + 1, closeIdx)

    for (const rawEntry of splitTopLevelEntries(body)) {
      const entry = rawEntry.trim()
      if (!entry) continue

      // Spread guard.
      const spreadMatch = /^\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(entry)
      if (spreadMatch) {
        violations.push({
          file: rel,
          line: lineOf(text, i + 1 + body.indexOf(entry)),
          kind: 'spread_in_constructor',
          detail: `forbidden \`...${spreadMatch[1]}\` spread inside taskProjectionToTaskCardRun({...})`,
        })
        continue
      }

      // `<key>: <expr>` split — `key` may have leading whitespace.
      const colonIdx = entry.indexOf(':')
      if (colonIdx < 0) continue
      const keyRaw = entry.slice(0, colonIdx).trim()
      const exprRaw = entry.slice(colonIdx + 1).trim()
      // Strip optional trailing comma noise.
      const expr = exprRaw.replace(/,$/, '').trim()
      const key = keyRaw.replace(/^['"`]|['"`]$/g, '').trim()
      if (!BLACKLIST_FIELDS.has(key)) continue

      const reason = validateBlacklistRhs(expr)
      if (reason) {
        violations.push({
          file: rel,
          // Approximate line number — points at constructor open brace plus
          // an offset; good enough for grep-and-fix workflow.
          line: lineOf(text, i + 1 + body.indexOf(entry)),
          kind: 'blacklist_field_rhs_not_projection',
          detail: `${key}: ${reason}`,
        })
      }
    }
  }
}

/**
 * Stage O §3.1 case-3 belt — when a constructor RHS uses one of the
 * named helpers, the helper itself must not smuggle `run.<blacklist>`
 * fallback back in. Defense-in-depth against a future commit that
 * "fixes" the gate by routing fallback through the helper.
 */
const HELPER_BODY_PATTERNS = [
  {
    file: 'src/renderer/components/agent/ChatPanel.tsx',
    helpers: [
      { name: 'resolveProjectionWaitingFor', regex: /function\s+resolveProjectionWaitingFor\s*\([^)]*\)\s*:[^{]*\{([\s\S]*?)\n\}/m },
      // resolveProjectionBlockedReason was retired in §1.6; the gate
      // tolerates its absence (no helper body to scan).
    ],
  },
  {
    file: 'src/renderer/components/agent/ChatPanel.tsx',
    helpers: [
      { name: 'normalizeProjectionSteps', regex: /function\s+normalizeProjectionSteps\s*\([^)]*\)\s*:[^{]*\{([\s\S]*?)\n\}/m },
    ],
  },
]

function scanHelperBodies(violations) {
  for (const entry of HELPER_BODY_PATTERNS) {
    const abs = path.join(ROOT, entry.file)
    if (!fs.existsSync(abs)) continue
    const text = fs.readFileSync(abs, 'utf8')
    for (const helper of entry.helpers) {
      const m = helper.regex.exec(text)
      if (!m) continue
      const body = m[1]
      // Forbid any `run.<blacklist-field>` reference inside the helper.
      // Blacklist names are matched literally; the helper accepts a
      // `projection` parameter, not `run`, so any `run.X` is suspect.
      for (const field of BLACKLIST_FIELDS) {
        const fieldRe = new RegExp(`\\brun\\.${field}\\b`)
        if (fieldRe.test(body)) {
          violations.push({
            file: entry.file,
            line: text.slice(0, m.index).split(/\r?\n/).length,
            kind: 'helper_body_run_fallback',
            detail: `helper ${helper.name} references run.${field} — projection-named helpers may not smuggle fallback`,
          })
        }
      }
    }
  }
}

function main() {
  const violations = []
  for (const rel of SCAN_FILES) scanFile(rel, violations)
  scanHelperBodies(violations)

  if (violations.length === 0) {
    console.log('check-task-card-projection-only: ok')
    return
  }
  console.error('check-task-card-projection-only: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
