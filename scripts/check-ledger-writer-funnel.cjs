#!/usr/bin/env node
/**
 * Stage 6 L1 gate. Asserts that `skill_task_runs.status` is mutated only via
 * the three sanctioned `SkillTaskRunRepository` entry points:
 *
 *   - `createChildRun(...)` — INSERT
 *   - `updateChildRun(...)` — payload-driven status update
 *   - `updateRowSync(...)`  — tracker-driven status update (whitelisted callers)
 *
 * Public `update(id, patch)` cannot mutate status (TS narrows the patch shape;
 * a runtime guard catches dynamic abuse). The L1 gate proves the contract by
 * forbidding *any other* path:
 *
 *   (1) No file outside `skill-task-run-repository.ts` may contain a SQL
 *       `UPDATE skill_task_runs SET ...` statement.
 *   (2) The single sanctioned `db.prepare(\`UPDATE skill_task_runs SET ...\`)`
 *       call lives inside `updateRowInternal(...)` in the repo file.
 *   (3) `repository.updateRowSync(...)` is called only from
 *       `skill-task-tracker.ts` (and the repo file itself, e.g. `updateChildRun`).
 *       Other callers must use `update()` (which forbids status) or
 *       `updateChildRun()` (payload-driven).
 *   (4) No file (other than the repo file or the close-event freeze helper)
 *       contains the literal string `'UPDATE skill_task_runs'` in any form.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REPO_REL = 'src/main/modules/repositories/skill-task-run-repository.ts'
const TRACKER_REL = 'src/main/modules/agent-control/skill-task-tracker.ts'
const SCAN_DIRS = ['src/main/modules/']

function listFiles(dirAbs) {
  const out = []
  const stack = [dirAbs]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        stack.push(p)
      } else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx'))) {
        out.push(p)
      }
    }
  }
  return out
}

function relposix(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

function main() {
  const violations = []

  // Rules (1), (4): forbid SQL `UPDATE skill_task_runs` outside repo file.
  for (const dirRel of SCAN_DIRS) {
    const dir = path.join(ROOT, dirRel)
    if (!fs.existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      const rel = relposix(file)
      if (rel === REPO_REL) continue
      if (rel.includes('/__tests__/')) continue
      const text = fs.readFileSync(file, 'utf8')
      const reSql = /UPDATE\s+skill_task_runs\b/g
      let m
      while ((m = reSql.exec(text))) {
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          kind: 'illegal_update_sql',
          detail: 'direct UPDATE skill_task_runs SQL outside the repository file',
        })
      }
    }
  }

  // Rule (3): `updateRowSync(` callers — only repo file and tracker file allowed.
  for (const dirRel of SCAN_DIRS) {
    const dir = path.join(ROOT, dirRel)
    if (!fs.existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      const rel = relposix(file)
      if (rel === REPO_REL) continue
      if (rel === TRACKER_REL) continue
      if (rel.includes('/__tests__/')) continue
      const text = fs.readFileSync(file, 'utf8')
      const reCall = /\.updateRowSync\s*\(/g
      let m
      while ((m = reCall.exec(text))) {
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          kind: 'illegal_updaterowsync_caller',
          detail: 'updateRowSync may only be called from skill-task-tracker.ts',
        })
      }
    }
  }

  // Rule (2): repo file must contain the sanctioned single SQL call.
  if (!fs.existsSync(path.join(ROOT, REPO_REL))) {
    violations.push({ file: REPO_REL, line: 0, kind: 'repo_missing', detail: 'repository file does not exist' })
  } else {
    const repoText = fs.readFileSync(path.join(ROOT, REPO_REL), 'utf8')
    if (!/db\.prepare\(\s*`UPDATE\s+skill_task_runs\s+SET\s+\$\{setClause\}\s+WHERE\s+id\s*=\s*\?`\s*\)/.test(repoText)) {
      violations.push({ file: REPO_REL, line: 0, kind: 'sanctioned_sql_missing', detail: 'expected single UPDATE skill_task_runs SQL inside updateRowInternal not found' })
    }
    if (!/private\s+updateRowInternal\s*\(/.test(repoText)) {
      violations.push({ file: REPO_REL, line: 0, kind: 'private_writer_missing', detail: 'private updateRowInternal not found in repository file' })
    }
  }

  if (violations.length === 0) {
    console.log('check-ledger-writer-funnel: ok')
    return
  }
  console.error('check-ledger-writer-funnel: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
