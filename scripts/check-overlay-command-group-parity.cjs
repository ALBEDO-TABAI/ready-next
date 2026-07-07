#!/usr/bin/env node
'use strict'

// P3 guard (2026-07-07-vertical-tab-groups-and-reorder §9/§13): the browser rail's hover
// flyout is a SEPARATE child-window renderer that can only send VerticalRailOverlayCommand
// back to the main renderer; the main-side VerticalTabRail command switch is the sole place
// those land. If a group command variant is added to the protocol but the switch grows no
// matching `case`, the overlay button silently no-ops. This drift guard is FAIL-CLOSED:
// EVERY command `type` in the protocol union must have a `case` in the switch. It also
// asserts the reorder command is the id-based variant (D-CMD retired {fromIndex,toIndex}).

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

// Slice the `export type VerticalRailOverlayCommand = …` union up to the next top-level
// `export` (or EOF).
function sliceCommandUnion(source) {
  const match = /export type VerticalRailOverlayCommand\s*=/.exec(source)
  if (!match) return null
  const rest = source.slice(match.index + match[0].length)
  const nextTop = rest.search(/\nexport /)
  return nextTop === -1 ? rest : rest.slice(0, nextTop)
}

function check({ root = ROOT } = {}) {
  const errors = []
  const readAt = (rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'))

  const protocol = readAt('src/shared/browser-vertical-rail-overlay.ts')
  const rail = readAt('src/renderer/components/browser/VerticalTabRail.tsx')

  const union = sliceCommandUnion(protocol)
  if (union === null) {
    errors.push('command_union_not_found')
    return { ok: false, errors }
  }

  // Every command variant's discriminant string.
  const commandTypes = [...union.matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1])
  if (commandTypes.length === 0) errors.push('no_command_types_parsed')

  // Case labels in the main-renderer command switch.
  const caseLabels = new Set([...rail.matchAll(/case\s*'([^']+)'\s*:/g)].map((m) => m[1]))
  if (caseLabels.size === 0) errors.push('no_case_labels_parsed')

  // Forward parity: every protocol command must be handled.
  for (const type of commandTypes) {
    if (!caseLabels.has(type)) errors.push(`command_without_handler:${type}`)
  }

  // The group ops must all be present in the protocol (so a partial retirement can't
  // shrink the surface unnoticed).
  const REQUIRED_GROUP_COMMANDS = [
    'reorder', 'create-group', 'add-to-group', 'remove-from-group', 'rename-group',
    'recolor-group', 'set-group-collapsed', 'disband-group', 'delete-group', 'new-tab-in-group',
  ]
  for (const type of REQUIRED_GROUP_COMMANDS) {
    if (!commandTypes.includes(type)) errors.push(`group_command_missing_from_protocol:${type}`)
  }

  // D-CMD: reorder is id-based. The old index variant must be gone from the protocol.
  if (/type:\s*'reorder'[^}]*fromIndex/.test(union)) errors.push('reorder_still_index_based')
  if (!/type:\s*'reorder'[^}]*movedTabId/.test(union)) errors.push('reorder_not_id_based')

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-overlay-command-group-parity] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-overlay-command-group-parity] OK')
}

module.exports = { check }
