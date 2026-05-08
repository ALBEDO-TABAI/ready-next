#!/usr/bin/env node
/**
 * Stage R W1.2 — web_fetch tool shape gate.
 *
 * Asserts:
 *   - src/main/modules/tools/builtins/web-fetch.ts exports `webFetchSchema`
 *     and `executeWebFetch`.
 *   - GENERAL_RESEARCH_TOOL_NAMES contains `web_fetch`.
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

const tool = read('src/main/modules/tools/builtins/web-fetch.ts')
if (tool) {
  if (!/export\s+const\s+webFetchSchema\b/.test(tool)) {
    errors.push('web-fetch.ts: missing `export const webFetchSchema`')
  }
  if (!/export\s+async\s+function\s+executeWebFetch\b/.test(tool)) {
    errors.push('web-fetch.ts: missing `export async function executeWebFetch`')
  }
}

const registry = read('src/main/modules/agent-control/tool-registry.ts')
const defs = read('src/main/modules/tools/general-research-tool-defs.ts')
if (registry && !/\bgeneral_research\b/.test(registry)) {
  errors.push("tool-registry.ts: missing 'general_research' capability group wiring")
}
if (defs) {
  const namesMatch = defs.match(/GENERAL_RESEARCH_TOOL_NAMES[^=]*=\s*\[([\s\S]*?)\]/)
  if (!namesMatch || !/['"]web_fetch['"]/.test(namesMatch[1])) {
    errors.push("general-research-tool-defs.ts: GENERAL_RESEARCH_TOOL_NAMES must include 'web_fetch'")
  }
}

if (errors.length > 0) {
  console.error('[check-web-fetch-tool-shape] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-web-fetch-tool-shape] OK')
