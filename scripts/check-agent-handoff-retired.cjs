#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const failures = []
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

for (const rel of [
  'src/main/modules/agent-control/agents/handoff-proposal.ts',
  'src/main/modules/agent-control/agents/handoff-adoption-transaction.ts',
  'src/main/modules/agent-control/agents/handoff-control.ts',
  'src/main/modules/agent-control/agents/handoff-takeover-recovery.ts',
  'src/main/modules/tools/builtins/propose-handoff.ts',
]) {
  if (fs.existsSync(path.join(ROOT, rel))) failures.push(`retired Agent handoff file returned: ${rel}`)
}

const forbidden = /agent_propose_handoff|adoptSameSessionHandoff|runWithHandoffToolGate|codex_handoff_requires_native_terminal_reconciliation/
for (const rel of [
  'src/main/modules/tools/agent-interaction-tool-defs.ts',
  'src/main/modules/tools/schemas/agent-interaction-schemas.ts',
  'src/main/modules/tools/tool-executor.ts',
  'src/main/modules/agent-control/runtime-core/runtime.ts',
  'src/preload/index.ts',
  'src/renderer/types/electron.d.ts',
]) {
  if (forbidden.test(read(rel))) failures.push(`retired Agent handoff remains callable from ${rel}`)
}

for (const rel of [
  'src/main/modules/agent-control/skills/skill-agent-handoff.ts',
  'src/main/modules/agent-control/skills/skill-handoff-completion.ts',
  'src/main/modules/tools/skill-primitives/write-artifact.ts',
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) failures.push(`retained skill artifact handoff is missing: ${rel}`)
}

if (failures.length > 0) {
  console.error(`[check-agent-handoff-retired] FAIL\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('[check-agent-handoff-retired] OK: live Agent handoff retired; skill artifact handoff retained')
