#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.5) — patcher priority contract gate.
 *
 * `apply-provider-patch.ts` must run the provider-default patcher
 * BEFORE the profile patcher (so a profile cannot accidentally
 * silence a provider default). The contract for the
 * `stream_options.include_usage` field is:
 *   1. user config wins (caller already merged `body` before patch)
 *   2. provider default fills `=== undefined`
 *   3. profile fills `=== undefined` (cannot overwrite the default)
 *
 * Verified structurally: in `applyProviderRequestPatch`, the
 * `providerDefaultRequestPatcher` invocation must literally precede
 * the `profile.requestPatcher` invocation in source order.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET = 'src/shared/ai-providers/apply-provider-patch.ts'

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, TARGET)
  if (!fs.existsSync(abs)) return { ok: false, errors: [`Missing ${TARGET}`] }
  const src = fs.readFileSync(abs, 'utf8')
  const errors = []

  const reqFnMatch = src.match(/export\s+function\s+applyProviderRequestPatch[\s\S]*?\n\}/)
  if (!reqFnMatch) {
    return { ok: false, errors: ['Cannot locate applyProviderRequestPatch function body'] }
  }
  const reqBody = reqFnMatch[0]
  const idxDefault = reqBody.indexOf('providerDefaultRequestPatcher')
  const idxProfile = reqBody.indexOf('profile.requestPatcher')
  if (idxDefault < 0) errors.push('applyProviderRequestPatch must invoke providerDefaultRequestPatcher')
  if (idxProfile < 0) errors.push('applyProviderRequestPatch must invoke profile.requestPatcher')
  if (idxDefault >= 0 && idxProfile >= 0 && idxDefault > idxProfile) {
    errors.push('applyProviderRequestPatch must call providerDefaultRequestPatcher BEFORE profile.requestPatcher')
  }

  // Same priority for response side.
  const respFnMatch = src.match(/export\s+function\s+applyProviderResponsePatch[\s\S]*?\n\}/)
  if (!respFnMatch) {
    errors.push('Cannot locate applyProviderResponsePatch function body')
  } else {
    const respBody = respFnMatch[0]
    const idxDefaultR = respBody.indexOf('providerDefaultResponsePatcher')
    const idxProfileR = respBody.indexOf('profile.responsePatcher')
    if (idxDefaultR < 0) errors.push('applyProviderResponsePatch must invoke providerDefaultResponsePatcher')
    if (idxProfileR < 0) errors.push('applyProviderResponsePatch must invoke profile.responsePatcher')
    if (idxDefaultR >= 0 && idxProfileR >= 0 && idxDefaultR > idxProfileR) {
      errors.push('applyProviderResponsePatch must call providerDefaultResponsePatcher BEFORE profile.responsePatcher')
    }
  }

  // The DeepSeek profile must NOT touch `stream_usage` — the contract
  // is that DeepSeek inherits the openai-compatible default and the
  // profile only worries about reasoning_content.
  const dsAbs = path.join(root, 'src/shared/ai-providers/patch-profiles/deepseek.ts')
  if (fs.existsSync(dsAbs)) {
    const dsSrc = fs.readFileSync(dsAbs, 'utf8')
    if (/stream_usage/.test(dsSrc)) {
      errors.push('deepseek profile must NOT clobber `stream_usage` (preserve provider default)')
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-patch-priority-stream-usage-preserved] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-patch-priority-stream-usage-preserved] OK')
}

module.exports = { check }
