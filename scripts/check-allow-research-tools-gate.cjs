#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * execution-intent-resolver.ts must:
 *   1. compute a `hasResearchIntent` boolean from positiveDomains/excludedDomains
 *   2. compute `allowResearchTools = baseVisibilityPlan.hasTools && hasResearchIntent`
 *   3. wire `general_research: allowResearchTools` into the `intentGroupModes`
 *      object literal
 *
 * If (3) is missing, profiles default to local_chat / scheduled_run will
 * expose web_search/web_fetch even when no research intent fires.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/execution-intent-resolver.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-allow-research-tools-gate] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

const errors = []

if (!/\bhasResearchIntent\b/.test(src)) {
  errors.push('missing `hasResearchIntent` symbol')
}

if (!/\ballowResearchTools\b/.test(src)) {
  errors.push('missing `allowResearchTools` symbol')
}

// Verify the intentGroupModes literal carries general_research entry.
// Strict line-anchored regex so unrelated `general_research` mentions
// (e.g. comments) cannot satisfy the gate.
if (!/general_research\s*:\s*allowResearchTools/.test(src)) {
  errors.push(
    'intentGroupModes must include `general_research: allowResearchTools` '
    + 'so the capability profile honors research intent narrowing',
  )
}

if (errors.length > 0) {
  console.error('[check-allow-research-tools-gate] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log('[check-allow-research-tools-gate] OK')
