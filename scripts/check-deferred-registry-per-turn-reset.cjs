#!/usr/bin/env node
/**
 * Stage T PR-T5 — turn-engine resets MCP deferred-tool registry at turn end.
 *
 * Plan v18 §6.2 — deferred-tool promotions are non-persistent. At terminal
 * closure the next turn must start cold. This gate verifies:
 *
 *   1. `turn-engine.ts` references the mcp deferred module (require / import
 *      at the turn-end hook).
 *   2. The terminal closure (`finish(...)`) calls `deferredRegistry.reset()`.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const FILE = 'src/main/modules/agent-control/turn-engine.ts'

function main() {
  const path = resolve(__dirname, '..', FILE)
  if (!existsSync(path)) {
    console.error(`[check-deferred-registry-per-turn-reset] FAIL: missing file ${FILE}`)
    process.exit(1)
  }
  const src = readFileSync(path, 'utf8')
  const violations = []

  // Module reference (lazy require or static import).
  const referencesMcp =
    /require\s*\(\s*['"]\.\.\/mcp\/deferred-filter['"]\s*\)/.test(src) ||
    /from\s*['"]\.\.\/mcp\/deferred-filter['"]/.test(src)
  if (!referencesMcp) {
    violations.push('must reference `../mcp/deferred-filter` (lazy-require or import)')
  }
  // Reset called.
  if (!/deferredRegistry\.reset\s*\(\s*\)/.test(src)) {
    violations.push('must call `deferredRegistry.reset()` at turn-end')
  }
  // Reset happens inside the finish() closure — anchor the proximity check
  // by requiring `transcript.emitStatus` (terminal closure marker) to be
  // within 50 lines BEFORE the reset call.
  const lines = src.split('\n')
  const resetLine = lines.findIndex((l) => /deferredRegistry\.reset\s*\(\s*\)/.test(l))
  if (resetLine >= 0) {
    const window = lines.slice(Math.max(0, resetLine - 50), resetLine).join('\n')
    if (!/transcript\.emitStatus\s*\(/.test(window)) {
      violations.push(
        'deferredRegistry.reset() must live inside the terminal closure (within 50 lines after `transcript.emitStatus(...)`)',
      )
    }
  }

  if (violations.length > 0) {
    console.error('[check-deferred-registry-per-turn-reset] FAIL:')
    for (const v of violations) console.error(`  - ${FILE}: ${v}`)
    process.exit(1)
  }
  console.log('[check-deferred-registry-per-turn-reset] OK')
}

main()
