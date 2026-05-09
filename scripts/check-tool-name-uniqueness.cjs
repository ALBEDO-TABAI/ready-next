#!/usr/bin/env node
/**
 * Stage R W2.3 — tool-name uniqueness gate.
 *
 * deer-flow tools/tools.py:160-174 silently skip+warn on tool-name
 * collisions. We do the opposite: collisions throw at registry
 * `listToolDefinitions()` time and the boot path treats them as fatal.
 *
 * Asserts:
 *   - tool-registry.ts `listToolDefinitions` collects collisions and
 *     throws ToolNameCollisionError.
 *   - runtime.ts boot path calls `defaultToolRegistry.listToolDefinitions()`.
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

const registry = read('src/main/modules/agent-control/tool-registry.ts')
if (registry) {
  // Find listToolDefinitions implementation block; require collision
  // collection + throw within (or near, since it can be hoisted).
  if (!/listToolDefinitions\s*\(\s*\)\s*:\s*ToolDefinition\[\]\s*\{/.test(registry)) {
    errors.push('tool-registry.ts: listToolDefinitions() implementation not found')
  }
  if (!/throw\s+new\s+ToolNameCollisionError\b/.test(registry)) {
    errors.push('tool-registry.ts: must throw ToolNameCollisionError on collision')
  }
  if (!/\bcollisions\b/.test(registry)) {
    errors.push('tool-registry.ts: must collect a `collisions` list')
  }
}

const runtime = read('src/main/modules/agent-control/runtime.ts')
if (runtime) {
  if (!/defaultToolRegistry\.listToolDefinitions\s*\(/.test(runtime)) {
    errors.push('runtime.ts: boot path must call defaultToolRegistry.listToolDefinitions()')
  }
}

if (errors.length > 0) {
  console.error('[check-tool-name-uniqueness] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-tool-name-uniqueness] OK')
