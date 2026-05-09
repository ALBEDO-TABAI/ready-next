#!/usr/bin/env node
// PR-S13 switch gate (Stage S).
// Asserts the top-level `verify` and `verify:cloud` chains have been switched
// to embed `verify:s`, and that CLAUDE.md documents §6.26 (Stage S).
// This gate intentionally does NOT participate in `verify:s` itself —
// it is invoked separately to confirm the Stage 切换.

const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..')
const errors = []

// 1. package.json: verify + verify:cloud must embed verify:s
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const verify = pkg.scripts?.['verify']
const verifyCloud = pkg.scripts?.['verify:cloud']

if (!verify) {
  errors.push('package.json: missing top-level `verify` script')
} else if (!verify.includes('verify:s')) {
  errors.push('package.json: top-level `verify` must embed `verify:s` (Stage S 切换)')
}

if (!verifyCloud) {
  errors.push('package.json: missing `verify:cloud` script')
} else if (!verifyCloud.includes('verify:s')) {
  errors.push('package.json: `verify:cloud` must embed `verify:s` (Stage S 切换)')
}

// 2. CLAUDE.md must contain §6.26 marker
const claudeMd = fs.readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8')
if (!/^### 6\.26\b/m.test(claudeMd)) {
  errors.push('CLAUDE.md: missing `### 6.26` Stage S section header')
}

if (errors.length > 0) {
  console.error('[check-stage-s-verify-switch] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-stage-s-verify-switch] OK')
