#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const errors = []
const verifyT = pkg.scripts?.['verify:t']
if (!verifyT) errors.push('verify:t script missing')
else {
  if (!verifyT.includes('verify:s')) errors.push('verify:t must embed verify:s')
}
if (!pkg.scripts?.['test:t:gates']) errors.push('test:t:gates script missing')
if (!pkg.scripts?.['test:t:focus']) errors.push('test:t:focus script missing')
if (errors.length > 0) {
  console.error('[check-verify-t-defined] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-verify-t-defined] OK')
