#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/skills/skill-context-orchestrator.ts')
const DETACHED = ['skill_start_detached', 'skill_inspect_detached', 'skill_cancel_detached']

function fail(message) {
  console.error(`[check-reference-skill-detached-hint] FAIL: ${message}`)
  process.exit(1)
}

const source = fs.readFileSync(FILE, 'utf8')
const match = source.match(/const longTaskGuidance = childLoopToolNames\.length > 0[\s\S]*?\?\s*`[\s\S]*?`\s*:\s*(['"`])([\s\S]*?)\1/)
if (!match) fail('non-child-loop longTaskGuidance branch not found')
const nonChildLoopGuidance = match[2]
for (const name of DETACHED) {
  if (nonChildLoopGuidance.includes(name)) {
    fail(`non-child-loop reference guidance must not mention ${name}`)
  }
}
console.log('[check-reference-skill-detached-hint] OK')
