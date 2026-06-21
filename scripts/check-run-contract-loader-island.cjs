#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
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

function hasAnyImport(text, moduleNames) {
  return moduleNames.some((moduleName) => hasNodeImport(text, moduleName))
}

function check({ root = ROOT } = {}) {
  const errors = []
  let runText = ''
  let loaderText = ''

  try {
    runText = stripComments(read(root, RUN_CONTRACTS_REL))
  } catch (error) {
    errors.push(`missing_run_contracts:${RUN_CONTRACTS_REL}:${error.message}`)
  }

  try {
    loaderText = stripComments(read(root, LOADER_REL))
  } catch (error) {
    errors.push(`missing_loader:${LOADER_REL}:${error.message}`)
  }

  if (runText) {
    if (hasAnyImport(runText, ['node:fs', 'fs'])) {
      errors.push(`run_contracts_imports_node_fs:${RUN_CONTRACTS_REL}`)
    }
    if (hasAnyImport(runText, ['node:path', 'path'])) {
      errors.push(`run_contracts_imports_node_path:${RUN_CONTRACTS_REL}`)
    }
    if (/\bexport\s+function\s+loadSkillRunContract\b/.test(runText)) {
      errors.push(`run_contracts_defines_loadSkillRunContract:${RUN_CONTRACTS_REL}`)
    }
    if (/\bexport\s+function\s+buildContractFramePatch\b/.test(runText)) {
      errors.push(`run_contracts_defines_buildContractFramePatch:${RUN_CONTRACTS_REL}`)
    }
    if (!/\bexport\s+type\s*\{[^}]*\bLoadSkillRunContractParams\b[^}]*\}\s+from\s+['"]\.\/skill-run-contract-loader['"]/.test(runText)) {
      errors.push(`run_contracts_missing_loader_type_reexport:${RUN_CONTRACTS_REL}`)
    }
    if (!/\bexport\s*\{(?=[^}]*\bbuildContractFramePatch\b)(?=[^}]*\bloadSkillRunContract\b)[^}]*\}\s+from\s+['"]\.\/skill-run-contract-loader['"]/.test(runText)) {
      errors.push(`run_contracts_missing_loader_value_reexport:${RUN_CONTRACTS_REL}`)
    }
  }

  if (loaderText) {
    if (!hasNodeImport(loaderText, 'node:fs')) {
      errors.push(`loader_missing_node_fs_import:${LOADER_REL}`)
    }
    if (!hasNodeImport(loaderText, 'node:path')) {
      errors.push(`loader_missing_node_path_import:${LOADER_REL}`)
    }
    if (!/\bexport\s+interface\s+LoadSkillRunContractParams\b/.test(loaderText)) {
      errors.push(`loader_missing_LoadSkillRunContractParams_export:${LOADER_REL}`)
    }
    if (!/\bexport\s+function\s+loadSkillRunContract\b/.test(loaderText)) {
      errors.push(`loader_missing_loadSkillRunContract_export:${LOADER_REL}`)
    }
    if (!/\bexport\s+function\s+buildContractFramePatch\b/.test(loaderText)) {
      errors.push(`loader_missing_buildContractFramePatch_export:${LOADER_REL}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-run-contract-loader-island] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-run-contract-loader-island] OK')
}

module.exports = { check }
