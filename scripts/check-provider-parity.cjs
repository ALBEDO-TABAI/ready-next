#!/usr/bin/env node
/**
 * Stage S (PR-S2 / W3.0) — Provider parity gate.
 *
 * After PR-S3 splits `src/shared/ai-providers.ts` into per-provider
 * sub-modules under `src/shared/ai-providers/`, this gate enforces
 * that exactly the 7 declared `AIProviderType` ids each have a
 * matching `<id>.ts` file and no rogue extra `.ts` files appear at
 * the top of the sub-directory.
 *
 * Soft-skip until the sub-directory exists (PR-S2 lands type
 * extensions only; PR-S3 creates the sub-directory). Once present,
 * the gate flips to strict enforcement automatically.
 *
 * Allowed non-provider files (PR-S3+):
 *   - index.ts                          (barrel + re-exports)
 *   - types.ts                          (sub-module local types)
 *   - apply-provider-patch.ts             (request/response patcher entry)
 *   - resolve-provider-patch-profile.ts   (profile picker)
 *   - resolve-provider-default-patchers.ts (PR-S4 sub-module patcher lookup)
 *   - model-capability-resolver.ts        (PR-S5 three-layer merge)
 *   - patch-profiles/*.ts                 (excluded via prefix filter)
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const PROVIDER_IDS = [
  'moonshot',
  'anthropic',
  'fox',
  'openai',
  'gemini',
  'volcengine',
  'openai-compatible',
]

const ALLOWED_EXTRA = [
  'index',
  'types',
  'apply-provider-patch',
  'resolve-provider-patch-profile',
  'resolve-provider-default-patchers',
  'model-capability-resolver',
]

function checkProviderParity({ root = REPO_DEFAULT } = {}) {
  const subDir = path.join(root, 'src/shared/ai-providers')
  if (!fs.existsSync(subDir)) {
    return { ok: true, skipped: true, reason: 'subdir_not_present' }
  }

  const entries = fs.readdirSync(subDir, { withFileTypes: true })
  const filesPresent = entries
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && !d.name.startsWith('patch-profiles'))
    .map((d) => d.name.replace(/\.ts$/, ''))

  const missing = PROVIDER_IDS.filter((id) => !filesPresent.includes(id))
  const extra = filesPresent.filter(
    (f) => !PROVIDER_IDS.includes(f) && !ALLOWED_EXTRA.includes(f),
  )

  return {
    ok: missing.length === 0 && extra.length === 0,
    skipped: false,
    missing,
    extra,
    filesPresent,
  }
}

if (require.main === module) {
  const result = checkProviderParity()
  if (result.skipped) {
    console.log('[check-provider-parity] OK (subdir not yet present, skipped)')
    process.exit(0)
  }
  if (!result.ok) {
    console.error('[check-provider-parity] FAIL', {
      missing: result.missing,
      extra: result.extra,
    })
    process.exit(1)
  }
  console.log('[check-provider-parity] OK')
}

module.exports = { checkProviderParity, PROVIDER_IDS, ALLOWED_EXTRA }
