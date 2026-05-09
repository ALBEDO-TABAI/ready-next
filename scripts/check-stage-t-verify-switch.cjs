#!/usr/bin/env node
/**
 * Stage T PR-T6 — verify chain switch gate.
 *
 * Plan v18 §10 收敛条件：Stage T done 后主 `verify` 与 `verify:cloud`
 * 起步链必须切到 `verify:t`；CLAUDE.md 必须 land §6.27。
 *
 * This gate enforces three contracts:
 *   1. `package.json` `verify` script embeds `verify:t`.
 *   2. `package.json` `verify:cloud` script embeds `verify:t`.
 *   3. `CLAUDE.md` contains the `### 6.27` heading.
 */
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..')
const errors = []

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const scripts = pkg.scripts || {}

const verify = scripts['verify']
if (!verify) {
  errors.push('package.json: `verify` script missing')
} else if (!verify.includes('verify:t')) {
  errors.push('package.json: `verify` must embed `verify:t` (Stage T switch)')
}

const verifyCloud = scripts['verify:cloud']
if (!verifyCloud) {
  errors.push('package.json: `verify:cloud` script missing')
} else if (!verifyCloud.includes('verify:t')) {
  errors.push('package.json: `verify:cloud` must embed `verify:t` (Stage T switch)')
}

const claudeMdPath = path.join(repoRoot, 'CLAUDE.md')
if (!fs.existsSync(claudeMdPath)) {
  errors.push('CLAUDE.md missing at repo root')
} else {
  const claudeMd = fs.readFileSync(claudeMdPath, 'utf8')
  if (!/^### 6\.27\b/m.test(claudeMd)) {
    errors.push('CLAUDE.md: `### 6.27` heading missing (Stage T charter not landed)')
  }
}

if (errors.length > 0) {
  console.error('[check-stage-t-verify-switch] FAIL:')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log('[check-stage-t-verify-switch] OK')
