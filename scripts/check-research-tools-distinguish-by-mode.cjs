#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * research-domain-adapter.ts `prepare()` must declare two mutually exclusive
 * prefix sets:
 *   - browser-mode:     ['browser_collect', 'present_file']
 *   - non-browser-mode: ['web_search', 'web_fetch', 'present_file']
 *
 * Both modes MUST include 'present_file' so artifact presentation is
 * possible regardless of which research backend ran (R4-D1 contract).
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
  console.error(`[check-research-tools-distinguish-by-mode] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

const required = ['browser_collect', 'web_search', 'web_fetch', 'present_file']
const missing = required.filter((name) => !new RegExp(`['"]${name}['"]`).test(src))
if (missing.length > 0) {
  console.error('[check-research-tools-distinguish-by-mode] FAIL: research-domain-adapter.ts must mention these tool name literals:')
  missing.forEach((name) => console.error('  - ' + name))
  process.exit(1)
}

if (/['"]browser_research_topic['"]/.test(src)) {
  console.error('[check-research-tools-distinguish-by-mode] FAIL: removed browser_research_topic must not reappear')
  process.exit(1)
}

console.log('[check-research-tools-distinguish-by-mode] OK')
