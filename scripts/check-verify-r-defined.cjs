#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const errors = []
const verifyR = pkg.scripts?.['verify:r']
if (!verifyR) errors.push('verify:r script missing')
else {
  if (!verifyR.includes('verify:q')) errors.push('verify:r must embed verify:q')
  if (!verifyR.includes('test:r:gates')) errors.push('verify:r must include test:r:gates')
  if (!verifyR.includes('test:r:focus')) errors.push('verify:r must include test:r:focus')
}
if (!pkg.scripts?.['test:r:gates']) errors.push('test:r:gates script missing')
if (!pkg.scripts?.['test:r:focus']) errors.push('test:r:focus script missing')
if (errors.length > 0) {
  console.error('[check-verify-r-defined] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-verify-r-defined] OK')
