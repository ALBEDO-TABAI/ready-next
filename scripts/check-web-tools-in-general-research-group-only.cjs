#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * web_search / web_fetch / present_file are exclusively in the
 * `general_research` capability group. They MUST NOT leak into:
 *   - BROWSER_CONTENT_TASK_TOOL_NAMES (browser sidecar tools)
 *   - any other static tool name list
 *
 * The general-research-tool-defs.ts file is the single source for the
 * GENERAL_RESEARCH_TOOL_NAMES list.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function readFile(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    console.error(`[check-web-tools-in-general-research-group-only] FAIL: cannot read ${rel}: ${e.message}`)
    process.exit(1)
  }
}

const errors = []

// 1. general-research-tool-defs.ts must define GENERAL_RESEARCH_TOOL_NAMES with all three.
// Match the assignment, not the type annotation:  ... GENERAL_RESEARCH_TOOL_NAMES ... = [ ... ]
const generalResearch = readFile('src/main/modules/tools/general-research-tool-defs.ts')
const namesMatch = generalResearch.match(/GENERAL_RESEARCH_TOOL_NAMES[^=]*=\s*\[([\s\S]*?)\]/)
if (!namesMatch) {
  errors.push('general-research-tool-defs.ts: GENERAL_RESEARCH_TOOL_NAMES assignment not found')
} else {
  const namesBody = namesMatch[1]
  for (const required of ['web_search', 'web_fetch', 'present_file']) {
    if (!new RegExp(`['"]${required}['"]`).test(namesBody)) {
      errors.push(`general-research-tool-defs.ts: GENERAL_RESEARCH_TOOL_NAMES must include '${required}'`)
    }
  }
}

// 2. browser-content-tools defs must NOT include any of these names.
// BROWSER_CONTENT_TASK_TOOL_NAMES currently lives in browser-tool-catalog.ts
// (Stage U move); the older candidates are kept in case a future refactor
// re-creates them, but missing files are silently skipped per the try/catch.
const candidatePaths = [
  'src/main/modules/tools/browser-tool-catalog.ts',
  'src/main/modules/tools/browser-content-tools.ts',
  'src/main/modules/tools/browser-content-tool-defs.ts',
  'src/main/modules/agent-control/tools-runtime/tool-registry.ts',
]
for (const rel of candidatePaths) {
  let body
  try {
    body = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    continue
  }
  // Locate BROWSER_CONTENT_TASK_TOOL_NAMES literal assignment if present here.
  const browserMatch = body.match(/BROWSER_CONTENT_TASK_TOOL_NAMES[^=]*=\s*\[([\s\S]*?)\]/)
  if (!browserMatch) continue
  const browserBody = browserMatch[1]
  for (const forbidden of ['web_search', 'web_fetch', 'present_file']) {
    if (new RegExp(`['"]${forbidden}['"]`).test(browserBody)) {
      errors.push(`${rel}: BROWSER_CONTENT_TASK_TOOL_NAMES must NOT include '${forbidden}' (general_research only)`)
    }
  }
}

if (errors.length > 0) {
  console.error('[check-web-tools-in-general-research-group-only] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log('[check-web-tools-in-general-research-group-only] OK')
