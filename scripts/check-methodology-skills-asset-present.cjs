#!/usr/bin/env node
/**
 * Stage R W1.5 — methodology skills asset presence.
 *
 * Asserts each of the 5 methodology skills ships SKILL.md + ready-skill.json
 * under assets/embedded-skills/<id>/.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

const SKILL_IDS = [
  'systematic-literature-review',
  'github-deep-research',
  'academic-paper-review',
  'web-design-guidelines',
  'find-skills',
]

const REQUIRED = ['SKILL.md', 'ready-skill.json']

for (const id of SKILL_IDS) {
  const dir = path.join(ROOT, 'assets/embedded-skills', id)
  if (!fs.existsSync(dir)) {
    errors.push(`missing dir: assets/embedded-skills/${id}`)
    continue
  }
  for (const fname of REQUIRED) {
    if (!fs.existsSync(path.join(dir, fname))) {
      errors.push(`missing assets/embedded-skills/${id}/${fname}`)
    }
  }
}

if (errors.length > 0) {
  console.error('[check-methodology-skills-asset-present] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-methodology-skills-asset-present] OK')
