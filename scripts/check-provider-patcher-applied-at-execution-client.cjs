#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.5) — verify the patch helpers are wired into
 * the OpenAI and Anthropic execution clients at every relevant
 * serialization site.
 *
 * Contract:
 *   - openai-execution-client.ts:
 *       6 `applyProviderRequestPatch` call sites
 *       6 `applyProviderResponsePatch` call sites
 *       (4 simple/text-bridge + 2 native-tools = 6 each)
 *   - anthropic-execution-client.ts:
 *       2 `applyProviderRequestPatch` call sites
 *       2 `applyProviderResponsePatch` call sites
 *
 * Counting via regex is sufficient — the `import` lines are excluded
 * because the regex anchors on call shape `applyProviderRequestPatch(`.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const TARGETS = [
  {
    file: 'src/main/modules/claude-bridge/openai-execution-client.ts',
    requestMin: 6,
    responseMin: 6,
  },
  {
    file: 'src/main/modules/claude-bridge/anthropic-execution-client.ts',
    requestMin: 2,
    responseMin: 2,
  },
]

function countCalls(src, name) {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g')
  return (src.match(re) || []).length
}

function check({ root = REPO_DEFAULT } = {}) {
  const errors = []
  for (const t of TARGETS) {
    const abs = path.join(root, t.file)
    if (!fs.existsSync(abs)) {
      errors.push(`Missing ${t.file}`)
      continue
    }
    const src = fs.readFileSync(abs, 'utf8')
    const reqCount = countCalls(src, 'applyProviderRequestPatch')
    const respCount = countCalls(src, 'applyProviderResponsePatch')
    if (reqCount < t.requestMin) {
      errors.push(
        `${t.file}: applyProviderRequestPatch called ${reqCount} time(s); expected ≥ ${t.requestMin}`,
      )
    }
    if (respCount < t.responseMin) {
      errors.push(
        `${t.file}: applyProviderResponsePatch called ${respCount} time(s); expected ≥ ${t.responseMin}`,
      )
    }
  }
  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-provider-patcher-applied-at-execution-client] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-provider-patcher-applied-at-execution-client] OK')
}

module.exports = { check }
