#!/usr/bin/env node
/**
 * Stage T PR-T5 — `mcp` capability group is registered end-to-end.
 *
 * Three sub-checks:
 *   (a) `CapabilityGroupId` union includes `'mcp'`.
 *   (b) `CAPABILITY_GROUPS` array contains a complete `id: 'mcp'` entry
 *       (label / description / exposure / availability / defaultMode /
 *        defaultProfiles / executionKinds / settingsVisible).
 *   (c) `tool-registry.ts::GROUP_TOOL_PROVIDERS` registers an `mcp:` entry.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const GROUPS_FILE = 'src/shared/ai-capability-groups.ts'
const REGISTRY_FILE = 'src/main/modules/agent-control/tools-runtime/tool-registry.ts'

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
    if (!/CapabilityGroupId\s*=\s*[\s\S]*?\|\s*['"]mcp['"]/.test(groupsSrc)) {
      violations.push({
        file: GROUPS_FILE,
        reason: "CapabilityGroupId union must include 'mcp'",
      })
    }
    // Check that the entry has all required fields.
    const entryRegex = /\{\s*[\s\S]*?id:\s*['"]mcp['"][\s\S]*?\}/
    const entryMatch = groupsSrc.match(entryRegex)
    if (!entryMatch) {
      violations.push({
        file: GROUPS_FILE,
        reason: 'CAPABILITY_GROUPS must contain an entry with `id: \'mcp\'`',
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
            reason: `mcp group entry missing field \`${field}\``,
          })
        }
      }
      if (!/exposure:\s*['"]model_visible['"]/.test(entry)) {
        violations.push({
          file: GROUPS_FILE,
          reason: "mcp group entry must set `exposure: 'model_visible'`",
        })
      }
      if (!/defaultProfiles:\s*\[[^\]]*['"]local_chat['"]/.test(entry)) {
        violations.push({
          file: GROUPS_FILE,
          reason: "mcp group entry must include 'local_chat' in defaultProfiles",
        })
      }
    }
  }

  const registrySrc = read(REGISTRY_FILE)
  if (!registrySrc) {
    violations.push({ file: REGISTRY_FILE, reason: 'missing file' })
  } else {
    // GROUP_TOOL_PROVIDERS object literal must have an mcp: entry.
    if (!/GROUP_TOOL_PROVIDERS\s*:[\s\S]*?\{[\s\S]*?\bmcp\s*:\s*\{/.test(registrySrc)) {
      violations.push({
        file: REGISTRY_FILE,
        reason: 'GROUP_TOOL_PROVIDERS must contain an `mcp:` entry',
      })
    }
  }

  if (violations.length > 0) {
    console.error('[check-mcp-group-registered] FAIL:')
    for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`)
    process.exit(1)
  }
  console.log('[check-mcp-group-registered] OK')
}

main()
