#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/skill-run-contract.ts'
const LOADER_REL = 'src/main/modules/agent-control/contracts/skill-run-contract-loader.ts'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function hasNodeImport(text, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `\\bfrom\\s+['"]${escaped}['"]|\\brequire\\s*\\(\\s*['"]${escaped}['"]\\s*\\)|\\bimport\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`,
  ).test(text)
}

function hasSkillRunContractTypeReexport(runText) {
  return /\bexport\s+type\s*\{[^}]*\bSkillRunContract\b[^}]*\}\s+from\s+['"]\.\/skill-run-contract['"]/.test(runText)
}

function importsSkillRunContractFromRunContracts(loaderText) {
  const importPattern = /\bimport\s+type\s*\{([\s\S]*?)\}\s+from\s+['"]\.\/run-contracts['"]/gm
  let match
  while ((match = importPattern.exec(loaderText))) {
    const imports = match[1].split(',').map((part) => part.trim())
    if (imports.some((part) => /^SkillRunContract(?:\s+as\s+\w+)?$/.test(part))) {
      return true
    }
  }
  return false
}

function check({ root = ROOT } = {}) {
  const errors = []
  let runText = ''
  let islandText = ''
  let loaderText = ''

  try {
    runText = stripComments(read(root, RUN_CONTRACTS_REL))
  } catch (error) {
    errors.push(`missing_run_contracts:${RUN_CONTRACTS_REL}:${error.message}`)
  }

  try {
    islandText = stripComments(read(root, ISLAND_REL))
  } catch (error) {
    errors.push(`missing_skill_run_contract_island:${ISLAND_REL}:${error.message}`)
  }

  try {
    loaderText = stripComments(read(root, LOADER_REL))
  } catch (error) {
    errors.push(`missing_loader:${LOADER_REL}:${error.message}`)
  }

  if (runText) {
    if (/\bexport\s+interface\s+SkillRunContract\b/.test(runText)) {
      errors.push(`run_contracts_defines_SkillRunContract:${RUN_CONTRACTS_REL}`)
    }
    if (!hasSkillRunContractTypeReexport(runText)) {
      errors.push(`run_contracts_missing_SkillRunContract_type_reexport:${RUN_CONTRACTS_REL}`)
    }
  }

  if (islandText) {
    if (!/\bexport\s+interface\s+SkillRunContract\b/.test(islandText)) {
      errors.push(`island_missing_SkillRunContract_export:${ISLAND_REL}`)
    }

    for (const moduleName of ['node:fs', 'fs', 'node:path', 'path']) {
      if (hasNodeImport(islandText, moduleName)) {
        errors.push(`island_imports_${moduleName.replace(':', '_')}:${ISLAND_REL}`)
      }
    }

    if (/\b(?:export\s+)?function\s+loadSkillRunContract\b/.test(islandText)) {
      errors.push(`island_defines_loadSkillRunContract:${ISLAND_REL}`)
    }
    if (/\b(?:export\s+)?function\s+buildContractFramePatch\b/.test(islandText)) {
      errors.push(`island_defines_buildContractFramePatch:${ISLAND_REL}`)
    }
  }

  if (loaderText && importsSkillRunContractFromRunContracts(loaderText)) {
    errors.push(`loader_imports_SkillRunContract_from_run_contracts:${LOADER_REL}`)
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-run-contract-skill-contract-island] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-run-contract-skill-contract-island] OK')
}

module.exports = { check }
