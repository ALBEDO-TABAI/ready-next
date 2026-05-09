#!/usr/bin/env node
/**
 * Stage S W6.1 — Clarification 5-type union frozen gate.
 *
 * Asserts:
 *   - clarification-types.ts exports CLARIFICATION_TYPES as a const array
 *   - the array contains exactly the 5 expected members:
 *     missing_info | ambiguous_requirement | approach_choice |
 *     risk_confirmation | suggestion
 *   - no extra entries are added without updating this gate.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REL = 'src/main/modules/agent-control/clarification-types.ts'
const errors = []

let src = ''
try {
  src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
} catch (e) {
  console.error(`[check-clarification-type-enum-frozen] FAIL: cannot read ${REL}: ${e.message}`)
  process.exit(1)
}

const arrayMatch = src.match(
  /export\s+const\s+CLARIFICATION_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
)
if (!arrayMatch) {
  errors.push("CLARIFICATION_TYPES `as const` array literal not found")
} else {
  const body = arrayMatch[1]
  const literals = Array.from(body.matchAll(/['"]([a-z_]+)['"]/g)).map((m) => m[1])
  const expected = [
    'missing_info',
    'ambiguous_requirement',
    'approach_choice',
    'risk_confirmation',
    'suggestion',
  ]
  if (literals.length !== expected.length) {
    errors.push(
      `CLARIFICATION_TYPES must have exactly ${expected.length} members, found ${literals.length}: [${literals.join(', ')}]`,
    )
  }
  for (const want of expected) {
    if (!literals.includes(want)) {
      errors.push(`CLARIFICATION_TYPES missing required member '${want}'`)
    }
  }
  for (const got of literals) {
    if (!expected.includes(got)) {
      errors.push(
        `CLARIFICATION_TYPES contains unexpected member '${got}'; update the gate together with the union`,
      )
    }
  }
}

if (!/export\s+type\s+ClarificationType\s*=\s*\(typeof\s+CLARIFICATION_TYPES\)\[number\]/.test(src)) {
  errors.push('ClarificationType must be derived as `(typeof CLARIFICATION_TYPES)[number]`')
}

if (errors.length > 0) {
  console.error('[check-clarification-type-enum-frozen] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-clarification-type-enum-frozen] OK')
