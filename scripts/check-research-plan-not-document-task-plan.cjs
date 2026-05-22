#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * research-domain-adapter.ts must declare its own ResearchPlan interface
 * and must NOT reference DocumentTaskPlan (cross-domain coupling). Plan
 * §3.1.2 chose to keep research planning separate from document planning
 * because the two domains have different lifecycle semantics.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/domain-adapters/research-domain-adapter.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-research-plan-not-document-task-plan] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

if (!/(?:export\s+)?interface\s+ResearchPlan\b/.test(src)) {
  console.error('[check-research-plan-not-document-task-plan] FAIL: research-domain-adapter.ts must declare `interface ResearchPlan`')
  process.exit(1)
}

// Check for DocumentTaskPlan references in non-comment code only.
// Strip block comments (/* ... */) and line comments (// ...) before scanning.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const stripped = stripComments(src)
if (/DocumentTaskPlan\b/.test(stripped)) {
  console.error('[check-research-plan-not-document-task-plan] FAIL: research-domain-adapter.ts must NOT reference DocumentTaskPlan in code')
  console.error('  Cross-domain coupling: research planning must stay independent of document planning')
  process.exit(1)
}

console.log('[check-research-plan-not-document-task-plan] OK')
