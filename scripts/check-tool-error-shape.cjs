#!/usr/bin/env node
/**
 * Stage U PR U1.1 — tool error shape mutual-exclusivity gate.
 *
 * AGENTS.md §3 requires:
 *   - `tool_not_registered` — tool does not exist (registry signal)
 *   - `authorization_denied` — tool exists but not authorized this turn
 *                              (skill_* admission signal)
 *   - These two errorKinds are MUTUALLY EXCLUSIVE.
 *
 * Before Stage U1.1, `tool_not_registered` was nested under
 * `errorKind: 'host_unavailable'` as a `reason` field, conflating
 * "infra unavailable" with "fabricated tool name". This gate forbids
 * the legacy nested shape from being reintroduced.
 *
 * Forbidden:
 *   Any object literal where `errorKind: 'host_unavailable'` and
 *   `reason: 'tool_not_registered'` co-occur on the same data object.
 *
 * Whitelist: this gate, tool-executor-contract test (it documents the
 * historical shape in a comment block).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOTS = ['src/main', 'src/preload', 'src/renderer', 'src/shared']
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs'])

const FILE_ALLOWLIST = [
  /^scripts\/check-tool-error-shape\.cjs$/,
  /^src\/__tests__\//, // test fixtures may reference historical shape in comments
  /^docs\//,
]

function isAllowed(rel) {
  return FILE_ALLOWLIST.some((rx) => rx.test(rel))
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__tests__') continue
      yield* walk(full)
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      yield full
    }
  }
}

/**
 * Detect the legacy nested shape on the same data object. We look for
 * `errorKind: 'host_unavailable'` followed within 200 chars (typical
 * object literal span) by `reason: 'tool_not_registered'`, ignoring
 * surrounding whitespace and intervening fields.
 */
const LEGACY_NESTED_SHAPE = /errorKind:\s*['"]host_unavailable['"][\s\S]{0,200}?reason:\s*['"]tool_not_registered['"]/

/**
 * Strip line comments and block comments before scanning so the gate
 * doesn't flag historical-shape mentions in docstrings.
 */
function stripComments(source) {
  // Block comments first.
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  // Then line comments (preserve URL `://`).
  return noBlock.replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function checkToolErrorShape() {
  const violations = []
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root)
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full)
      if (isAllowed(rel)) continue
      const raw = fs.readFileSync(full, 'utf8')
      const source = stripComments(raw)
      if (LEGACY_NESTED_SHAPE.test(source)) {
        // Re-locate the offending region in the original source for nicer reporting.
        const match = raw.match(LEGACY_NESTED_SHAPE)
        const line = match ? raw.slice(0, match.index || 0).split('\n').length : 0
        violations.push({
          file: rel,
          line,
          code: match ? match[0].slice(0, 160).replace(/\n/g, ' ') : '(stripped from comments)',
        })
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkToolErrorShape()
  if (ok) { console.log('[check-tool-error-shape] OK'); return 0 }
  console.error('[check-tool-error-shape] FAIL — `errorKind: \'host_unavailable\'` + `reason: \'tool_not_registered\'` co-occurrence retired in Stage U1.1.')
  console.error('  Use top-level `errorKind: \'tool_not_registered\'` instead (AGENTS.md §3 mutual exclusivity).')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkToolErrorShape }
