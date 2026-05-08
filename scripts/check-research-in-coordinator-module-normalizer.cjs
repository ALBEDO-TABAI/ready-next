#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * prompt-assembly.ts `normalizeCoordinatorModule` function must accept
 * `id === 'research'` so the research-domain-adapter's id maps to a valid
 * PromptTriggerHit module value (not undefined).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/prompt-assembly.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-research-in-coordinator-module-normalizer] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

// Locate the function body and ensure 'research' is one of the accepted ids.
const fnMatch = src.match(/function\s+normalizeCoordinatorModule[\s\S]{0,500}?\n\}/)
if (!fnMatch) {
  console.error('[check-research-in-coordinator-module-normalizer] FAIL: normalizeCoordinatorModule function not found')
  process.exit(1)
}

if (!/id\s*===\s*['"]research['"]/.test(fnMatch[0])) {
  console.error('[check-research-in-coordinator-module-normalizer] FAIL: normalizeCoordinatorModule must accept `id === \'research\'`')
  console.error(fnMatch[0])
  process.exit(1)
}

console.log('[check-research-in-coordinator-module-normalizer] OK')
