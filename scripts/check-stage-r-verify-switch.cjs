#!/usr/bin/env node
/**
 * Stage R PR-R8 — verify-switch gate.
 *
 * Confirms the Stage R cutover is wired in:
 *   - package.json `verify` chain embeds `verify:r`
 *   - package.json `verify:cloud` chain embeds `verify:r`
 *   - CLAUDE.md contains the §6.25 marker
 *
 * Not embedded inside `verify:r` itself; intended to be run by the
 * cutover PR / Stage R smoke chain.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

function readFile(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    errors.push(`cannot read ${rel}: ${e.message}`)
    return ''
  }
}

const pkgRaw = readFile('package.json')
let pkg = null
try {
  pkg = JSON.parse(pkgRaw)
} catch (e) {
  errors.push(`package.json parse failed: ${e.message}`)
}

if (pkg) {
  const verify = pkg.scripts?.['verify'] || ''
  const verifyCloud = pkg.scripts?.['verify:cloud'] || ''
  if (!verify.includes('verify:r')) {
    errors.push(`package.json: 'verify' script must embed 'verify:r' (got: ${verify})`)
  }
  if (!verifyCloud.includes('verify:r')) {
    errors.push(`package.json: 'verify:cloud' script must embed 'verify:r' (got: ${verifyCloud})`)
  }
}

const claudeMd = readFile('CLAUDE.md')
if (claudeMd && !/^### 6\.25\b/m.test(claudeMd)) {
  errors.push("CLAUDE.md: missing '### 6.25' section header")
}

if (errors.length > 0) {
  console.error('[check-stage-r-verify-switch] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-stage-r-verify-switch] OK')
