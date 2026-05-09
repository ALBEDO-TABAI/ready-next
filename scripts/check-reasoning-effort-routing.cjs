#!/usr/bin/env node
/**
 * Stage S (PR-S6 / W4.4) — reasoning_effort routing.
 *
 * At least one provider patcher must gate `reasoning_effort` on the
 * resolved capability `supportsThinking`. The conservative target is
 * `openai-compatible.ts` because that's where untrusted third-party
 * relays land — those endpoints often 400 on `reasoning_effort` when
 * the model does not support thinking.
 *
 * Gate:
 *   (a) at least one file under `src/shared/ai-providers/` (excluding
 *       `types.ts` and `index.ts`) carries BOTH the literal
 *       `reasoning_effort` token AND a `supportsThinking` reference
 *       in the same file.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const PROVIDER_DIR_REL = 'src/shared/ai-providers'

function listCandidateFiles(dirAbs) {
  if (!fs.existsSync(dirAbs)) return []
  const out = []
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(path.join(dirAbs, entry.name))
    } else if (entry.isDirectory()) {
      out.push(...listCandidateFiles(path.join(dirAbs, entry.name)))
    }
  }
  return out
}

function checkReasoningEffortRouting({ root = REPO_DEFAULT } = {}) {
  const errors = []
  const dirAbs = path.join(root, PROVIDER_DIR_REL)
  if (!fs.existsSync(dirAbs)) {
    errors.push(`Missing provider directory: ${PROVIDER_DIR_REL}`)
    return { ok: false, errors }
  }

  const candidates = listCandidateFiles(dirAbs)
  let foundFile = null
  for (const abs of candidates) {
    const rel = path.relative(root, abs).replace(/\\/g, '/')
    // Skip type-only / index aggregator files.
    if (/types\.ts$/.test(rel) || /\/index\.ts$/.test(rel)) continue
    const src = fs.readFileSync(abs, 'utf8')
    if (/\breasoning_effort\b/.test(src) && /\bsupportsThinking\b/.test(src)) {
      foundFile = rel
      break
    }
  }

  if (!foundFile) {
    errors.push(`No provider patcher under ${PROVIDER_DIR_REL}/ contains both \`reasoning_effort\` and \`supportsThinking\``)
    return { ok: false, errors }
  }

  return { ok: true, errors: [], foundFile }
}

if (require.main === module) {
  const result = checkReasoningEffortRouting()
  if (!result.ok) {
    console.error('[check-reasoning-effort-routing] FAIL')
    for (const err of result.errors) console.error('  -', err)
    process.exit(1)
  }
  console.log(`[check-reasoning-effort-routing] OK (found in ${result.foundFile})`)
}

module.exports = { checkReasoningEffortRouting }
