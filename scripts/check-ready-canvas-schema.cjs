#!/usr/bin/env node
'use strict'
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { register } = require('tsx/cjs/api')
register()
const { readCanvas } = require('../src/shared/ready-canvas/schema.ts')
const args = process.argv.slice(2)
const reject = args.includes('--expect-invalid')
const paths = args.filter(arg => arg !== '--expect-invalid')
function files(path) {
  if (statSync(path).isDirectory()) return readdirSync(path).sort().flatMap(name => files(join(path, name)))
  return path.endsWith('.canvas') ? [path] : []
}
try {
  if (!paths.length) throw new Error('Usage: check-ready-canvas-schema.cjs [--expect-invalid] <file.canvas|directory> ...')
  const inputs = paths.flatMap(path => files(resolve(path)))
  if (!inputs.length) throw new Error('No .canvas fixtures found')
  let failures = 0
  for (const path of inputs) {
    let reason
    try {
      const result = readCanvas(JSON.parse(readFileSync(path, 'utf8')))
      if (result.mode === 'readonly') throw new Error(`Readonly unsupported Ready schema ${result.schemaVersion}`)
    } catch (error) {
      reason = Array.isArray(error.issues) ? error.issues.map(issue => `${issue.path.join('.') || 'canvas'}: ${issue.message}`).join('; ') : error.message
    }
    const passed = reject ? reason !== undefined : reason === undefined
    console.log(`${passed ? 'PASS' : 'FAIL'} ${path}${reason ? `: ${reason}` : ''}`)
    if (!passed) failures++
  }
  console.log(`canvas-format: ${inputs.length - failures}/${inputs.length} ${reject ? 'rejected as expected' : 'valid'}`)
  process.exitCode = failures ? 1 : 0
} catch (error) { console.error(error.message); process.exitCode = 1 }
