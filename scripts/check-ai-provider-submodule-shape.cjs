#!/usr/bin/env node
/**
 * Stage S (PR-S3 / W3.1) — provider sub-module shape gate.
 *
 * Enforces that every provider file under
 *   src/shared/ai-providers/<provider>.ts
 * exports both `def` and `capabilityClass`, and every patch-profile
 * file under
 *   src/shared/ai-providers/patch-profiles/<profile>.ts
 * exports `profileId`, `matchPredicate`, and a named `profile` const.
 *
 * Soft-skip until the sub-directory exists (parity with
 * `check-provider-parity.cjs`).
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const PROVIDER_FILES = [
  'moonshot.ts',
  'anthropic.ts',
  'fox.ts',
  'openai.ts',
  'gemini.ts',
  'volcengine.ts',
  'openai-compatible.ts',
]

const PROFILE_FILES = [
  'gemini-oai.ts',
  'deepseek.ts',
  'minimax.ts',
  'vllm.ts',
]

function checkProviderExports(srcRel, src) {
  const errors = []
  // Each provider sub-module must export `def` and `capabilityClass`.
  // Use a forgiving regex; we only need to detect declaration intent.
  if (!/\bexport\s+const\s+def\s*[:=]/.test(src)) {
    errors.push(`${srcRel}: missing \`export const def\``)
  }
  if (!/\bexport\s+const\s+capabilityClass\s*[:=]/.test(src)) {
    errors.push(`${srcRel}: missing \`export const capabilityClass\``)
  }
  return errors
}

function checkProfileExports(srcRel, src) {
  const errors = []
  if (!/\bexport\s+const\s+profileId\s*[:=]/.test(src)) {
    errors.push(`${srcRel}: missing \`export const profileId\``)
  }
  if (!/\bexport\s+const\s+matchPredicate\s*[:=]/.test(src)) {
    errors.push(`${srcRel}: missing \`export const matchPredicate\``)
  }
  if (!/\bexport\s+const\s+profile\s*[:=]/.test(src)) {
    errors.push(`${srcRel}: missing \`export const profile\``)
  }
  return errors
}

function checkAIProviderSubmoduleShape({ root = REPO_DEFAULT } = {}) {
  const subDir = path.join(root, 'src/shared/ai-providers')
  if (!fs.existsSync(subDir)) {
    return { ok: true, skipped: true, reason: 'subdir_not_present' }
  }

  const errors = []

  for (const file of PROVIDER_FILES) {
    const abs = path.join(subDir, file)
    if (!fs.existsSync(abs)) {
      errors.push(`Missing provider sub-module: src/shared/ai-providers/${file}`)
      continue
    }
    const src = fs.readFileSync(abs, 'utf8')
    errors.push(...checkProviderExports(`src/shared/ai-providers/${file}`, src))
  }

  const profilesDir = path.join(subDir, 'patch-profiles')
  if (!fs.existsSync(profilesDir)) {
    errors.push('Missing directory: src/shared/ai-providers/patch-profiles/')
  } else {
    for (const file of PROFILE_FILES) {
      const abs = path.join(profilesDir, file)
      if (!fs.existsSync(abs)) {
        errors.push(`Missing patch-profile sub-module: src/shared/ai-providers/patch-profiles/${file}`)
        continue
      }
      const src = fs.readFileSync(abs, 'utf8')
      errors.push(...checkProfileExports(`src/shared/ai-providers/patch-profiles/${file}`, src))
    }
  }

  return { ok: errors.length === 0, skipped: false, errors }
}

if (require.main === module) {
  const result = checkAIProviderSubmoduleShape()
  if (result.skipped) {
    console.log('[check-ai-provider-submodule-shape] OK (subdir not yet present, skipped)')
    process.exit(0)
  }
  if (!result.ok) {
    console.error('[check-ai-provider-submodule-shape] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log('[check-ai-provider-submodule-shape] OK')
}

module.exports = { checkAIProviderSubmoduleShape, PROVIDER_FILES, PROFILE_FILES }
