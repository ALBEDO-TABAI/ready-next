#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/turn-response-contracts.ts'

const TURN_RESPONSE_EXPORTS = [
  'TurnProviderContext',
  'TurnSimpleResponse',
  'TurnToolCall',
  'TurnToolExecutionResult',
  'TurnToolBatchResult',
  'TurnToolCallParseError',
  'TurnModelResponse',
  'TurnShortcutResult',
]

const DO_NOT_MOVE_LEAVES = [
  'RecoveryRecord',
  'ToolSnapshot',
  'TaskInteractionState',
  'TurnEngineHost',
  'TurnEngineRequest',
  'RunMessage',
  'TurnEngineSession',
]

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

function declarationPattern(name) {
  return new RegExp(`\\b(?:export\\s+)?(?:interface|type|class|const|function)\\s+${name}\\b`)
}

function exportedTypeDeclarationPattern(name) {
  return new RegExp(`\\bexport\\s+(?:interface|type)\\s+${name}\\b`)
}

function parseTurnResponseTypeReexport(runText) {
  const pattern = /\bexport\s+type\s*\{([\s\S]*?)\}\s+from\s+['"]\.\/turn-response-contracts['"]/m
  const match = runText.match(pattern)
  if (!match) return null
  return match[1].split(',').map((part) => part.trim()).filter(Boolean)
}

function hasValueReexport(runText) {
  return /\bexport\s*\{[\s\S]*?\}\s+from\s+['"]\.\/turn-response-contracts['"]/m.test(runText)
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
    errors.push(`missing_turn_response_island:${ISLAND_REL}:${error.message}`)
  }

  if (runText) {
    for (const name of TURN_RESPONSE_EXPORTS) {
      if (declarationPattern(name).test(runText)) {
        errors.push(`run_contracts_defines_${name}:${RUN_CONTRACTS_REL}`)
      }
    }

    const reexports = parseTurnResponseTypeReexport(runText)
    if (!reexports) {
      errors.push(`run_contracts_missing_turn_response_type_reexport:${RUN_CONTRACTS_REL}`)
    } else {
      for (const name of TURN_RESPONSE_EXPORTS) {
        if (!reexports.includes(name)) {
          errors.push(`run_contracts_reexport_missing_${name}:${RUN_CONTRACTS_REL}`)
        }
      }
    }

    if (hasValueReexport(runText)) {
      errors.push(`run_contracts_value_reexports_turn_response_contracts:${RUN_CONTRACTS_REL}`)
    }
  }

  if (islandText) {
    for (const name of TURN_RESPONSE_EXPORTS) {
      if (!exportedTypeDeclarationPattern(name).test(islandText)) {
        errors.push(`island_missing_${name}_export:${ISLAND_REL}`)
      }
    }

    for (const moduleName of ['node:fs', 'fs', 'node:path', 'path']) {
      if (hasNodeImport(islandText, moduleName)) {
        errors.push(`island_imports_${moduleName.replace(':', '_')}:${ISLAND_REL}`)
      }
    }

    for (const name of DO_NOT_MOVE_LEAVES) {
      if (declarationPattern(name).test(islandText)) {
        errors.push(`island_defines_do_not_move_${name}:${ISLAND_REL}`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-run-contract-turn-response-island] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-run-contract-turn-response-island] OK')
}

module.exports = { check }
