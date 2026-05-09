#!/usr/bin/env node
/**
 * Stage R W6.4 — present_file path-sandbox gate.
 *
 * present_file MUST resolve paths via `resolveReadableWithinRoot(
 *   ctx.outputsRoot, args.path)` (the canonical + symlink-safe helper),
 * NOT via naive `startsWith` / `path.relative` checks. Naive prefix
 * comparison is vulnerable to sibling-prefix attacks (e.g.
 * `<outputsRoot>-evil/foo`).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

const file = path.join(ROOT, 'src/main/modules/tools/builtins/present-file.ts')
let body = ''
try {
  body = fs.readFileSync(file, 'utf8')
} catch (e) {
  errors.push(`cannot read present-file.ts: ${e.message}`)
}

if (body) {
  // Must call resolveReadableWithinRoot with (outputsRoot or ctx.outputsRoot, ...).
  if (!/resolveReadableWithinRoot\s*\(/.test(body)) {
    errors.push('present-file.ts: must call resolveReadableWithinRoot(...)')
  }
  // Specifically reference outputsRoot in the call (the dispatcher hands
  // it through ctx.outputsRoot per §6.25 contract).
  if (!/resolveReadableWithinRoot\s*\(\s*[^)]*outputsRoot/.test(body)) {
    errors.push(
      'present-file.ts: resolveReadableWithinRoot must take an outputsRoot argument',
    )
  }
  // Forbid naive startsWith path-checks on outputsRoot.
  if (/outputsRoot[^\n]*\.startsWith\s*\(/.test(body)) {
    errors.push(
      'present-file.ts: must NOT use naive startsWith() against outputsRoot (sibling-prefix attack)',
    )
  }
}

if (errors.length > 0) {
  console.error('[check-present-file-only-outputs-dir] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-present-file-only-outputs-dir] OK')
