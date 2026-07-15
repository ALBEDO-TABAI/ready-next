#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(
  ROOT,
  'src/main/modules/agent-control/runtime-core/agent-sdk-skill-intent-utils.ts',
)
const DETACHED = ['skill_start_detached', 'skill_inspect_detached', 'skill_cancel_detached']

function fail(message) {
  console.error(`[check-detached-primitive-not-exposed] FAIL: ${message}`)
  process.exit(1)
}

const source = fs.readFileSync(FILE, 'utf8')
const match = source.match(/const safeSkillPrimitives = new Set\(\[[\s\S]*?\]\)/)
if (!match) fail('safeSkillPrimitives set not found')
for (const name of DETACHED) {
  if (match[0].includes(name)) fail(`${name} must not be exposed as a safe SDK primitive`)
}
console.log('[check-detached-primitive-not-exposed] OK')
