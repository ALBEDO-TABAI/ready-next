#!/usr/bin/env node
/**
 * Stage 6 L2 gate. Asserts that the sealed close-event factory is wired
 * correctly so every (status, terminalReason) pair flowing through the freeze
 * helper is validated at runtime.
 *
 * Checks:
 *
 *   (1) `skill-child-close-event-freeze.ts` exists.
 *   (2) That file exports `freezeSkillChildCloseEvent`,
 *       `validateSkillChildCloseInvariant`, and `InvalidCloseEventError`.
 *   (3) `freezeSkillChildCloseEvent`'s body calls `validateSkillChildCloseInvariant`.
 *   (4) No production file outside the helper assigns an object literal
 *       directly to a `SkillChildCloseEvent`-typed variable
 *       (`const x: SkillChildCloseEvent = {...}`) — this would bypass the validator.
 *
 * The narrower MutableSkillChildCloseEvent cast pattern
 * (`freezeSkillChildCloseEvent({...} as MutableSkillChildCloseEvent)`) is the
 * sanctioned construction shape and is intentionally NOT flagged: the cast
 * only widens the literal to the mutable input shape; the freeze helper still
 * validates before returning.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const HELPER_REL = 'src/main/modules/agent-control/skill-child-close-event-freeze.ts'
const HELPER_PATH = path.join(ROOT, HELPER_REL)
const SCAN_DIR = 'src/main/modules/'

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

  if (!fs.existsSync(HELPER_PATH)) {
    violations.push({ file: HELPER_REL, line: 0, kind: 'helper_missing', detail: 'helper file does not exist' })
  } else {
    const helperText = fs.readFileSync(HELPER_PATH, 'utf8')
    if (!/export\s+function\s+freezeSkillChildCloseEvent\s*\(/.test(helperText)) {
      violations.push({ file: HELPER_REL, line: 0, kind: 'export_missing', detail: 'freezeSkillChildCloseEvent not exported' })
    }
    if (!/export\s+function\s+validateSkillChildCloseInvariant\s*\(/.test(helperText)) {
      violations.push({ file: HELPER_REL, line: 0, kind: 'export_missing', detail: 'validateSkillChildCloseInvariant not exported' })
    }
    if (!/export\s+class\s+InvalidCloseEventError\b/.test(helperText)) {
      violations.push({ file: HELPER_REL, line: 0, kind: 'export_missing', detail: 'InvalidCloseEventError not exported' })
    }
    // Match all occurrences of `validateSkillChildCloseInvariant(`.
    // The declaration itself ('export function validateSkillChildCloseInvariant(')
    // counts as one. We need at least one *call* — i.e. ≥ 2 occurrences total.
    const callCount = (helperText.match(/validateSkillChildCloseInvariant\s*\(/g) || []).length
    if (callCount < 2) {
      violations.push({ file: HELPER_REL, line: 0, kind: 'validator_not_called', detail: 'helper does not call validateSkillChildCloseInvariant() (only the declaration was found)' })
    }
  }

  // Rule (4): forbid `: SkillChildCloseEvent\s*=\s*\{` (annotation + literal init) outside helper / tests
  const dir = path.join(ROOT, SCAN_DIR)
  if (fs.existsSync(dir)) {
    for (const file of listFiles(dir)) {
      const rel = relposix(file)
      if (rel === HELPER_REL) continue
      if (rel.includes('/__tests__/')) continue
      const text = fs.readFileSync(file, 'utf8')
      if (!text.includes('SkillChildCloseEvent')) continue
      const re = /:\s*SkillChildCloseEvent\s*=\s*\{/g
      let m
      while ((m = re.exec(text))) {
        violations.push({
          file: rel,
          line: lineOf(text, m.index),
          kind: 'literal_assignment_to_close_event',
          detail: 'object literal assigned to SkillChildCloseEvent-typed variable bypasses freeze validator',
        })
      }
    }
  }

  if (violations.length === 0) {
    console.log('check-close-event-factory: ok')
    return
  }
  console.error('check-close-event-factory: violations:')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
  }
  process.exit(1)
}

main()
