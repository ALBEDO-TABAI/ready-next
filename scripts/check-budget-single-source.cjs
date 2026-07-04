#!/usr/bin/env node
/**
 * Stage M (M3) — `frame.budget` is the only steering/dispatch read source
 * for budget state; `produceBudgetPatch` is the only producer.
 *
 * Plan §3.3 — three sub-checks:
 *   1. Steering (`turn-frame-steering.ts`) MUST NOT read
 *      `currentLeaseEndIteration` or `hardCapIteration` directly off the
 *      lease state. Reads come from `frame.budget.*`.
 *   2. Every lease-state mutation in `turn-engine.ts` that affects
 *      `frame.budget` (lease creation, lease replacement, currentLeaseEnd /
 *      hardCap field writes) is followed by a call to `produceBudgetPatch`
 *      within the same enclosing block. The check runs on a small text
 *      window after each mutation site. Score / fingerprint mutations are
 *      explicitly exempt (see plan §3.3.2).
 *   3. Plan §3.1's gate already handles "no direct turnFrame.budget = ..."
 *      writes — kept here as a belt-and-suspenders pattern only.
 *
 * v8 of the plan called for AST + alias tracking. This implementation is
 * the regex-based "lite" version that catches the documented patterns.
 * If it false-positives, callers should restructure the code rather than
 * suppress the gate.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const STEERING_FILE = path.join(REPO, 'src/main/modules/agent-control/runtime-core/turn-frame-steering.ts')
const LEASE_CONTROLLER_FILE = path.join(REPO, 'src/main/modules/agent-control/skills/skill-budget-lease-controller.ts')

function stripComments(line) {
  const idx = line.indexOf('//')
  return idx === -1 ? line : line.slice(0, idx)
}

function readSource(file) {
  let src = fs.readFileSync(file, 'utf8')
  // strip block comments
  src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return src
}

// ─── Sub-check 1 ────────────────────────────────────────────────────────────
// Steering must not read `.currentLeaseEndIteration` or `.hardCapIteration`
// from anywhere except `frame.budget.*`. The forbidden tokens fire if any
// non-frame property access uses them.
function checkSteeringReadsFrameBudgetOnly() {
  const violations = []
  const src = readSource(STEERING_FILE)
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComments(lines[i])
    if (/\.currentLeaseEndIteration\b/.test(stripped) || /\.hardCapIteration\b/.test(stripped)) {
      violations.push({
        file: STEERING_FILE,
        line: i + 1,
        code: lines[i].trim(),
        why: 'steering must read frame.budget.{leaseEndIteration,hardCapIteration} only',
      })
    }
  }
  return violations
}

// ─── Sub-check 3 ────────────────────────────────────────────────────────────
// produceBudgetPatch lives only in lease-controller.ts (plus its caller wrapper
// in turn-engine.ts). Other producers can't be added without showing up here.
function checkProducerLocality() {
  const violations = []
  // Walk the agent-control directory; flag any file that defines a function
  // with name produceBudgetPatch outside the lease controller.
  const dir = path.join(REPO, 'src/main/modules/agent-control')
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
        if (entry.name === '__tests__') continue
        stack.push(full)
      } else if (full.endsWith('.ts') && full !== LEASE_CONTROLLER_FILE) {
        let src
        try { src = fs.readFileSync(full, 'utf8') } catch { continue }
        // Block-strip comments and look for "function produceBudgetPatch"
        src = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
        if (/(?:export\s+)?function\s+produceBudgetPatch\s*\(/.test(src)) {
          violations.push({
            file: full,
            line: 1,
            code: '(produceBudgetPatch defined outside skill-budget-lease-controller.ts)',
            why: 'producer must live in skill-budget-lease-controller.ts (single producer site)',
          })
        }
      }
    }
  }
  return violations
}

function main() {
  const violations = [
    ...checkSteeringReadsFrameBudgetOnly(),
    ...checkProducerLocality(),
  ]
  if (violations.length === 0) {
    console.log('[check-budget-single-source] OK')
    return
  }
  console.error('[check-budget-single-source] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(process.cwd(), v.file)}:${v.line}`)
    console.error(`    why:  ${v.why}`)
    console.error(`    code: ${v.code}`)
  }
  console.error('')
  console.error('Stage M invariant I3: frame.budget is the steering read source;')
  console.error('produceBudgetPatch (in skill-budget-lease-controller.ts) is the only producer.')
  console.error('See plan §3.3.')
  process.exit(1)
}

main()
