#!/usr/bin/env node
/**
 * Stage 6 L6 gate.
 *
 * Asserts that the renderer's task-card data has a single canonical source
 * — the persisted `task_projections` IPC payload — and that any synthesis
 * from the `agent:listActiveChildRuns` debug/control feed is (a) named as a
 * debug path, (b) blocked from the primary visible card list when a
 * projection already covers the same child run, and (c) physically routed
 * through the brand-protected `task-card-from-projection.ts` helper.
 *
 * Checks:
 *
 *   (1) The legacy synthesis function name `activeChildRunToTaskRun` does
 *       not appear anywhere under `src/renderer/`.
 *
 *   (2) The replacement function name `activeChildRunDebugRow` exists in at
 *       least one renderer file.
 *
 *   (3) The renamed function is preceded by a doc comment that includes the
 *       words "debug" and "control-only".
 *
 *   (4) Every renderer call to `activeChildRunDebugRow(` must be guarded by
 *       a projection-coverage check — concretely, the closest enclosing
 *       block (within ~10 lines above the call) must mention the symbol
 *       `projectionsCoverChildRunId` (the named guard helper).
 *
 *   (5) The `TASK_CARD_BRAND` constant must be declared in exactly one file:
 *       `src/renderer/components/agent/task-card-from-projection.ts`. The
 *       cast-bypass eslint rule (`ready/no-task-card-run-cast`) blocks
 *       runtime forgery of this brand from any other file.
 *
 * Stage 7 follow-up (NOT in this gate yet):
 *   - Add a `agent:taskProjectionsChanged` IPC event so the renderer can
 *     refresh projections without polling active-child-run summaries.
 *
 * Tracked in `.claude/stage6/plan-v9.md §2 Task 6`.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RENDERER_ROOT = 'src/renderer/'
const HELPER_REL = 'src/renderer/components/agent/task-card-from-projection.ts'

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
  const dir = path.join(ROOT, RENDERER_ROOT)
  if (!fs.existsSync(dir)) {
    console.log('check-task-card-single-source: ok (no renderer dir)')
    return
  }

  const legacyNameRe = /\bactiveChildRunToTaskRun\b/g
  const debugNameRe = /\bactiveChildRunDebugRow\b/g
  // Match call expressions only (followed by `(`).
  const debugCallRe = /\bactiveChildRunDebugRow\s*\(/g
  let debugNameSeen = false
  let debugDocOk = false

  for (const file of listFiles(dir)) {
    const rel = relposix(file)
    if (rel.includes('/__tests__/')) continue
    const text = fs.readFileSync(file, 'utf8')

    // Rule (1): legacy name forbidden
    let m
    while ((m = legacyNameRe.exec(text))) {
      violations.push({
        file: rel,
        line: lineOf(text, m.index),
        kind: 'legacy_synthesis_name',
        detail: 'symbol activeChildRunToTaskRun must be renamed to activeChildRunDebugRow',
      })
    }

    // Rule (2)+(3): debug name + doc comment
    // Detect: any reference to debug name. For *declarations* (function|const|let)
    // require the debug+control-only doc comment immediately preceding.
    while ((m = debugNameRe.exec(text))) {
      debugNameSeen = true
      const before = text.slice(0, m.index)
      // Check if this occurrence is a declaration (preceded by `function ` or `const `)
      const nearStart = before.slice(Math.max(0, before.length - 200)).toLowerCase()
      const isDeclaration = /\b(function|const|let|var|export\s+function)\s+$/.test(nearStart)
      if (isDeclaration) {
        const last30 = before.split(/\r?\n/).slice(-30).join('\n').toLowerCase()
        if (last30.includes('debug') && last30.includes('control-only')) {
          debugDocOk = true
        }
      }
    }

    // Rule (4): every CALL to activeChildRunDebugRow must be guarded by
    // a projectionsCoverChildRunId check within the preceding 10 lines.
    while ((m = debugCallRe.exec(text))) {
      const before = text.slice(0, m.index)
      const last10 = before.split(/\r?\n/).slice(-10).join('\n')
      if (!/projectionsCoverChildRunId\b/.test(last10)) {
        // Skip the declaration itself (declaration is followed by `(`-paren-`)`-arrow style)
        // We treat any call site that isn't preceded by `function ` keyword as a real call.
        const nearStart = before.slice(Math.max(0, before.length - 200))
        const isDeclSig = /\b(function|export\s+function)\s+$/.test(nearStart)
        if (!isDeclSig) {
          violations.push({
            file: rel,
            line: lineOf(text, m.index),
            kind: 'unguarded_debug_call',
            detail: 'activeChildRunDebugRow call must be preceded (within 10 lines) by projectionsCoverChildRunId(...) guard',
          })
        }
      }
    }

    // Rule (5): TASK_CARD_BRAND constant must live only in helper file.
    const brandRe = /\bTASK_CARD_BRAND\b/g
    let bm
    while ((bm = brandRe.exec(text))) {
      if (rel !== HELPER_REL) {
        violations.push({
          file: rel,
          line: lineOf(text, bm.index),
          kind: 'task_card_brand_outside_helper',
          detail: 'TASK_CARD_BRAND constant must live only in task-card-from-projection.ts',
        })
      }
    }
  }

  // Rule (5) continued: helper file must declare the brand
  const helperPath = path.join(ROOT, HELPER_REL)
  if (!fs.existsSync(helperPath)) {
    violations.push({ file: HELPER_REL, line: 0, kind: 'helper_missing', detail: 'task-card-from-projection.ts does not exist' })
  } else {
    const helperText = fs.readFileSync(helperPath, 'utf8')
    if (!/const\s+TASK_CARD_BRAND\s*:\s*unique\s+symbol/.test(helperText)) {
      violations.push({ file: HELPER_REL, line: 0, kind: 'brand_declaration_missing', detail: 'TASK_CARD_BRAND must be declared as `const TASK_CARD_BRAND: unique symbol = ...`' })
    }
  }

  if (!debugNameSeen) {
    violations.push({
      file: '(renderer)',
      line: 0,
      kind: 'debug_synthesis_missing',
      detail: 'no renderer file defines activeChildRunDebugRow — synthesis path is not labelled',
    })
  } else if (!debugDocOk) {
    violations.push({
      file: '(renderer)',
      line: 0,
      kind: 'debug_synthesis_doc_missing',
      detail: 'activeChildRunDebugRow exists but lacks a doc comment with "debug" + "control-only"',
    })
  }

  if (violations.length === 0) {
    console.log('check-task-card-single-source: ok')
    return
  }
  console.error('check-task-card-single-source: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
