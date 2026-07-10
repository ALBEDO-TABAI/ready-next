#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const RUNTIME_REL = 'src/main/modules/agent-control/runtime-core'
const FACADE_REL = `${RUNTIME_REL}/agent-sdk-utils.ts`
const ORCHESTRATOR_REL = `${RUNTIME_REL}/agent-sdk-turn-orchestrator.ts`
const PROVIDER_REL = `${RUNTIME_REL}/agent-sdk-provider.ts`
const LEAF_RELS = [
  'agent-sdk-document-utils.ts',
  'agent-sdk-execution-utils.ts',
  'agent-sdk-foundation-utils.ts',
  'agent-sdk-input-context-utils.ts',
  'agent-sdk-model-message-utils.ts',
  'agent-sdk-provider-utils.ts',
  'agent-sdk-runtime-outcome-utils.ts',
  'agent-sdk-skill-intent-utils.ts',
].map((name) => `${RUNTIME_REL}/${name}`)
const TURN_LEAF_RELS = [
  'agent-sdk-turn-closeout.ts',
  'agent-sdk-turn-completion.ts',
  'agent-sdk-turn-context.ts',
  'agent-sdk-turn-execution.ts',
  'agent-sdk-turn-guards.ts',
  'agent-sdk-turn-input-assembly.ts',
  'agent-sdk-turn-model-loop.ts',
  'agent-sdk-turn-preparation.ts',
].map((name) => `${RUNTIME_REL}/${name}`)

function read(rel, errors) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    errors.push(`${rel}: missing`)
    return ''
  }
  return fs.readFileSync(abs, 'utf8')
}

function lineCount(text) {
  return text ? text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) : 0
}

function enforceLineLimit(rel, limit, errors) {
  const count = lineCount(read(rel, errors))
  if (count > limit) errors.push(`${rel}: ${count} lines exceeds ${limit}`)
}

function main() {
  const errors = []
  const facade = read(FACADE_REL, errors)
  enforceLineLimit(FACADE_REL, 120, errors)
  const facadeStatements = facade
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (facadeStatements.some((line) => !/^export \* from '\.\/agent-sdk-[a-z-]+-utils'$/.test(line))) {
    errors.push(`${FACADE_REL}: compatibility facade may contain export-only leaf re-exports`)
  }

  for (const rel of [...LEAF_RELS, ...TURN_LEAF_RELS]) {
    const text = read(rel, errors)
    if (/from ['"]\.\/agent-sdk-utils['"]/.test(text)) {
      errors.push(`${rel}: leaf module must not import the compatibility facade`)
    }
    if (/from ['"]\.\/agent-sdk-turn-orchestrator['"]/.test(text)) {
      errors.push(`${rel}: leaf module must not depend back on the orchestrator`)
    }
    enforceLineLimit(rel, 900, errors)
  }

  const orchestrator = read(ORCHESTRATOR_REL, errors)
  enforceLineLimit(ORCHESTRATOR_REL, 1000, errors)
  for (const required of [
    'computeCapabilityFloors(',
    'enforceCapabilityFloors(',
    'toolDefinitions = floorEnforcement.definitions',
    'tool_surface_floor_violation',
  ]) {
    if (!orchestrator.includes(required)) {
      errors.push(`${ORCHESTRATOR_REL}: missing live arbitration invariant ${required}`)
    }
  }
  enforceLineLimit(PROVIDER_REL, 999, errors)

  if (errors.length > 0) {
    console.error('[check-agent-sdk-module-boundaries] FAIL')
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-agent-sdk-module-boundaries] OK')
}

main()
