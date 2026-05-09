#!/usr/bin/env node
/**
 * Stage R W5.1 — run-span metadata frozen-keys gate.
 *
 * RUN_SPAN_METADATA_KEYS must contain exactly these 6 keys:
 *   agent_id / model / capability_class / parent_run_id / task_type / session_id
 *
 * Adding a new key requires updating this gate explicitly so reviewers
 * notice when the per-run span shape changes.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

const REQUIRED_KEYS = [
  'agent_id',
  'model',
  'capability_class',
  'parent_run_id',
  'task_type',
  'session_id',
]

const file = path.join(ROOT, 'src/main/modules/agent-control/run-span-metadata.ts')
let body = ''
try {
  body = fs.readFileSync(file, 'utf8')
} catch (e) {
  errors.push(`cannot read run-span-metadata.ts: ${e.message}`)
}

if (body) {
  const arrMatch = body.match(/RUN_SPAN_METADATA_KEYS[^=]*=\s*\[([\s\S]*?)\]\s*as\s+const/)
  if (!arrMatch) {
    errors.push('run-span-metadata.ts: RUN_SPAN_METADATA_KEYS literal array not found')
  } else {
    const arrBody = arrMatch[1]
    for (const key of REQUIRED_KEYS) {
      if (!new RegExp(`['"]${key}['"]`).test(arrBody)) {
        errors.push(`RUN_SPAN_METADATA_KEYS must include '${key}'`)
      }
    }
    // Detect surprise extra string entries (keys outside the frozen set).
    const literalRe = /['"]([a-z_]+)['"]/g
    const found = new Set()
    let m
    while ((m = literalRe.exec(arrBody))) found.add(m[1])
    for (const extra of found) {
      if (!REQUIRED_KEYS.includes(extra)) {
        errors.push(
          `RUN_SPAN_METADATA_KEYS contains unexpected key '${extra}'; update gate intentionally`,
        )
      }
    }
  }
}

if (errors.length > 0) {
  console.error('[check-run-span-metadata-keys-frozen] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-run-span-metadata-keys-frozen] OK')
