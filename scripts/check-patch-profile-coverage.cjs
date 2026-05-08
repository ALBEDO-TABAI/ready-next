#!/usr/bin/env node
/**
 * Stage S (PR-S4 / W3.2-W3.5) — every registered patch profile must
 * have at least one matching fixture case in
 * `src/__tests__/fixtures/patch-profiles.json`.
 *
 * This guards against the regression where someone deletes a profile
 * but leaves stale fixtures behind, or adds a profile but forgets to
 * cover it. Coverage is checked by `expectsMatch === true` cases.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const FIXTURE_REL = 'src/__tests__/fixtures/patch-profiles.json'

const REGISTERED = ['gemini-oai', 'deepseek', 'minimax', 'vllm']

function check({ root = REPO_DEFAULT } = {}) {
  const abs = path.join(root, FIXTURE_REL)
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`Missing fixture: ${FIXTURE_REL}`] }
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON in ${FIXTURE_REL}: ${err.message}`] }
  }
  const errors = []
  // Collect all profileIds present in the fixture (any group with `profileId`).
  const fixtureProfiles = new Map()
  for (const value of Object.values(data)) {
    if (!value || typeof value !== 'object' || !value.profileId) continue
    fixtureProfiles.set(value.profileId, value)
  }
  for (const profileId of REGISTERED) {
    const group = fixtureProfiles.get(profileId)
    if (!group) {
      errors.push(`Profile '${profileId}' has no fixture group with matching profileId`)
      continue
    }
    const hits = (group.cases || []).filter((c) => c && c.expectsMatch === true)
    if (hits.length === 0) {
      errors.push(`Profile '${profileId}' has no fixture case with expectsMatch=true`)
    }
  }
  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const r = check()
  if (!r.ok) {
    console.error('[check-patch-profile-coverage] FAIL')
    for (const e of r.errors) console.error('  -', e)
    process.exit(1)
  }
  console.log('[check-patch-profile-coverage] OK')
}

module.exports = { check, REGISTERED, FIXTURE_REL }
