#!/usr/bin/env node
/**
 * P2-2 — `skill_activation` capability group (`use_skill`) is registered end-to-end.
 *
 * Mirrors `check-agent-interaction-group-registered.cjs`. Typecheck already forces the
 * GROUP_TOOL_PROVIDERS Record entry and the domain-union casts, but it CANNOT catch a
 * missing CAPABILITY_GROUPS entry (the resolver silently skips an id with no entry → no
 * exposure) nor a missing dispatch case (→ runtime "Unknown tool"). This gate closes both:
 *   (a) CapabilityGroupId union includes 'skill_activation'.
 *   (b) CAPABILITY_GROUPS has a complete 'skill_activation' entry (all 8 fields).
 *   (c) GROUP_TOOL_PROVIDERS registers a 'skill_activation:' provider.
 *   (d) ToolResourceTag.domain union includes 'skill_activation' + getToolResourceTag maps use_skill.
 *   (e) ToolDomain union includes 'skill_activation'.
 *   (f) tool-executor.ts dispatch has `case 'skill_activation':` routed to executeUseSkill.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const GROUPS_FILE = 'src/shared/ai-capability-groups.ts'
const REGISTRY_FILE = 'src/main/modules/agent-control/tools-runtime/tool-registry.ts'
const PARALLELISM_FILE = 'src/main/modules/agent-control/tools-runtime/tool-parallelism-policy.ts'
const TOOL_DEFINITION_FILE = 'src/main/modules/agent-control/tools-runtime/tool-definition.ts'
const EXECUTOR_FILE = 'src/main/modules/tools/tool-executor.ts'

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
    if (!/CapabilityGroupId\s*=\s*[\s\S]*?\|\s*['"]skill_activation['"]/.test(groupsSrc)) {
      violations.push({ file: GROUPS_FILE, reason: "CapabilityGroupId union must include 'skill_activation'" })
    }
    const entryMatch = groupsSrc.match(/\{\s*[\s\S]*?id:\s*['"]skill_activation['"][\s\S]*?\}/)
    if (!entryMatch) {
      violations.push({ file: GROUPS_FILE, reason: "CAPABILITY_GROUPS must contain an entry with `id: 'skill_activation'`" })
    } else {
      for (const field of ['label', 'description', 'exposure', 'availability', 'defaultMode', 'defaultProfiles', 'executionKinds', 'settingsVisible']) {
        if (!new RegExp(`\\b${field}\\s*:`).test(entryMatch[0])) {
          violations.push({ file: GROUPS_FILE, reason: `'skill_activation' entry missing required field: ${field}` })
        }
      }
    }
  }

  const registrySrc = read(REGISTRY_FILE)
  if (!registrySrc) {
    violations.push({ file: REGISTRY_FILE, reason: 'missing file' })
  } else if (!/skill_activation\s*:\s*\{/.test(registrySrc)) {
    violations.push({ file: REGISTRY_FILE, reason: "GROUP_TOOL_PROVIDERS must register a 'skill_activation:' provider" })
  }

  const parallelismSrc = read(PARALLELISM_FILE)
  if (!parallelismSrc) {
    violations.push({ file: PARALLELISM_FILE, reason: 'missing file' })
  } else {
    if (!/domain:\s*[\s\S]*?['"]skill_activation['"]/.test(parallelismSrc)) {
      violations.push({ file: PARALLELISM_FILE, reason: "ToolResourceTag.domain union must include 'skill_activation'" })
    }
    if (!/['"]use_skill['"]\s*\)\s*return\s*\{\s*domain:\s*['"]skill_activation['"]/.test(parallelismSrc)) {
      violations.push({ file: PARALLELISM_FILE, reason: "getToolResourceTag must map 'use_skill' → domain 'skill_activation'" })
    }
  }

  const toolDefSrc = read(TOOL_DEFINITION_FILE)
  if (!toolDefSrc) {
    violations.push({ file: TOOL_DEFINITION_FILE, reason: 'missing file' })
  } else if (!/ToolDomain\s*=\s*[\s\S]*?\|\s*['"]skill_activation['"]/.test(toolDefSrc)) {
    violations.push({ file: TOOL_DEFINITION_FILE, reason: "ToolDomain union must include 'skill_activation'" })
  }

  const executorSrc = read(EXECUTOR_FILE)
  if (!executorSrc) {
    violations.push({ file: EXECUTOR_FILE, reason: 'missing file' })
  } else {
    if (!/case\s*['"]skill_activation['"]\s*:/.test(executorSrc)) {
      violations.push({ file: EXECUTOR_FILE, reason: "dispatch switch must have `case 'skill_activation':`" })
    }
    if (!/executeUseSkill\s*\(/.test(executorSrc)) {
      violations.push({ file: EXECUTOR_FILE, reason: "skill_activation case must route to executeUseSkill(" })
    }
  }

  if (violations.length === 0) {
    console.log('[check-skill-activation-group-registered] OK')
    process.exit(0)
  }
  console.error('[check-skill-activation-group-registered] FAIL:')
  for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`)
  process.exit(1)
}

main()
