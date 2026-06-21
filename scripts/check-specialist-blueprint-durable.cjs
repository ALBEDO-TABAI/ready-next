#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUNTIME = 'src/main/modules/agent-control/agents/specialist-blueprint-runtime.ts'

function fail(message) {
  console.error(`[check-specialist-blueprint-durable] FAIL: ${message}`)
  process.exit(1)
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
}

const source = read(RUNTIME)
const compact = source.replace(/\s+/g, '')

if (/new\s+SpecialistBlueprintStore\s*\(\s*\)/.test(source)) {
  fail('runtime must not construct a bare SpecialistBlueprintStore')
}

if (/new\s+SpecialistBlueprintConfirmationStore\s*\(\s*\)/.test(source)) {
  fail('runtime must not construct a bare SpecialistBlueprintConfirmationStore')
}

for (const required of [
  "import{getDatabase}from'../../database'",
  'newSpecialistBlueprintStore({getRawDb:()=>getDatabase().getRawDb(),})',
  'newSpecialistBlueprintConfirmationStore({getRawDb:()=>getDatabase().getRawDb(),})',
]) {
  if (!compact.includes(required)) {
    fail(`runtime missing DB-backed wiring: ${required}`)
  }
}

console.log('[check-specialist-blueprint-durable] OK')
