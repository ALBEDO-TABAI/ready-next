#!/usr/bin/env node
/**
 * Stage R W1.1 — web_search tool shape gate.
 *
 * Asserts:
 *   - src/main/modules/tools/builtins/web-search.ts exports `webSearchSchema`
 *     and `executeWebSearch`.
 *   - tool-registry.ts wires `web_search` into the `general_research`
 *     capability group (via GENERAL_RESEARCH_TOOL_NAMES).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    errors.push(`cannot read ${rel}: ${e.message}`)
    return ''
  }
}

const tool = read('src/main/modules/tools/builtins/web-search.ts')
if (tool) {
  if (!/export\s+const\s+webSearchSchema\b/.test(tool)) {
    errors.push('web-search.ts: missing `export const webSearchSchema`')
  }
  if (!/export\s+async\s+function\s+executeWebSearch\b/.test(tool)) {
    errors.push('web-search.ts: missing `export async function executeWebSearch`')
  }
}

const registry = read('src/main/modules/agent-control/tools-runtime/tool-registry.ts')
const defs = read('src/main/modules/tools/general-research-tool-defs.ts')
if (registry && !/\bgeneral_research\b/.test(registry)) {
  errors.push("tool-registry.ts: missing 'general_research' capability group wiring")
}
if (defs) {
  const namesMatch = defs.match(/GENERAL_RESEARCH_TOOL_NAMES[^=]*=\s*\[([\s\S]*?)\]/)
  if (!namesMatch || !/['"]web_search['"]/.test(namesMatch[1])) {
    errors.push("general-research-tool-defs.ts: GENERAL_RESEARCH_TOOL_NAMES must include 'web_search'")
  }
}

if (errors.length > 0) {
  console.error('[check-web-search-tool-shape] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-web-search-tool-shape] OK')
