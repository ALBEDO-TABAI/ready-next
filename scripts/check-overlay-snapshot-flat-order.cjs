#!/usr/bin/env node
'use strict'

// P3 guard (2026-07-07-vertical-tab-groups-and-reorder §9.0/§13, decision D-SNAPSHOT):
// the overlay snapshot must carry the RAW FLAT tab order, NOT a globally pair-hoisted
// display order. If buildSnapshot wraps the overlay tabs in getActiveTabPairOrder again,
// two bugs return: (a) a reorder command's toRank lands in display space (wrong slot when
// split≠active), and (b) a cross-group split breaks the overlay's per-group contiguity.
// This guard asserts the rail no longer uses the global hoist and builds the snapshot tabs
// via the flat helper, and that the helper maps the raw `tabs` array.

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

// Slice the buildSnapshot callback body: from its declaration to the next `const `
// binding (pushSnapshot), so a hoist elsewhere in the file can't mask a regression.
function sliceBuildSnapshot(source) {
  const start = source.search(/const buildSnapshot\s*=/)
  if (start === -1) return null
  const rest = source.slice(start)
  const next = rest.search(/\n {2}const \w/)
  return next === -1 ? rest : rest.slice(0, next)
}

function check({ root = ROOT } = {}) {
  const errors = []
  const readAt = (rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'))

  const rail = readAt('src/renderer/components/browser/VerticalTabRail.tsx')
  const helper = readAt('src/renderer/components/browser/vertical-rail-overlay-snapshot.ts')

  // The whole rail must have retired the global display hoist — both the 52px strip and
  // the snapshot now derive order from the shared flat display model / flat helper.
  if (/getActiveTabPairOrder/.test(rail)) errors.push('rail_still_references_getActiveTabPairOrder')

  const body = sliceBuildSnapshot(rail)
  if (body === null) {
    errors.push('buildSnapshot_not_found')
  } else {
    if (/getActiveTabPairOrder/.test(body)) errors.push('buildSnapshot_uses_global_pair_hoist')
    if (!/buildOverlaySnapshotTabs\s*\(/.test(body)) errors.push('buildSnapshot_not_using_flat_helper')
  }

  // The flat helper must map the raw tabs array in order and must not itself re-hoist.
  if (!/export function buildOverlaySnapshotTabs\s*\(/.test(helper)) {
    errors.push('flat_helper_missing_or_not_exported')
  }
  if (/getActiveTabPairOrder/.test(helper)) errors.push('flat_helper_uses_global_pair_hoist')
  if (!/\btabs\.map\(/.test(helper)) errors.push('flat_helper_does_not_map_raw_tabs')

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-overlay-snapshot-flat-order] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-overlay-snapshot-flat-order] OK')
}

module.exports = { check }
