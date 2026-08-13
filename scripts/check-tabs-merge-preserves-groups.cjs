#!/usr/bin/env node
'use strict'

// P1b P0 guard (2026-07-07-vertical-tab-groups-and-reorder §6/§13): tab groups are
// renderer-only, so every backend→renderer tab reconcile MUST preserve the local
// groupId. There are THREE such paths; a naive `setTabs(<backend tabs>)` at any of
// them silently wipes grouping (the backend payload has no groupId; normalize then
// drops the orphaned groups). Two paths reconcile by id and route through
// mergeBackendTabsPreservingGroups; the third (restart rebuild) mints fresh backend
// ids and preserves groupId by spreading the persisted tab instead.
//
// The drift guard is FAIL-CLOSED: it enumerates EVERY setTabs() call site in the
// renderer and requires each to be either group-preserving (merge-wrapped) or one
// of the explicitly allowlisted renderer-local sites (§12.0). A brand-new
// backend→renderer reconcile therefore cannot pass without being classified.

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

function walkRenderer(root) {
  const base = path.join(root, 'src/renderer')
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue
        walk(full)
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  if (fs.existsSync(base)) walk(base)
  return out
}

// Classify a setTabs(<arg…>) call by the text immediately after the open paren.
// Returns a label for a recognized/safe site, or null for an unclassified one
// (which the drift guard rejects). Identifier names inside the merge wrapper and
// the array literal are wildcards so behavior-identical refactors don't false-fail.
function classifySetTabsArg(afterParen) {
  const a = afterParen.trimStart()
  if (/^mergeBackendTabsPreservingGroups\s*\(/.test(a)) return 'merged'
  if (/^\[\s*\]/.test(a)) return 'renderer-local:empty' //           setTabs([])
  if (/^\[\s*\w+\s*\]/.test(a)) return 'renderer-local:new-array' //  setTabs([replacementTab])
  if (/^remaining\b/.test(a)) return 'renderer-local:filtered' //     setTabs(remaining)
  if (/^recoveredTabs\b/.test(a)) return 'rebuild:spread' //          setTabs(recoveredTabs) — groupId via {...tab}
  return null
}

function check({ root = ROOT } = {}) {
  const errors = []
  const readAt = (rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'))

  const store = readAt('src/renderer/stores/useBrowserTabs.ts')
  const effects = readAt('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')

  // The merge helper must exist, be exported, and preserve the local groupId while
  // taking backend metadata (identifier names are wildcards — assert the outcome).
  if (!/export function mergeBackendTabsPreservingGroups\s*\(/.test(store)) {
    errors.push('merge_helper_missing_or_not_exported')
  }
  if (!/\{\s*\.\.\.\w+\s*,\s*groupId:\s*\w+\.groupId/.test(store)) {
    errors.push('merge_helper_does_not_preserve_local_groupId')
  }

  // Rebuild path: preserve groupId by spreading the persisted tab into the recovered
  // tab (fresh backend ids ⇒ the id-merge would NOT apply here).
  const rebuildEnd = effects.indexOf('store.setTabs(recoveredTabs)')
  const decl = /(?:const recoveredTab\b[^=]*=\s*\{|const recoveredTabs\b[^=]*=\s*\w+\.map\s*\()/.exec(effects)
  if (rebuildEnd === -1 || !decl || decl.index > rebuildEnd) {
    errors.push('rebuild_path_shape_unrecognized')
  } else if (!/\{\s*\.\.\.\w+/.test(effects.slice(decl.index, rebuildEnd))) {
    errors.push('rebuild_does_not_preserve_groupid_via_spread')
  }

  // FAIL-CLOSED drift guard: every setTabs() call site in the renderer must classify.
  let mergedCallSites = 0
  for (const file of walkRenderer(root)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'))
    const rel = path.relative(root, file)
    const re = /\bsetTabs\(/g // call sites only; the store/param definitions use `setTabs:`
    let match
    while ((match = re.exec(source)) !== null) {
      const label = classifySetTabsArg(source.slice(match.index + match[0].length))
      if (label === null) {
        errors.push(`unclassified_setTabs_call_site:${rel}`)
      } else if (label === 'merged') {
        mergedCallSites += 1
      }
    }
  }
  // The two id-matching reconcile paths (sync + restore) must both merge.
  if (mergedCallSites < 2) {
    errors.push('fewer_than_two_merged_reconcile_paths')
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-tabs-merge-preserves-groups] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-tabs-merge-preserves-groups] OK')
}

module.exports = { check }
