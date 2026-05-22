#!/usr/bin/env node
/**
 * Stage S W6.2 — Clarification stable message ID gate.
 *
 * Asserts:
 *   - clarification-message-id.ts exports buildClarificationMessageId
 *   - signature: (toolCallId: string | null | undefined, fallbackText?: string) => string
 *   - happy path uses `clarification:${toolCallId}` literal
 *   - fallback path uses sha256(fallbackText).slice(0, 16)
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REL = 'src/main/modules/agent-control/contracts/clarification-message-id.ts'
const errors = []

let src = ''
try {
  src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
} catch (e) {
  console.error(`[check-clarification-stable-id] FAIL: cannot read ${REL}: ${e.message}`)
  process.exit(1)
}

if (!/export\s+function\s+buildClarificationMessageId\s*\(/.test(src)) {
  errors.push('missing `export function buildClarificationMessageId(...)`')
}

if (
  !/toolCallId\s*:\s*string\s*\|\s*null\s*\|\s*undefined/.test(src)
) {
  errors.push('toolCallId parameter must be `string | null | undefined`')
}
if (!/fallbackText\?\s*:\s*string/.test(src)) {
  errors.push('fallbackText parameter must be optional `string`')
}

if (!/return\s+`clarification:\$\{toolCallId\}`/.test(src)) {
  errors.push("happy path must `return `clarification:${toolCallId}``")
}

if (!/createHash\(\s*['"]sha256['"]\s*\)/.test(src)) {
  errors.push("fallback must use `createHash('sha256')`")
}
if (!/\.slice\(\s*0\s*,\s*16\s*\)/.test(src)) {
  errors.push('fallback must `.slice(0, 16)` the hex digest')
}
if (!/return\s+`clarification:\$\{[A-Za-z_][\w]*\}`/.test(src)) {
  errors.push('fallback must return a `clarification:<digest>` template literal')
}

if (errors.length > 0) {
  console.error('[check-clarification-stable-id] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-clarification-stable-id] OK')
