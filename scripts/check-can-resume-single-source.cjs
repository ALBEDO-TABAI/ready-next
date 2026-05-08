#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — single-source gate for `canResumeShape` /
 * `canResumeWithFs` exports.
 *
 * Stage Q audit §2 found 5 layers each defining "is this resumable?"
 * differently. The Stage Q implementation plan §3.1 introduces one
 * helper file (`src/main/modules/agent-control/resume-handle.ts`)
 * that exports both forms. This gate enforces the helper is
 * declared exactly once.
 *
 * Evasion paths the gate explicitly covers (Codex review round 3):
 *   - `export function NAME` / `export const NAME` / `export let NAME` / `export var NAME`
 *   - `export default function NAME` / `export default NAME`
 *   - single-line `export { NAME, ... }` and multi-line `export {\n  NAME,\n  ...\n}`
 *   - `export { NAME, ... } from '...'` re-exports
 * Comments are stripped before matching so prose mentioning the helper
 * does not false-positive.
 *
 * Documented residual risk (accepted): string concatenation of identifier
 * names (e.g. `export[' ' + 'function canResumeShape']`). The gate does
 * not solve runtime obfuscation; the static surface is enough for a
 * cooperative repo. AST-based hardening would replace this if needed.
 *
 * Exit 0 on clean; exit 1 with violations otherwise.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { stripCodeStringsAndComments, indexToLine } = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const NAMES = ['canResumeShape', 'canResumeWithFs']

function buildPatterns(name) {
  // Whole-file `s` (dotAll) matchers so we can span multi-line constructs.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    // export function|const|let|var NAME
    new RegExp(`\\bexport\\s+(?:default\\s+)?(?:function|const|let|var|async\\s+function)\\s+${escaped}\\b`, 'g'),
    // export default NAME (no function/const keyword between)
    new RegExp(`\\bexport\\s+default\\s+${escaped}\\b`, 'g'),
    // export { ... NAME ... } (single or multi-line; with optional `from '...'`)
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`, 'gs'),
  ]
}

function listFiles(dir, exts = ['.ts', '.tsx']) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        stack.push(full)
      } else if (exts.includes(path.extname(entry.name))) {
        out.push(full)
      }
    }
  }
  return out
}

function scanForExports(root = REPO_DEFAULT) {
  const scanDir = path.join(root, 'src')
  const matches = Object.fromEntries(NAMES.map((n) => [n, []]))
  for (const file of listFiles(scanDir)) {
    let src
    try {
      src = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const stripped = stripCodeStringsAndComments(src)
    for (const name of NAMES) {
      const seen = new Set()
      for (const regex of buildPatterns(name)) {
        let m
        while ((m = regex.exec(stripped)) !== null) {
          if (seen.has(m.index)) continue
          seen.add(m.index)
          matches[name].push({
            file,
            line: indexToLine(src, m.index),
            preview: m[0].slice(0, 120).replace(/\s+/g, ' ').trim(),
          })
        }
      }
    }
  }
  return matches
}

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
  const matches = scanForExports(root)
  const violations = []
  for (const name of NAMES) {
    if (matches[name].length === 0) {
      violations.push(`No export for ${name} found in src/`)
    } else if (matches[name].length > 1) {
      violations.push(
        `Multiple exports of ${name} found:\n`
          + matches[name].map((m) => `  ${path.relative(root, m.file)}:${m.line} — ${m.preview}`).join('\n'),
      )
    }
  }
  if (violations.length === 0) {
    console.log('[check-can-resume-single-source] OK')
    return 0
  }
  console.error('[check-can-resume-single-source] FAIL')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('Stage Q (Stage 11): canResumeShape / canResumeWithFs must be exported exactly once.')
  console.error('Helper lives in src/main/modules/agent-control/resume-handle.ts.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main, scanForExports }
