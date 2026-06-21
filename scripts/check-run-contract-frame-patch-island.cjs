#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/skill-frame-patch-tool-names.ts'

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
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
    errors.push(`missing_frame_patch_island:${ISLAND_REL}:${error.message}`)
  }

  if (runText) {
    if (/\bconst\s+FRAME_PATCH_EMITTING_TOOL_NAMES\b/.test(runText)) {
      errors.push(`run_contracts_defines_FRAME_PATCH_EMITTING_TOOL_NAMES:${RUN_CONTRACTS_REL}`)
    }
    if (/\bfunction\s+isFramePatchEmittingToolName\b/.test(runText)
      || /\b(?:const|let|var)\s+isFramePatchEmittingToolName\b/.test(runText)) {
      errors.push(`run_contracts_defines_isFramePatchEmittingToolName:${RUN_CONTRACTS_REL}`)
    }
    if (!/\bexport\s*\{(?=[^}]*\bFRAME_PATCH_EMITTING_TOOL_NAMES\b)(?=[^}]*\bisFramePatchEmittingToolName\b)[^}]*\}\s+from\s+['"]\.\/skill-frame-patch-tool-names['"]/.test(runText)) {
      errors.push(`run_contracts_missing_frame_patch_reexport:${RUN_CONTRACTS_REL}`)
    }
  }

  if (islandText) {
    if (!/\bexport\s+const\s+FRAME_PATCH_EMITTING_TOOL_NAMES\b/.test(islandText)) {
      errors.push(`island_missing_FRAME_PATCH_EMITTING_TOOL_NAMES_export:${ISLAND_REL}`)
    }
    if (!/\bexport\s+function\s+isFramePatchEmittingToolName\b/.test(islandText)) {
      errors.push(`island_missing_isFramePatchEmittingToolName_export:${ISLAND_REL}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-run-contract-frame-patch-island] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-run-contract-frame-patch-island] OK')
}

module.exports = { check }
