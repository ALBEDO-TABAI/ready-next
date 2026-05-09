#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const errors = []
const verifyS = pkg.scripts?.['verify:s']
if (!verifyS) errors.push('verify:s script missing')
else {
  if (!verifyS.includes('verify:r')) errors.push('verify:s must embed verify:r')
  if (!verifyS.includes('verify:native')) errors.push('verify:s must embed verify:native')
  if (!verifyS.includes('test:s:gates')) errors.push('verify:s must include test:s:gates')
  if (!verifyS.includes('test:s:focus')) errors.push('verify:s must include test:s:focus')
}
if (!pkg.scripts?.['test:s:gates']) errors.push('test:s:gates script missing')
if (!pkg.scripts?.['test:s:focus']) errors.push('test:s:focus script missing')
if (errors.length > 0) {
  console.error('[check-verify-s-defined] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-verify-s-defined] OK')
