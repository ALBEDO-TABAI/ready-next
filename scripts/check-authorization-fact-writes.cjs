#!/usr/bin/env node
/**
 * EP2-I-auth — closed write-surface gate (approved design 05 §3.4.3).
 *
 * The two authorization-fact write entries may be CALLED from exactly the
 * whitelisted files: the classifier consumption chain (agent-sdk-runtime /
 * agent-sdk-turn-orchestrator) and the frozen-call confirmation release path. Any call from tool
 * dispatch / tool-result processing paths means third-party content could
 * mint permissions — instant red.
 */

const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ROOT = join(__dirname, '..')
const SCAN_ROOT = join(ROOT, 'src')

const WRITE_ENTRIES = /\b(recordVerbatimGrant|recordConfirmationGrant)\s*\(/

const WHITELIST = new Set([
  'src/main/modules/agent-control/safety/authorization-fact-store.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts',
  'src/main/modules/agent-control/safety/frozen-call-confirmation.ts',
  'src/__tests__/authorization-fact.test.ts',
])

// any call landing under these prefixes is the prompt-injection escalation
// path the design forbids — fail even if someone edits the whitelist above.
const HARD_FORBIDDEN_PREFIXES = [
  'src/main/modules/tools/',
  'src/main/modules/agent-control/tools-runtime/',
  'src/main/modules/browser-engine/',
]

const violations = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) { walk(abs); continue }
    if (!name.endsWith('.ts')) continue
    const rel = relative(ROOT, abs).replace(/\\/g, '/')
    const text = readFileSync(abs, 'utf-8')
    if (!WRITE_ENTRIES.test(text)) continue
    const hardForbidden = HARD_FORBIDDEN_PREFIXES.some((prefix) => rel.startsWith(prefix))
    if (!hardForbidden && WHITELIST.has(rel)) continue
    const line = text.slice(0, text.search(WRITE_ENTRIES)).split('\n').length
    violations.push(`${rel}:${line}${hardForbidden ? ' (tool/result path — hard forbidden)' : ''}`)
  }
}

walk(SCAN_ROOT)

if (violations.length > 0) {
  console.error('check-authorization-fact-writes: FAIL — write entries called outside the closed surface:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('check-authorization-fact-writes: ok')
