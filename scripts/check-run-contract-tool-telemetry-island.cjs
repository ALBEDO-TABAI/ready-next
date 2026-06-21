#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/tool-telemetry-contracts.ts'
const TURN_RESPONSE_REL = 'src/main/modules/agent-control/contracts/turn-response-contracts.ts'

const TELEMETRY_EXPORTS = [
  'RecoveryRecord',
  'ToolSnapshot',
]

const DO_NOT_MOVE_INTO_ISLAND = [
  'TaskInteractionState',
  'TurnEngineHost',
  'TurnEngineSession',
  'TaskProjectionRecord',
  'UnifiedTaskState',
  'TaskBudget',
]

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function declarationPattern(name) {
  return new RegExp(`\\b(?:export\\s+)?(?:interface|type|class|const|function)\\s+${name}\\b`)
}

function exportedTypeDeclarationPattern(name) {
  return new RegExp(`\\bexport\\s+(?:interface|type)\\s+${name}\\b`)
}

function hasNodeImport(text, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `\\bfrom\\s+['"]${escaped}['"]|\\brequire\\s*\\(\\s*['"]${escaped}['"]\\s*\\)|\\bimport\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`,
  ).test(text)
}

function parseTelemetryTypeReexport(runText) {
  const pattern = /\bexport\s+type\s*\{([^}]*)\}\s+from\s+['"]\.\/tool-telemetry-contracts['"]/m
  const match = runText.match(pattern)
  if (!match) return null
  return match[1].split(',').map((part) => part.trim()).filter(Boolean)
}

function hasTelemetryValueReexport(runText) {
  return /\bexport\s*\{[\s\S]*?\}\s+from\s+['"]\.\/tool-telemetry-contracts['"]/m.test(runText)
}

function hasRunContractsImport(islandText) {
  return (
    /\bfrom\s+['"]\.\/run-contracts(?:\.ts)?['"]/.test(islandText)
    || /\brequire\s*\(\s*['"]\.\/run-contracts(?:\.ts)?['"]\s*\)/.test(islandText)
    || /\bimport\s*\(\s*['"]\.\/run-contracts(?:\.ts)?['"]\s*\)/.test(islandText)
  )
}

function importedNamesFromRunContracts(text) {
  const names = new Set()
  const importPattern = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]\.\/run-contracts(?:\.ts)?['"]/g
  let match = importPattern.exec(text)
  while (match) {
    for (const rawPart of match[1].split(',')) {
      const part = rawPart.trim().replace(/^type\s+/, '')
      if (!part) continue
      const baseName = part.split(/\s+as\s+/i)[0]?.trim()
      if (baseName) names.add(baseName)
    }
    match = importPattern.exec(text)
  }

  const qualifiedPattern = /\bimport\s*\(\s*['"]\.\/run-contracts(?:\.ts)?['"]\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g
  match = qualifiedPattern.exec(text)
  while (match) {
    names.add(match[1])
    match = qualifiedPattern.exec(text)
  }

  const namespaceImportPattern = /\bimport\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\.\/run-contracts(?:\.ts)?['"]/g
  match = namespaceImportPattern.exec(text)
  while (match) {
    const alias = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const name of TELEMETRY_EXPORTS) {
      if (new RegExp(`\\b${alias}\\s*\\.\\s*${name}\\b`).test(text)) {
        names.add(name)
      }
    }
    match = namespaceImportPattern.exec(text)
  }

  return names
}

function check({ root = ROOT } = {}) {
  const errors = []
  let runText = ''
  let islandText = ''
  let turnResponseText = ''

  try {
    runText = stripComments(read(root, RUN_CONTRACTS_REL))
  } catch (error) {
    errors.push(`missing_run_contracts:${RUN_CONTRACTS_REL}:${error.message}`)
  }

  try {
    islandText = stripComments(read(root, ISLAND_REL))
  } catch (error) {
    errors.push(`missing_tool_telemetry_island:${ISLAND_REL}:${error.message}`)
  }

  try {
    turnResponseText = stripComments(read(root, TURN_RESPONSE_REL))
  } catch (error) {
    errors.push(`missing_turn_response_island:${TURN_RESPONSE_REL}:${error.message}`)
  }

  if (runText) {
    for (const name of TELEMETRY_EXPORTS) {
      if (declarationPattern(name).test(runText)) {
        errors.push(`run_contracts_defines_${name}:${RUN_CONTRACTS_REL}`)
      }
    }

    const reexports = parseTelemetryTypeReexport(runText)
    if (!reexports) {
      errors.push(`run_contracts_missing_tool_telemetry_type_reexport:${RUN_CONTRACTS_REL}`)
    } else {
      for (const name of TELEMETRY_EXPORTS) {
        if (!reexports.includes(name)) {
          errors.push(`run_contracts_reexport_missing_${name}:${RUN_CONTRACTS_REL}`)
        }
      }
    }

    if (hasTelemetryValueReexport(runText)) {
      errors.push(`run_contracts_value_reexports_tool_telemetry_contracts:${RUN_CONTRACTS_REL}`)
    }
  }

  if (islandText) {
    for (const name of TELEMETRY_EXPORTS) {
      if (!exportedTypeDeclarationPattern(name).test(islandText)) {
        errors.push(`island_missing_${name}_export:${ISLAND_REL}`)
      }
    }

    for (const moduleName of ['node:fs', 'fs', 'node:path', 'path']) {
      if (hasNodeImport(islandText, moduleName)) {
        errors.push(`island_imports_${moduleName.replace(':', '_')}:${ISLAND_REL}`)
      }
    }

    if (hasRunContractsImport(islandText)) {
      errors.push(`island_imports_run_contracts:${ISLAND_REL}`)
    }

    for (const name of DO_NOT_MOVE_INTO_ISLAND) {
      if (declarationPattern(name).test(islandText)) {
        errors.push(`island_defines_do_not_move_${name}:${ISLAND_REL}`)
      }
    }
  }

  if (turnResponseText) {
    const importedNames = importedNamesFromRunContracts(turnResponseText)
    for (const name of TELEMETRY_EXPORTS) {
      if (importedNames.has(name)) {
        errors.push(`turn_response_imports_${name}_from_run_contracts:${TURN_RESPONSE_REL}`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-run-contract-tool-telemetry-island] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-run-contract-tool-telemetry-island] OK')
}

module.exports = { check }
