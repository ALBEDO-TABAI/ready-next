#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/skill-parent-force-fence.ts'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function importSources(text) {
  const sources = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text)) !== null) {
      sources.push(match[1])
    }
  }
  return sources
}

function hasImportContaining(text, fragment) {
  return importSources(text).some((source) => source.includes(fragment))
}

function check({ root = ROOT } = {}) {
  const errors = []
  let runText = ''
  let islandText = ''

  try {
    runText = stripComments(read(root, RUN_CONTRACTS_REL))
  } catch (error) {
    errors.push(`missing_run_contracts:${RUN_CONTRACTS_REL}:${error.message}`)
  }

  try {
    islandText = stripComments(read(root, ISLAND_REL))
  } catch (error) {
    errors.push(`missing_parent_force_island:${ISLAND_REL}:${error.message}`)
  }

  if (runText) {
    if (/\bfunction\s+shouldParentForceLongSkillTool\b/.test(runText)) {
      errors.push(`run_contracts_defines_shouldParentForceLongSkillTool:${RUN_CONTRACTS_REL}`)
    }
    if (/\bfunction\s+isParentForceForbiddenByManifest\b/.test(runText)) {
      errors.push(`run_contracts_defines_isParentForceForbiddenByManifest:${RUN_CONTRACTS_REL}`)
    }
    for (const fragment of ['skills-tools-static', 'skills-tools', 'child-loop-skill-actions']) {
      if (hasImportContaining(runText, fragment)) {
        errors.push(`run_contracts_imports_${fragment}:${RUN_CONTRACTS_REL}`)
      }
    }
    if (!/\bexport\s*\{(?=[^}]*\bshouldParentForceLongSkillTool\b)(?=[^}]*\bisParentForceForbiddenByManifest\b)[^}]*\}\s+from\s+['"]\.\/skill-parent-force-fence['"]/.test(runText)) {
      errors.push(`run_contracts_missing_parent_force_reexport:${RUN_CONTRACTS_REL}`)
    }
  }

  if (islandText) {
    if (!/\bexport\s+function\s+shouldParentForceLongSkillTool\b/.test(islandText)) {
      errors.push(`island_missing_shouldParentForceLongSkillTool_export:${ISLAND_REL}`)
    }
    if (!/\bexport\s+function\s+isParentForceForbiddenByManifest\b/.test(islandText)) {
      errors.push(`island_missing_isParentForceForbiddenByManifest_export:${ISLAND_REL}`)
    }
    if (!/\bimport\s*\{[^}]*\bSTATIC_SKILL_ACTIONS_BY_TOOL_NAME\b[^}]*\}\s+from\s+['"][^'"]*skills-tools-static['"]/.test(islandText)) {
      errors.push(`island_missing_static_skill_actions_import:${ISLAND_REL}`)
    }
    if (!/\bimport\s*\{[^}]*\bisConfiguredChildLoopSkillAction\b[^}]*\}\s+from\s+['"][^'"]*child-loop-skill-actions['"]/.test(islandText)) {
      errors.push(`island_missing_child_loop_action_import:${ISLAND_REL}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-run-contract-parent-force-island] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-run-contract-parent-force-island] OK')
}

module.exports = { check }
