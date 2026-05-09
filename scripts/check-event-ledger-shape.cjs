#!/usr/bin/env node
/**
 * Stage T (W9.1) gate — Worker Event Ledger shape contract.
 *
 * Three-part check pinned by plan v18 §4.3:
 *
 *   (A) `skill-child-run-types.ts` defines `SkillChildRunEvent` carrying
 *       the four ledger fields: `event_kind`, `ts`, `terminal_reason?`,
 *       and `rollback_target?: string | null` (Codex round 11/12 — must
 *       allow `null` not just `undefined`).
 *
 *   (B) `skill-child-runner.ts` callers of `appendChildRunEvent` (or its
 *       internal `appendEvent` wrapper) — at least one terminal call
 *       site — fill `event_kind`, `terminal_reason`, and on the cancel
 *       branch, `rollback_target`. The cancel branch must be statically
 *       discoverable by the literal `cancelled` (or `cancel`).
 *
 *   (C) `skill-child-runner.ts` references `lastSafeStepId` so cancel
 *       terminal events have a defined source for `rollback_target`.
 *
 * Removing any of the three breaks the W9.1 contract.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TYPES_FILE = path.join(
  ROOT,
  'src/main/modules/agent-control/skill-child-run-types.ts',
)
const RUNNER_FILE = path.join(
  ROOT,
  'src/main/modules/agent-control/skill-child-runner.ts',
)

function fail(violations) {
  console.error('check-event-ledger-shape: violations:')
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  process.exit(1)
}

/**
 * Walk the source and pull out the bodies of every
 * `append(ChildRun)?Event(...)` call. Uses a paren-balanced cursor so
 * nested `result: { ... }` objects do not break the extraction.
 *
 * Returns an array of strings — each string is the bracketed argument
 * list (without the outer parens).
 */
function extractAppendEventCallBlocks(text) {
  const blocks = []
  // Match the call name + opening paren at any spot.
  const callPattern = /\bappend(?:ChildRun)?Event\s*\(/g
  let match
  while ((match = callPattern.exec(text)) !== null) {
    const openIdx = match.index + match[0].length - 1 // index of `(`
    // Walk the source forward, tracking paren depth.
    let depth = 1
    let i = openIdx + 1
    let inSingle = false
    let inDouble = false
    let inBacktick = false
    let inLineComment = false
    let inBlockComment = false
    while (i < text.length && depth > 0) {
      const ch = text[i]
      const next = text[i + 1]
      if (inLineComment) {
        if (ch === '\n') inLineComment = false
        i++
        continue
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false
          i += 2
          continue
        }
        i++
        continue
      }
      if (inSingle) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === "'") inSingle = false
        i++
        continue
      }
      if (inDouble) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === '"') inDouble = false
        i++
        continue
      }
      if (inBacktick) {
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === '`') inBacktick = false
        i++
        continue
      }
      if (ch === '/' && next === '/') {
        inLineComment = true
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true
        i += 2
        continue
      }
      if (ch === "'") {
        inSingle = true
        i++
        continue
      }
      if (ch === '"') {
        inDouble = true
        i++
        continue
      }
      if (ch === '`') {
        inBacktick = true
        i++
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    if (depth === 0) {
      blocks.push(text.slice(openIdx + 1, i - 1))
    }
  }
  return blocks
}

function main() {
  const violations = []

  if (!fs.existsSync(TYPES_FILE)) {
    fail([`missing file: ${TYPES_FILE}`])
  }
  const typesText = fs.readFileSync(TYPES_FILE, 'utf8')

  // (A) shape contract — SkillChildRunEvent type must surface all four
  // ledger fields, and `rollback_target` must allow `null`.
  if (!/\bexport\s+type\s+SkillChildRunEvent\b/.test(typesText)) {
    violations.push(
      'skill-child-run-types.ts: `export type SkillChildRunEvent` not found',
    )
  }
  if (!/\bevent_kind\b/.test(typesText)) {
    violations.push(
      'skill-child-run-types.ts: missing `event_kind` field on SkillChildRunEvent',
    )
  }
  if (!/(^|\W)ts\??\s*:\s*number\b/m.test(typesText)) {
    violations.push(
      'skill-child-run-types.ts: missing `ts: number` field on SkillChildRunEvent',
    )
  }
  if (!/\bterminal_reason\??\s*:/.test(typesText)) {
    violations.push(
      'skill-child-run-types.ts: missing `terminal_reason` field on SkillChildRunEvent',
    )
  }
  // Codex round 11/12 — must allow null not just undefined.
  if (!/\brollback_target\??\s*:\s*string\s*\|\s*null\b/.test(typesText)) {
    violations.push(
      'skill-child-run-types.ts: `rollback_target` must be typed `string | null` (round 11/12)',
    )
  }

  if (!fs.existsSync(RUNNER_FILE)) {
    fail([...violations, `missing file: ${RUNNER_FILE}`])
  }
  const runnerText = fs.readFileSync(RUNNER_FILE, 'utf8')

  // (B) caller contract — extract each `append(ChildRun)?Event(...)` call
  // by walking the source from each open paren to the balanced closing
  // paren. Then check that at least one such call:
  //   - sets `event_kind:`,
  //   - sets `terminal_reason:`,
  //   - sets `rollback_target:` on a block also containing the literal
  //     `cancel` / `cancelled` (statically discoverable cancel branch).
  const callBlocks = extractAppendEventCallBlocks(runnerText)
  if (callBlocks.length === 0) {
    violations.push(
      'skill-child-runner.ts: could not locate any append*Event(...) call site',
    )
  } else {
    let sawEventKind = false
    let sawTerminalReason = false
    let sawRollbackTargetWithCancel = false
    for (const block of callBlocks) {
      if (/\bevent_kind\s*:/.test(block)) sawEventKind = true
      if (/\bterminal_reason\s*:/.test(block)) sawTerminalReason = true
      if (
        /\brollback_target\s*:/.test(block) &&
        /\bcancel(?:led)?\b/i.test(block)
      ) {
        sawRollbackTargetWithCancel = true
      }
    }
    if (!sawEventKind) {
      violations.push(
        'skill-child-runner.ts: no append*Event call site sets `event_kind`',
      )
    }
    if (!sawTerminalReason) {
      violations.push(
        'skill-child-runner.ts: no append*Event ledger call site sets `terminal_reason`',
      )
    }
    if (!sawRollbackTargetWithCancel) {
      violations.push(
        'skill-child-runner.ts: no append*Event ledger call site sets `rollback_target` on a cancel-branch (literal `cancelled`/`cancel` must appear in the same block)',
      )
    }
  }

  // (C) lastSafeStepId reference — runner must record the safe step id
  // somewhere (field declaration + at least one update site).
  const lastSafeStepIdMatches =
    runnerText.match(/\blastSafeStepId\b/g) || []
  if (lastSafeStepIdMatches.length < 2) {
    violations.push(
      'skill-child-runner.ts: `lastSafeStepId` must be declared and updated (≥2 references)',
    )
  }

  if (violations.length > 0) fail(violations)
  console.log('check-event-ledger-shape: ok')
}

main()
