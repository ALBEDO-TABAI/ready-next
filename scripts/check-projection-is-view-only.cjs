#!/usr/bin/env node
/**
 * Stage 6 L3 gate. Asserts that projection-side modules read from the ledger
 * (`SkillTaskRunRepository`) but never call its write entry points, and that
 * the ledger repository file does not import from any projection module.
 *
 * Projection-side files (read-only against the ledger):
 *   - src/main/modules/agent-control/task-projection/run-projection.ts
 *   - src/main/modules/agent-control/task-projection/task-projection-sync.ts
 *   - src/main/modules/repositories/task-projection-repository.ts
 *   - src/main/modules/agent-control/skills/skill-running-projection.ts
 *
 * Forbidden call expressions in those files (depth-1 method calls on any
 * variable, regex-checked):
 *   - `.createChildRun(`
 *   - `.updateChildRun(`
 *   - `.updateRowSync(`
 *   - `.update(` *only* if the receiver imports `SkillTaskRunRepository`;
 *     a `taskProjectionStore.update(...)` call is fine because the projection
 *     module owns its own table.
 *
 * Implementation: scan each projection file. If it imports `SkillTaskRunRepository`
 * or `skill-task-run-repository`, any forbidden method call on a same-file
 * variable typed as that repo is a violation. We use a coarser proxy: forbid
 * the import altogether for projection files (they don't need it).
 *
 * Inverse: `src/main/modules/repositories/skill-task-run-repository.ts` may
 * not import from any `task-projection-*` module.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const PROJECTION_FILES = [
  'src/main/modules/agent-control/task-projection/run-projection.ts',
  'src/main/modules/agent-control/task-projection/task-projection-sync.ts',
  'src/main/modules/repositories/task-projection-repository.ts',
  'src/main/modules/agent-control/skills/skill-running-projection.ts',
]
const LEDGER_FILE = 'src/main/modules/repositories/skill-task-run-repository.ts'

const FORBIDDEN_LEDGER_METHODS = ['createChildRun', 'updateChildRun', 'updateRowSync']

function lineOf(text, idx) {
  return text.slice(0, idx).split(/\r?\n/).length
}

function main() {
  const violations = []

  // Rule (1): projection files must not import SkillTaskRunRepository
  // (they may import from `skill-task-run-repository` only for *type* imports)
  for (const rel of PROJECTION_FILES) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) {
      violations.push({ file: rel, line: 0, kind: 'projection_file_missing', detail: 'projection file does not exist' })
      continue
    }
    const text = fs.readFileSync(abs, 'utf8')

    // Forbid value imports of SkillTaskRunRepository.
    const valueImportRe = /^\s*import\s+(?!type\b)([^;]+?)\s+from\s+['"]([^'"]+skill-task-run-repository[^'"]*)['"]/gm
    let m
    while ((m = valueImportRe.exec(text))) {
      const importBody = m[1]
      // Allow `import type` (already excluded above) or `import { type X }` mixed
      const allTypeOnly = importBody
        .replace(/^[\s{]*|[\s}]*$/g, '')
        .split(',')
        .map((s) => s.trim())
        .every((s) => s.startsWith('type '))
      if (!allTypeOnly) {
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          kind: 'projection_imports_ledger_value',
          detail: 'projection file value-imports skill-task-run-repository — read via type-only or remove',
        })
      }
    }

    // Forbid forbidden method calls (defense in depth).
    for (const method of FORBIDDEN_LEDGER_METHODS) {
      const callRe = new RegExp(`\\.${method}\\s*\\(`, 'g')
      while ((m = callRe.exec(text))) {
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          kind: 'projection_calls_ledger_writer',
          detail: `forbidden ledger writer call .${method}(`,
        })
      }
    }
  }

  // Rule (2): ledger file may not import from any task-projection-* module
  const ledgerAbs = path.join(ROOT, LEDGER_FILE)
  if (fs.existsSync(ledgerAbs)) {
    const text = fs.readFileSync(ledgerAbs, 'utf8')
    const re = /\bfrom\s+['"]([^'"]*task-projection-[^'"]*)['"]/g
    let m
    while ((m = re.exec(text))) {
      // Only flag value imports; type imports are OK
      const lineStart = text.lastIndexOf('\n', m.index) + 1
      const lineText = text.slice(lineStart, m.index)
      if (!/import\s+type\b/.test(lineText)) {
        violations.push({
          file: LEDGER_FILE,
          line: lineOf(text, m.index),
          kind: 'ledger_imports_projection',
          detail: `ledger value-imports projection module ${m[1]}`,
        })
      }
    }
  }

  if (violations.length === 0) {
    console.log('check-projection-is-view-only: ok')
    return
  }
  console.error('check-projection-is-view-only: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
