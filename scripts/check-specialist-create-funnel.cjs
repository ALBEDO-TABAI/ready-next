#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const failures = []
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
const read = (rel) => {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) {
    failures.push(`missing required historical audit file: ${rel}`)
    return ''
  }
  return fs.readFileSync(abs, 'utf8')
}

for (const rel of [
  'src/main/modules/tools/builtins/propose-specialist-blueprint.ts',
  'src/main/modules/tools/builtins/confirm-specialist-blueprint.ts',
  'src/main/modules/tools/builtins/rename-specialist-agent.ts',
  'src/main/modules/claude-bridge/ipc/agent-derivation-group.ts',
  'src/renderer/components/personality/AgentDerivationPanel.tsx',
  'src/renderer/components/personality/AgentRegistryPanel.tsx',
]) {
  if (exists(rel)) failures.push(`retired live specialist surface still exists: ${rel}`)
}

const retiredToolPattern = /propose_specialist_blueprint|confirm_specialist_blueprint|rename_specialist_agent/
for (const rel of [
  'src/main/modules/tools/agent-interaction-tool-defs.ts',
  'src/main/modules/tools/schemas/agent-interaction-schemas.ts',
  'src/main/modules/tools/tool-executor.ts',
]) {
  if (retiredToolPattern.test(read(rel))) failures.push(`retired specialist tool remains callable from ${rel}`)
}

const defs = read('src/main/modules/tools/agent-interaction-tool-defs.ts')
for (const retained of ['ask_user_questions', 'declare_completion_criteria']) {
  if (!defs.includes(`'${retained}'`)) failures.push(`retained Agent interaction tool is missing: ${retained}`)
}

const blueprintGroup = read('src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts')
if (!blueprintGroup.includes("'agent:specialistBlueprint:list'")) failures.push('historical blueprint list IPC is missing')
if (/upsertDraft|runAdmission|requestConfirmation|confirmCreate|agent:specialistBlueprint:(?:reject|expire)/.test(blueprintGroup)) {
  failures.push('historical blueprint IPC still exposes mutation or creation')
}

const registryGroup = read('src/main/modules/claude-bridge/ipc/agent-registry-group.ts')
for (const retained of ['agent:registry:list', 'agent:registry:listKnowledge']) {
  if (!registryGroup.includes(`'${retained}'`)) failures.push(`historical registry read IPC is missing: ${retained}`)
}
if (/agent:registry:(?:updateStatus|delete|create)|registry\.(?:create|update|delete)\s*\(/.test(registryGroup)) {
  failures.push('historical registry IPC still exposes mutation')
}

const preload = read('src/preload/index.ts')
if (!preload.includes('listSpecialistBlueprints')) failures.push('historical blueprint read API is missing')
if (!preload.includes('listRegistry')) failures.push('historical registry read API is missing')
if (/proposeSpecialistBlueprint|confirmSpecialistBlueprint|renameSpecialistAgent|confirmDerivation|rejectDerivation|updateRegistryStatus|deleteRegistryAgent/.test(preload)) {
  failures.push('renderer preload still exposes specialist mutation')
}

read('src/shared/agent-specialist-blueprint.ts')
read('src/main/modules/agent-control/agents/specialist-blueprint-store.ts')

if (failures.length > 0) {
  console.error(`[check-specialist-create-funnel] FAIL: ${failures.join('\n')}`)
  process.exit(1)
}
console.log('[check-specialist-create-funnel] OK: live creation retired; historical audit retained')
