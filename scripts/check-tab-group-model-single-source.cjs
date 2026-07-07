#!/usr/bin/env node
'use strict'

// P1b guard (2026-07-07-vertical-tab-groups-and-reorder §4/§13): the pure
// tab-group-model is the SINGLE source of group logic for both tab stores. Group
// membership/order changes must go through it, and every path that removes a tab or
// reorders must end with a normalize so the contiguity/no-orphan invariants (I1–I3)
// can't drift. This catches a store growing an ad-hoc groupId mutation that bypasses
// the model, or a member-removal that forgets to normalize (leaving an orphaned
// group until reload).
//
// The mutator checks are FAIL-CLOSED: if an expected mutator can't be located, that
// is an error (a rename/re-signature must not silently skip the guard). Existence
// checks are body-scoped so a call elsewhere in the file can't satisfy them by
// accident, and the normalize check accepts any normalize-named call (so the
// spec-§5.2-endorsed shared reducer form is allowed, not just an inline literal).

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

// Body of a top-level `function <name>` up to the next top-level `function`/`export`.
function sliceFunctionBody(source, name) {
  const match = new RegExp(`function ${name}\\b`).exec(source)
  if (!match) return null
  const rest = source.slice(match.index + match[0].length)
  const nextTop = rest.search(/\n(?:export |function )/)
  return nextTop === -1 ? rest : rest.slice(0, nextTop)
}

// Body of a store mutator IMPLEMENTATION (arrow-with-block; the interface's
// `name: (...) => void` declaration is deliberately skipped).
function sliceMutator(source, name) {
  // \b so e.g. closeTab does not substring-match a mutator like onCloseTab.
  const match = new RegExp(`\\b${name}:\\s*\\([^)]*\\)\\s*=>\\s*\\{`).exec(source)
  if (!match) return null
  const rest = source.slice(match.index + match[0].length)
  const nextKey = rest.search(/\n {4}[a-zA-Z][\w]*:/)
  return nextKey === -1 ? rest.slice(0, 1600) : rest.slice(0, nextKey)
}

function check({ root = ROOT } = {}) {
  const errors = []
  const readAt = (rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8'))

  const browser = readAt('src/renderer/stores/useBrowserTabs.ts')
  const doc = readAt('src/renderer/stores/useDocTabs.ts')

  const MODEL_IMPORT = /from '\.\.\/\.\.\/shared\/tab-group-model'/

  // Both stores must source group logic from the shared pure model.
  if (!MODEL_IMPORT.test(browser)) errors.push('browser_store_not_importing_tab_group_model')
  if (!MODEL_IMPORT.test(doc)) errors.push('doc_store_not_importing_tab_group_model')

  // Browser store: sanitizeSnapshot is the single write choke — its OWN body must
  // normalize (body-scoped so a normalize call elsewhere can't mask a regression).
  const browserSanitize = sliceFunctionBody(browser, 'sanitizeSnapshot')
  if (browserSanitize === null) {
    errors.push('browser_sanitize_snapshot_not_found')
  } else if (!/normalizeGroupState\(/.test(browserSanitize)) {
    errors.push('browser_sanitize_snapshot_does_not_normalize')
  }

  // Doc store: the normalize choke helper must exist and its OWN body must call the
  // pure model normalize.
  const docChoke = sliceFunctionBody(doc, 'normalizeDocGroups')
  if (docChoke === null) {
    errors.push('doc_store_missing_normalize_choke')
  } else if (!/normalizeGroupState\(/.test(docChoke)) {
    errors.push('doc_normalize_choke_does_not_call_model')
  }

  // Doc store: the member-removal + reorder mutators (raw-set() paths that would
  // otherwise orphan or de-contiguate groups) must normalize. Fail-closed: a mutator
  // we can't locate is an error, not a skip. A normalize-named helper counts (§5.2).
  for (const name of ['closeTab', 'reorderTabs']) {
    const body = sliceMutator(doc, name)
    if (body === null) {
      errors.push(`doc_${name}_mutator_not_found`)
    } else if (!/normaliz\w*\(/i.test(body)) {
      errors.push(`doc_${name}_does_not_normalize`)
    }
  }

  // Both stores' group formation must delegate to the model op (single source).
  if (!/createGroupFromDrop\(/.test(browser)) errors.push('browser_group_formation_not_delegated')
  if (!/createGroupFromDrop\(/.test(doc)) errors.push('doc_group_formation_not_delegated')

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-tab-group-model-single-source] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-tab-group-model-single-source] OK')
}

module.exports = { check }
