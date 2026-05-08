#!/usr/bin/env node
/**
 * Stage S (PR-S7 / W4.5) — `o3-mini` literal special-case gate.
 *
 * The two legacy zero-off literal branches
 *
 *   src/main/modules/skills-runtime/agent-context-source.ts
 *   src/main/modules/agent-control/video-expert-child-driver.ts
 *
 * historically carried `if (m === 'o3-mini') return true` checks that
 * encoded a per-model capability decision in heuristic helpers. PR-S7
 * routes that decision through the central
 * `resolveModelCapabilities(provider, modelId)` resolver and removes
 * the literal branches.
 *
 * This gate freezes the removal: any future re-introduction of the
 * `o3-mini` literal in either file is rejected at the source-grep
 * level. The model-id may still appear elsewhere in the repo — this
 * gate only guards the two helpers whose heuristic structure is the
 * historical attractor for the special case.
 *
 * (The legitimate `o3-mini` model declaration lives in
 * `src/shared/ai-providers/openai.ts` and is checked by
 * `check-text-only-models-resolve-text-only.cjs`.)
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_RELS = [
  'src/main/modules/skills-runtime/agent-context-source.ts',
  'src/main/modules/agent-control/video-expert-child-driver.ts',
]

function checkNoO3MiniSpecialCases({ root = REPO_DEFAULT } = {}) {
  const errors = []

  for (const rel of TARGET_RELS) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      errors.push(`Missing target file: ${rel}`)
      continue
    }
    const src = fs.readFileSync(abs, 'utf8')
    if (/o3-mini/.test(src)) {
      errors.push(`${rel}: contains forbidden \`o3-mini\` literal — route per-model capability through resolveModelCapabilities() instead.`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = checkNoO3MiniSpecialCases()
  if (!result.ok) {
    console.error('[check-no-o3-mini-special-cases] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-no-o3-mini-special-cases] OK')
}

module.exports = { checkNoO3MiniSpecialCases, TARGET_RELS }
