#!/usr/bin/env node
/**
 * Stage U PR U8.0 — `skill_executions` resurrection gate (C-3).
 *
 * Stage 4 retired the `skill_executions` table, its state machine, the
 * `skill:execution:*` IPC channel, and the `workflow-coordinator` path.
 * CLAUDE.md §3 forbids reviving any of them. This gate refuses any new
 * occurrence of the resurrection patterns below in active source / scripts
 * / current architecture docs.
 *
 * Forbidden patterns (resurrection vectors, not mere mentions):
 *   1. Active SQL DDL/DML against `skill_executions` —
 *      `CREATE TABLE [IF NOT EXISTS] skill_executions`,
 *      `INSERT INTO skill_executions`, `UPDATE skill_executions`,
 *      `FROM skill_executions`, `JOIN skill_executions`,
 *      `REFERENCES skill_executions`. `DROP TABLE/INDEX` is allowed
 *      (retirement migrations must keep dropping).
 *   2. `class SkillExecutionState` / `interface SkillExecutionState`
 *      (and the `…Workflow` variant) — the retired state machine types.
 *   3. `skill:execution:*` IPC channel literal.
 *   4. `workflow-coordinator` path / import specifier.
 *
 * Scan roots: `src/`, `scripts/`, `docs/architecture/`. Historical
 * retirement docs and the surviving migration ledger keep the symbols
 * intentionally — they are listed in `FILE_ALLOWLIST` below.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOTS = ['src', 'scripts', 'docs/architecture']
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs', '.json', '.md', '.sql'])

// Files allowed to keep the literal symbols. Retirement migrations must
// keep dropping the table; historical plans / lessons document the
// retirement itself. The gate's own file and the absence-assertion test
// are self-exempt.
const FILE_ALLOWLIST = [
  /^scripts\/check-no-skill-executions-resurrection\.cjs$/,
  /^scripts\/__tests__\/check-no-skill-executions-resurrection\.test\.cjs$/,
  /^src\/main\/modules\/migrations\.ts$/, // 018 history + 028 + 029 retirement
  /^src\/__tests__\/skill-execution-api-removed\.test\.ts$/,
  /^src\/__tests__\/migrations-drop-skill-executions\.test\.ts$/,
  /^src\/__tests__\/skill-task-projection-contract\.test\.ts$/, // asserts workflow-coordinator helpers are gone
  /^LESSONS_LEARNED\.md$/,
  /^docs\/superpowers\/plans\/2026-04-23-/,
  /^docs\/superpowers\/plans\/2026-04-29-/,
  /^docs\/superpowers\/plans\/2026-05-07-P-/,
]

const PATTERNS = [
  { name: 'CREATE TABLE skill_executions', regex: /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+skill_executions\b/i },
  { name: 'INSERT INTO skill_executions', regex: /INSERT\s+INTO\s+skill_executions\b/i },
  { name: 'UPDATE skill_executions', regex: /UPDATE\s+skill_executions\b/i },
  { name: 'FROM skill_executions', regex: /\bFROM\s+skill_executions\b/i },
  { name: 'JOIN skill_executions', regex: /\bJOIN\s+skill_executions\b/i },
  { name: 'REFERENCES skill_executions', regex: /\bREFERENCES\s+skill_executions\b/i },
  { name: 'class SkillExecutionState', regex: /\b(?:class|interface|type)\s+SkillExecutionState\b/ },
  { name: 'class SkillExecutionWorkflow', regex: /\b(?:class|interface|type)\s+SkillExecutionWorkflow\b/ },
  { name: 'skill:execution: IPC channel', regex: /['"`]skill:execution:[A-Za-z0-9_-]*['"`]/ },
  { name: 'workflow-coordinator path', regex: /workflow-coordinator/ },
]

function listFiles(rootDir) {
  const out = []
  const stack = [rootDir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile() && SCAN_EXT.has(path.extname(ent.name))) out.push(p)
    }
  }
  return out
}

function relposix(root, p) { return path.relative(root, p).split(path.sep).join('/') }

function checkNoSkillExecutionsResurrection({ root = REPO } = {}) {
  const violations = []
  for (const rel of SCAN_ROOTS) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) continue
    for (const file of listFiles(abs)) {
      const relPath = relposix(root, file)
      if (FILE_ALLOWLIST.some((re) => re.test(relPath))) continue
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        for (const { name, regex } of PATTERNS) {
          if (regex.test(lines[i])) violations.push({ file: relPath, line: i + 1, pattern: name, code: lines[i].trim() })
        }
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkNoSkillExecutionsResurrection()
  if (ok) { console.log('[check-no-skill-executions-resurrection] OK'); return 0 }
  console.error('[check-no-skill-executions-resurrection] FAIL — skill_executions state machine is retired (CLAUDE.md §3).')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkNoSkillExecutionsResurrection }
