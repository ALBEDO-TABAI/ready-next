#!/usr/bin/env node
/**
 * Stage S W6.3 — Clarification turn-gap (not middleware) contract gate.
 *
 * Asserts:
 *   - clarification-turn-gap.ts exists
 *   - the docstring contains the literal contract phrase
 *     "NOT inside a middleware chain" — this rejects deer-flow's `goto END`
 *     middleware pattern that conflicts with §6.10 single-arbitration.
 *   - exports the helper `shouldTriggerClarification` and the
 *     `ClarificationGapContext` shape.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REL = 'src/main/modules/agent-control/clarification-turn-gap.ts'
const errors = []

let src = ''
try {
  src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
} catch (e) {
  console.error(`[check-clarification-turn-gap-not-middleware] FAIL: cannot read ${REL}: ${e.message}`)
  process.exit(1)
}

if (!src.includes('NOT inside a middleware chain')) {
  errors.push("docstring must include literal 'NOT inside a middleware chain' (contract marker)")
}
if (!/export\s+interface\s+ClarificationGapContext\b/.test(src)) {
  errors.push('missing `export interface ClarificationGapContext`')
}
if (!/export\s+function\s+shouldTriggerClarification\s*\(/.test(src)) {
  errors.push('missing `export function shouldTriggerClarification(...)`')
}
if (!/toolBatchHadAskUser\s*:\s*boolean/.test(src)) {
  errors.push('ClarificationGapContext.toolBatchHadAskUser must be `boolean`')
}
if (!/pendingClarification\s*:\s*ClarificationRequest\s*\|\s*null/.test(src)) {
  errors.push('ClarificationGapContext.pendingClarification must be `ClarificationRequest | null`')
}

if (errors.length > 0) {
  console.error('[check-clarification-turn-gap-not-middleware] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-clarification-turn-gap-not-middleware] OK')
