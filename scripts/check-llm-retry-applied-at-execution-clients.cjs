#!/usr/bin/env node
/**
 * Stage S W8.2 — withRetryBackoff applied at execution clients gate.
 *
 * Asserts both `openai-execution-client.ts` and
 * `anthropic-execution-client.ts` import `withRetryBackoff` AND wrap
 * every production LLM request path with it. Stage S round 2 strengthened
 * this from the helper-only ≥ 1 floor to a full-coverage requirement:
 *
 *   - `openai-execution-client.ts` → ≥ 6 calls (simple-responses, simple-chat,
 *     text-tool-bridge-responses, text-tool-bridge-chat, responses-tools,
 *     chat-completions-tools)
 *   - `anthropic-execution-client.ts` → ≥ 2 calls (simple, tools)
 *
 * Round 2 also forbids `TODO(stage-s-followup)` markers from lingering in
 * either file — every fetch the original Stage S landed must now be
 * wrapped, not deferred.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const TARGETS = [
  {
    rel: 'src/main/modules/claude-bridge/openai-execution-client.ts',
    minCalls: 6,
  },
  {
    rel: 'src/main/modules/claude-bridge/anthropic-execution-client.ts',
    minCalls: 2,
  },
]

function check({ root = REPO_DEFAULT } = {}) {
  const errors = []
  for (const { rel, minCalls } of TARGETS) {
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
    if (callCount < minCalls) {
      errors.push(`${rel}: withRetryBackoff called ${callCount} time(s); expected ≥ ${minCalls}`)
    }
    if (/TODO\(stage-s-followup\)/.test(src)) {
      errors.push(`${rel}: leftover TODO(stage-s-followup) marker — all fetches must be wrapped, not deferred`)
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
