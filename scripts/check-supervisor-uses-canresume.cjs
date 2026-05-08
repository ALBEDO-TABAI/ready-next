#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — supervisor durable-handle judgments must use
 * `canResumeShape`, not custom `outputDir || runStatePath || taskRunId`
 * style boolean expressions.
 *
 * Stage Q audit ➕4 found that supervisor's two durable judgments
 * (`snapshotHasDurableHandle` and `hasDurableResumeHandle`) were
 * scoring any non-null resumePayload OR taskRunId as durable, so empty
 * shells dominated `scoreLatestSnapshot`. PR-3 unifies them via
 * `canResumeShape` from `resume-handle.ts`. This gate ensures both
 * functions stay routed through the helper.
 *
 * `--root <path>` lets tests point the gate at a fixture tree.
 *
 * Exit 0 on clean; exit 1 with violations otherwise.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  stripCodeStringsAndComments,
  indexToLine,
} = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')

function findFunctionBody(src, functionName) {
  // Robust enough for production code: locate `function NAME(` or
  // `const NAME = (` opener in the comment/string-stripped projection,
  // then walk braces to find the matching close. Returns {start, end}
  // covering the body (between `{` and matching `}`), or null if not
  // found. Bounded scan: only the first definition is examined.
  const stripped = stripCodeStringsAndComments(src)
  const candidates = [
    new RegExp(`\\bfunction\\s+${functionName}\\s*\\([^)]*\\)\\s*[^{]*\\{`),
    new RegExp(`\\bconst\\s+${functionName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{`),
  ]
  for (const re of candidates) {
    const m = re.exec(stripped)
    if (!m) continue
    const open = stripped.indexOf('{', m.index + m[0].length - 1)
    if (open < 0) continue
    let depth = 0
    for (let i = open; i < stripped.length; i++) {
      const ch = stripped[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          return { src, stripped, start: open, end: i + 1 }
        }
      }
    }
  }
  return null
}

function main() {
  const args = process.argv.slice(2)
  let root = REPO_DEFAULT
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      root = path.resolve(args[i + 1])
      i++
    }
  }
  const filePath = path.join(root, 'src/main/modules/agent-control/skill-task-supervisor.ts')
  if (!fs.existsSync(filePath)) {
    console.log('[check-supervisor-uses-canresume] OK (supervisor file absent)')
    return 0
  }
  let src
  try {
    src = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    console.error(`[check-supervisor-uses-canresume] cannot read ${filePath}: ${error}`)
    return 1
  }

  const violations = []

  // Both durable-handle judgments must reference canResumeShape inside
  // their bodies. Function `snapshotHasDurableHandle` is a top-level
  // declaration; `hasDurableResumeHandle` is a const inside
  // `inspectSkillTask`, so we scan the whole file for that name.
  const stripped = stripCodeStringsAndComments(src)

  // (1) snapshotHasDurableHandle body must call canResumeShape.
  const fn1 = findFunctionBody(src, 'snapshotHasDurableHandle')
  if (!fn1) {
    violations.push('snapshotHasDurableHandle function body not found in supervisor')
  } else {
    const body = fn1.stripped.slice(fn1.start, fn1.end)
    if (!/\bcanResumeShape\s*\(/.test(body)) {
      violations.push(
        `snapshotHasDurableHandle does not call canResumeShape\n  ${path.relative(root, filePath)}:${indexToLine(src, fn1.start)}`,
      )
    }
  }

  // (2) `const hasDurableResumeHandle = ...` RHS must call canResumeShape.
  // We use brace/paren balance instead of `... \nconst` regex so future
  // RHS shapes (multi-line object expressions, nested calls) don't break
  // the gate.
  const declMatch = /\bconst\s+hasDurableResumeHandle\s*=\s*/.exec(stripped)
  if (!declMatch) {
    violations.push('hasDurableResumeHandle const assignment not located')
  } else {
    const rhsStart = declMatch.index + declMatch[0].length
    let depth = 0
    let end = -1
    for (let i = rhsStart; i < stripped.length; i++) {
      const ch = stripped[i]
      if (ch === '(' || ch === '{' || ch === '[') depth += 1
      else if (ch === ')' || ch === '}' || ch === ']') depth -= 1
      else if (depth === 0 && (ch === '\n' || ch === ';')) {
        // RHS ends at first newline/semicolon at top level.
        end = i
        break
      }
    }
    const rhs = end > rhsStart ? stripped.slice(rhsStart, end) : stripped.slice(rhsStart)
    if (!/\bcanResumeShape\s*\(/.test(rhs)) {
      violations.push(
        `hasDurableResumeHandle RHS does not call canResumeShape\n  ${path.relative(root, filePath)}:${indexToLine(src, declMatch.index)}`,
      )
    }
  }

  if (violations.length === 0) {
    console.log('[check-supervisor-uses-canresume] OK')
    return 0
  }
  console.error('[check-supervisor-uses-canresume] FAIL')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('Stage Q (Stage 11): supervisor durable-handle judgments must route through canResumeShape.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main }
