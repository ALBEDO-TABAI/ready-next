#!/usr/bin/env node
/**
 * Stage T (T-B) gate — `parallel-branch-orchestrator.ts` must NOT call
 * `applyTurnFramePatch` directly (§6.20 single-source rule: only the turn
 * engine / caller applies patches), and must export a `mergePatchesSerially`
 * helper so callers can fold N branch patches into one composite patch
 * applied at a single point.
 *
 * This gate enforces:
 *   1. The file does not invoke `applyTurnFramePatch(...)` (import as type
 *      is fine; calling is forbidden).
 *   2. The file exports a `mergePatchesSerially` helper symbol.
 */
const fs = require('fs')
const path = require('path')

const TARGET = path.join(
  __dirname,
  '..',
  'src',
  'main',
  'modules',
  'agent-control',
  'runtime-core',
  'parallel-branch-orchestrator.ts',
)

const errors = []

if (!fs.existsSync(TARGET)) {
  errors.push(`missing file: ${TARGET}`)
} else {
  const src = fs.readFileSync(TARGET, 'utf8')

  // (1) Forbid direct call to applyTurnFramePatch. We allow type-only
  // import and comments mentioning the symbol; what we reject is an
  // actual invocation `applyTurnFramePatch(`.
  const callPattern = /\bapplyTurnFramePatch\s*\(/
  if (callPattern.test(src)) {
    errors.push(
      'parallel-branch-orchestrator.ts must NOT call applyTurnFramePatch directly '
        + '(violates §6.20 single-source frame-write rule). Patches must be '
        + 'collected and applied by the turn-engine caller.',
    )
  }

  // (2) Require mergePatchesSerially helper export.
  const helperExport = /export\s+function\s+mergePatchesSerially\b/
  if (!helperExport.test(src)) {
    errors.push(
      'parallel-branch-orchestrator.ts must export `mergePatchesSerially` '
        + '(named function) so callers fold N branch patches into one '
        + 'composite patch before a single applyTurnFramePatch call.',
    )
  }
}

if (errors.length > 0) {
  console.error('[check-parallel-branch-frame-merge] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-parallel-branch-frame-merge] OK')
