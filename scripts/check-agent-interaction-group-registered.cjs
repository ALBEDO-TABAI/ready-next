#!/usr/bin/env node
/**
 * `agent_interaction` capability group is registered end-to-end.
 *
 * Mirrors `check-mcp-group-registered.cjs` for the main-agent reflection tool
 * group (`ask_user_questions`). Three sub-checks:
 *   (a) `CapabilityGroupId` union includes `'agent_interaction'`.
 *   (b) `CAPABILITY_GROUPS` array contains a complete entry with
 *       label / description / exposure / availability / defaultMode /
 *       defaultProfiles / executionKinds / settingsVisible.
 *   (c) `tool-registry.ts::GROUP_TOOL_PROVIDERS` registers an
 *       `agent_interaction:` provider.
 *   (d) `tool-parallelism-policy.ts::ToolResourceTag.domain` union
 *       contains `'agent_interaction'`.
 *   (e) `tool-definition.ts::ToolDomain` union contains `'agent_interaction'`.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const GROUPS_FILE = 'src/shared/ai-capability-groups.ts'
const REGISTRY_FILE = 'src/main/modules/agent-control/tools-runtime/tool-registry.ts'
const PARALLELISM_FILE = 'src/main/modules/agent-control/tools-runtime/tool-parallelism-policy.ts'
const TOOL_DEFINITION_FILE = 'src/main/modules/agent-control/tools-runtime/tool-definition.ts'

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []

  const groupsSrc = read(GROUPS_FILE)
  if (!groupsSrc) {
    violations.push({ file: GROUPS_FILE, reason: 'missing file' })
  } else {
    if (!/CapabilityGroupId\s*=\s*[\s\S]*?\|\s*['"]agent_interaction['"]/.test(groupsSrc)) {
      violations.push({
        file: GROUPS_FILE,
        reason: "CapabilityGroupId union must include 'agent_interaction'",
      })
    }
    const entryRegex = /\{\s*[\s\S]*?id:\s*['"]agent_interaction['"][\s\S]*?\}/
    const entryMatch = groupsSrc.match(entryRegex)
    if (!entryMatch) {
      violations.push({
        file: GROUPS_FILE,
        reason: "CAPABILITY_GROUPS must contain an entry with `id: 'agent_interaction'`",
      })
    } else {
      const entry = entryMatch[0]
      const requiredFields = [
        'label',
        'description',
        'exposure',
        'availability',
        'defaultMode',
        'defaultProfiles',
        'executionKinds',
        'settingsVisible',
      ]
      for (const field of requiredFields) {
        if (!new RegExp(`\\b${field}\\s*:`).test(entry)) {
          violations.push({
            file: GROUPS_FILE,
            reason: `'agent_interaction' entry missing required field: ${field}`,
          })
        }
      }
    }
  }

  const registrySrc = read(REGISTRY_FILE)
  if (!registrySrc) {
    violations.push({ file: REGISTRY_FILE, reason: 'missing file' })
  } else if (!/agent_interaction\s*:\s*\{/.test(registrySrc)) {
    violations.push({
      file: REGISTRY_FILE,
      reason: "GROUP_TOOL_PROVIDERS must register an 'agent_interaction:' provider",
    })
  }

  const parallelismSrc = read(PARALLELISM_FILE)
  if (!parallelismSrc) {
    violations.push({ file: PARALLELISM_FILE, reason: 'missing file' })
  } else if (!/domain:\s*[\s\S]*?['"]agent_interaction['"]/.test(parallelismSrc)) {
    violations.push({
      file: PARALLELISM_FILE,
      reason: "ToolResourceTag.domain union must include 'agent_interaction'",
    })
  }

  const toolDefSrc = read(TOOL_DEFINITION_FILE)
  if (!toolDefSrc) {
    violations.push({ file: TOOL_DEFINITION_FILE, reason: 'missing file' })
  } else if (!/ToolDomain\s*=\s*[\s\S]*?\|\s*['"]agent_interaction['"]/.test(toolDefSrc)) {
    violations.push({
      file: TOOL_DEFINITION_FILE,
      reason: "ToolDomain union must include 'agent_interaction'",
    })
  }

  if (violations.length === 0) {
    console.log('[check-agent-interaction-group-registered] OK')
    process.exit(0)
  }
  console.error('[check-agent-interaction-group-registered] FAIL:')
  for (const v of violations) {
    console.error(`  - ${v.file}: ${v.reason}`)
  }
  process.exit(1)
}

main()
