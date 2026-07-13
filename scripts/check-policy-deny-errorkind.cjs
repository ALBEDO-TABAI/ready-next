#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const root = process.cwd()
// 2026-07-13 同步：runtime 侧 allowedToolNames 预检位于模型循环；
// orchestrator 只负责编排，不再承载 tool-call 预检。
const files = [
  'src/main/modules/tools/tool-executor.ts',
  'src/main/modules/agent-control/runtime-core/agent-sdk-turn-model-loop.ts',
]

let failed = false

for (const rel of files) {
  const abs = path.join(root, rel)
  const source = fs.readFileSync(abs, 'utf8')
  const nestedPolicy = /errorKind:\s*['"]host_unavailable['"][\s\S]{0,180}?reason:\s*['"](tool_restricted_this_turn|internal_tool_not_allowed)['"]/
  const nestedPolicyReverse = /reason:\s*['"](tool_restricted_this_turn|internal_tool_not_allowed)['"][\s\S]{0,180}?errorKind:\s*['"]host_unavailable['"]/
  if (nestedPolicy.test(source) || nestedPolicyReverse.test(source)) {
    console.error(`[check-policy-deny-errorkind] FAIL — ${rel} nests policy denial under host_unavailable.`)
    failed = true
  }
}

const executor = fs.readFileSync(path.join(root, 'src/main/modules/tools/tool-executor.ts'), 'utf8')
if (!/errorKind:\s*TOOL_ADMISSION_ERROR_KINDS\.internalToolNotAllowed\.code/.test(executor)) {
  console.error('[check-policy-deny-errorkind] FAIL — internal_tool_not_allowed must be a top-level errorKind in tool-executor.')
  failed = true
}
if (!/errorKind:\s*TOOL_ADMISSION_ERROR_KINDS\.toolRestrictedThisTurn\.code/.test(executor)) {
  console.error('[check-policy-deny-errorkind] FAIL — tool_restricted_this_turn must be a top-level errorKind in tool-executor.')
  failed = true
}

const runtime = fs.readFileSync(path.join(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-turn-model-loop.ts'), 'utf8')
if (!/errorKind:\s*TOOL_ADMISSION_ERROR_KINDS\.toolRestrictedThisTurn\.code/.test(runtime)) {
  console.error('[check-policy-deny-errorkind] FAIL — tool_restricted_this_turn must be a top-level errorKind in the SDK runtime preflight.')
  failed = true
}

if (failed) process.exit(1)
console.log('[check-policy-deny-errorkind] OK')
