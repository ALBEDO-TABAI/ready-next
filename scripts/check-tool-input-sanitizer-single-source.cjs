#!/usr/bin/env node
/**
 * Stage R W2.2 — tool-input sanitizer single-source gate.
 *
 * The deer-flow `dangling_tool_call_middleware` injection pattern is
 * forbidden; we ship one drop-only sanitizer
 * (`sanitizeOpenAICompatibleMessageHistory`) and require provider clients
 * to call it on the message history.
 *
 * Required call sites (audited):
 *   - src/main/modules/claude-bridge/openai-execution-client.ts
 *   - src/main/modules/claude-bridge/kimi-coding-client.ts
 *
 * KNOWN AUDIT GAP (audits/2026-05-09-history-sanitizer-coverage.md):
 *   - anthropic-execution-client.ts intentionally NOT covered. Stage R
 *     accepts this gap; it is recorded as a TODO(stage-r-followup) and
 *     this gate does NOT enforce that file.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

const REQUIRED_CALL_SITES = [
  'src/main/modules/claude-bridge/openai-execution-client.ts',
  'src/main/modules/claude-bridge/kimi-coding-client.ts',
]
const FN = 'sanitizeOpenAICompatibleMessageHistory'

for (const rel of REQUIRED_CALL_SITES) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) {
    errors.push(`missing required file: ${rel}`)
    continue
  }
  const body = fs.readFileSync(full, 'utf8')
  // Count call invocations: `<FN>(`, ignore mere `import { <FN> }` line.
  const callRe = new RegExp(`\\b${FN}\\s*\\(`, 'g')
  const matches = body.match(callRe) || []
  if (matches.length < 1) {
    errors.push(`${rel}: must call ${FN}() at least once (none found)`)
  }
}

if (errors.length > 0) {
  console.error('[check-tool-input-sanitizer-single-source] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-tool-input-sanitizer-single-source] OK')
