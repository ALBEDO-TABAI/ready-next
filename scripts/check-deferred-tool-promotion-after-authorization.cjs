#!/usr/bin/env node
/**
 * Stage T PR-T5 — deferred MCP tool promotion routes through `isAuthorized`.
 *
 * Plan v18 §6.2: deferred tools become "active" within a turn-gap, but the
 * promotion path MUST go through `mcp.registry.isAuthorized` — never bypass
 * OAuth. This gate enforces that `mcp/deferred-filter.ts`:
 *
 *   1. Imports `isAuthorized` from `./registry`.
 *   2. Has a `promoteActive` (or equivalent) method that calls `isAuthorized`
 *      before declaring a tool promoted.
 *   3. Calls it with the (toolName, sessionId, scopeId) tuple — same 3-arity
 *      contract as the model-visible list path.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const FILE = 'src/main/modules/mcp/deferred-filter.ts'

function main() {
  const path = resolve(__dirname, '..', FILE)
  if (!existsSync(path)) {
    console.error(`[check-deferred-tool-promotion-after-authorization] FAIL: missing file ${FILE}`)
    process.exit(1)
  }
  const src = readFileSync(path, 'utf8')
  const violations = []

  if (!/import\s*\{[^}]*\bisAuthorized\b[^}]*\}\s*from\s*['"]\.\/registry['"]/.test(src)) {
    violations.push('must import `isAuthorized` from `./registry`')
  }
  if (!/\bpromoteActive\s*\(/.test(src) && !/\bpromote\s*\(/.test(src)) {
    violations.push('must define a promotion method (`promoteActive(...)` or `promote(...)`)')
  }
  // The promotion path must call isAuthorized.
  if (!/isAuthorized\s*\(/.test(src)) {
    violations.push('promotion path must call `isAuthorized(...)`')
  }
  // 3-arity: toolName + sessionId + scopeId (or context.sessionId / context.scopeId).
  const has3Arity =
    /isAuthorized\s*\([^)]*\bsessionId\b[^)]*\bscopeId\b[^)]*\)/.test(src) ||
    /isAuthorized\s*\([^)]*\bcontext\.sessionId\b[^)]*\bcontext\.scopeId\b[^)]*\)/.test(src)
  if (!has3Arity) {
    violations.push(
      'isAuthorized call must include sessionId and scopeId (3-arity contract)',
    )
  }
  // The reset entry point — the gate that makes deferred state per-turn —
  // is checked by `check-deferred-registry-per-turn-reset.cjs`. Here we
  // require the symbol simply exists in this file so promotion + reset
  // live together.
  if (!/\breset\s*\(\s*\)/.test(src)) {
    violations.push('must expose a `reset()` method (per-turn lifecycle)')
  }

  if (violations.length > 0) {
    console.error('[check-deferred-tool-promotion-after-authorization] FAIL:')
    for (const v of violations) console.error(`  - ${FILE}: ${v}`)
    process.exit(1)
  }
  console.log('[check-deferred-tool-promotion-after-authorization] OK')
}

main()
