#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * `IntentDomain` union in intent-classifier.ts must include 'research' so the
 * research-domain-adapter can be selected by primaryDomain matching.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/intent-classifier.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-intent-domain-includes-research] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

// Find the IntentDomain export and verify it includes 'research'.
const unionMatch = src.match(/export\s+type\s+IntentDomain\s*=\s*([^\n]+)/)
if (!unionMatch) {
  console.error('[check-intent-domain-includes-research] FAIL: IntentDomain union not found in intent-classifier.ts')
  process.exit(1)
}

if (!/['"]research['"]/.test(unionMatch[1])) {
  console.error('[check-intent-domain-includes-research] FAIL: IntentDomain union must include the literal \'research\':')
  console.error('  ' + unionMatch[0])
  process.exit(1)
}

console.log('[check-intent-domain-includes-research] OK')
