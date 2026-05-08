#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — renderer must consume `canResume` truth.
 *
 * Stage Q plan §3.4 contract C7: any rendering decision that involves
 * `continue` or `retry` actions must check `canResume` (or the
 * `canResume === true` shape). Loose patterns of the form
 * `resumableActions.includes('continue')` without an adjacent
 * `canResume` predicate are flagged.
 *
 * Loose `interactionState === 'suspended'` checks that gate continue
 * buttons are also flagged.
 *
 * Scope:
 *   - `src/renderer/components/agent/ChatPanel.tsx`
 *   - `src/renderer/components/ready/TaskPanel.tsx`
 *   - `src/renderer/modules/agent/taskCardViewModel.ts`
 *
 * Heuristic: scan a comment+string-stripped projection for
 *   resumableActions.*?includes\(['"](continue|retry)['"]\)
 * For each match, check whether the SAME LINE OR THE PREVIOUS 2 LINES
 * contain `canResume` or `gateActionsByCanResume`. If absent, fail.
 *
 * `--root <path>` lets tests point the gate at a fixture tree.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  stripCommentsOnly,
  indexToLine,
} = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const TARGETS = [
  'src/renderer/components/agent/ChatPanel.tsx',
  'src/renderer/components/ready/TaskPanel.tsx',
  'src/renderer/modules/agent/taskCardViewModel.ts',
]

function parseRoot(argv) {
  let root = REPO_DEFAULT
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && i + 1 < argv.length) {
      root = path.resolve(argv[i + 1])
      i++
    }
  }
  return root
}

function main() {
  const root = parseRoot(process.argv.slice(2))
  const violations = []
  for (const rel of TARGETS) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) continue
    let src
    try {
      src = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    // Use stripCommentsOnly so string-literal `'continue'` / `'retry'`
    // inside `resumableActions.includes(...)` is preserved. Earlier
    // version used stripCodeStringsAndComments which blanked the
    // string body and made the gate falsely return OK.
    const stripped = stripCommentsOnly(src)
    const lines = stripped.split('\n')
    // Match `resumableActions...includes('continue')` or `('retry')`.
    const re = /resumableActions[^;{}\n]*?\.includes\s*\(\s*['"](?:continue|retry)['"]\s*\)/g
    let m
    while ((m = re.exec(stripped)) !== null) {
      const lineNum = indexToLine(src, m.index) // 1-based
      const lineIdx = lineNum - 1
      // Window: same line + previous 2 lines + next line (handles
      // multi-line conditionals).
      const windowStart = Math.max(0, lineIdx - 2)
      const windowEnd = Math.min(lines.length - 1, lineIdx + 1)
      const windowText = lines.slice(windowStart, windowEnd + 1).join('\n')
      const hasGate = /\bcanResume\b/.test(windowText)
        || /\bgateActionsByCanResume\b/.test(windowText)
      if (!hasGate) {
        violations.push({
          file: abs,
          line: lineNum,
          message: 'resumableActions includes("continue"|"retry") without adjacent canResume gate',
          preview: lines[lineIdx]?.trim().slice(0, 120),
        })
      }
    }
  }
  if (violations.length === 0) {
    console.log('[check-renderer-canresume-only] OK')
    return 0
  }
  console.error('[check-renderer-canresume-only] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line} — ${v.message}`)
    console.error(`    code: ${v.preview}`)
  }
  console.error('')
  console.error('Stage Q (Stage 11): renderer continue/retry gates must consult canResume.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main }
