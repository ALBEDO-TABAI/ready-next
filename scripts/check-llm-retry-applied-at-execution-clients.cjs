#!/usr/bin/env node
/**
 * Stage S W8.2 — withRetryBackoff applied at execution clients gate.
 *
 * Asserts both `openai-execution-client.ts` and
 * `anthropic-execution-client.ts` import and call `withRetryBackoff`
 * at least once each — i.e. the retry helper is wired into the
 * production LLM request path.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const TARGETS = [
  'src/main/modules/claude-bridge/openai-execution-client.ts',
  'src/main/modules/claude-bridge/anthropic-execution-client.ts',
]

function check({ root = REPO_DEFAULT } = {}) {
  const errors = []
  for (const rel of TARGETS) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      errors.push(`Missing ${rel}`)
      continue
    }
    const src = fs.readFileSync(abs, 'utf8')
    const hasImport = /import\s*\{[^}]*\bwithRetryBackoff\b[^}]*\}\s*from\s*['"]\.\/llm-resilience['"]/.test(src)
    if (!hasImport) {
      errors.push(`${rel}: must import { withRetryBackoff } from './llm-resilience'`)
    }
    const callCount = (src.match(/\bwithRetryBackoff\s*\(/g) || []).length
    if (callCount < 1) {
      errors.push(`${rel}: withRetryBackoff called ${callCount} time(s); expected ≥ 1`)
    }
  }
  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-llm-retry-applied-at-execution-clients] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-llm-retry-applied-at-execution-clients] OK')
}

module.exports = { check, TARGETS }
