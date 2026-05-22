#!/usr/bin/env node
/**
 * Stage 10 (P) — `'not_set'` authorization shortcut retirement gate.
 *
 * Plan §3.8.1. Once Stage 10 lands, the `SkillToolAuthorization` reason
 * union no longer contains `'not_set'` and the
 * `SKILL_TOOL_AUTHORIZATION_NOT_SET` constant is gone. Comments must
 * also stop referencing the retired sentinel — the gate scans raw text
 * (no comment-stripping) so future contributors cannot reintroduce the
 * vocabulary by talking about "the legacy 'not_set' shortcut".
 *
 * Scope:
 *   1. Repo-wide under `src/main/modules/`:
 *        - forbid string literal `'not_set'` / `"not_set"` (raw, including
 *          comments — no whitelist)
 *        - forbid identifier `SKILL_TOOL_AUTHORIZATION_NOT_SET`
 *   2. `src/main/modules/agent-control/skills/skill-tool-authorization.ts`:
 *        - forbid `=== 'not_set'` / `!== 'not_set'`
 *        - forbid `'not_set'` literal anywhere in the reason union
 *
 * Self-exemption: this script's own `__filename` is excluded from the
 * scan (the gate's purpose is to detect the patterns it spells out).
 *
 * Exit 0 on clean; exit 1 with `file:line — pattern matched` otherwise.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_DIR = path.join(REPO, 'src/main/modules')
const AUTH_FILE = path.join(
  REPO,
  'src/main/modules/agent-control/skills/skill-tool-authorization.ts',
)

// Patterns that fail anywhere in `src/main/modules/`.
const REPO_PATTERNS = [
  { name: "'not_set' literal", regex: /['"]not_set['"]/ },
  {
    name: 'SKILL_TOOL_AUTHORIZATION_NOT_SET identifier',
    regex: /SKILL_TOOL_AUTHORIZATION_NOT_SET/,
  },
]

// Extra patterns that fail only in `skill-tool-authorization.ts`.
const AUTH_FILE_PATTERNS = [
  { name: "=== 'not_set' equality check", regex: /===\s*['"]not_set['"]/ },
  { name: "!== 'not_set' equality check", regex: /!==\s*['"]not_set['"]/ },
]

function listFiles(dir, exts = ['.ts', '.tsx', '.cjs', '.mjs', '.js']) {
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
        stack.push(full)
      } else if (exts.includes(path.extname(entry.name))) {
        out.push(full)
      }
    }
  }
  return out
}

function scanFile(file, patterns) {
  const violations = []
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch {
    return violations
  }
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { name, regex } of patterns) {
      if (regex.test(line)) {
        violations.push({
          file,
          line: i + 1,
          pattern: name,
          code: line.trim(),
        })
      }
    }
  }
  return violations
}

function checkNoNotSetAuthorization({ root = REPO } = {}) {
  const scanDir = path.join(root, 'src/main/modules')
  const authFile = path.join(
    root,
    'src/main/modules/agent-control/skills/skill-tool-authorization.ts',
  )
  const violations = []
  for (const file of listFiles(scanDir)) {
    // Self-exempt this gate's own source file (auxiliary copies, if any
    // landed under src/main/modules, would still be scanned).
    if (path.resolve(file) === path.resolve(__filename)) continue
    violations.push(...scanFile(file, REPO_PATTERNS))
  }
  if (fs.existsSync(authFile)) {
    violations.push(...scanFile(authFile, AUTH_FILE_PATTERNS))
  }
  return { violations }
}

function main() {
  const args = process.argv.slice(2)
  let root = REPO
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      root = path.resolve(args[i + 1])
      i++
    }
  }

  const { violations } = checkNoNotSetAuthorization({ root })
  if (violations.length === 0) {
    console.log('[check-no-not-set-authorization] OK')
    return 0
  }

  console.error('[check-no-not-set-authorization] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.code}`)
  }
  console.error('')
  console.error("Stage 10 (P): the back-compat 'not_set' authorization shortcut is retired.")
  console.error('Comments and code must not reference the legacy sentinel.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { checkNoNotSetAuthorization }
