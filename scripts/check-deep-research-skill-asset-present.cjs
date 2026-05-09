#!/usr/bin/env node
/**
 * Stage R W1.4 — deep-research embedded skill asset presence.
 *
 * Asserts the deep-research skill ships SKILL.md + ready-skill.json
 * under assets/embedded-skills/deep-research/.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

const REQUIRED = ['SKILL.md', 'ready-skill.json']
const dir = path.join(ROOT, 'assets/embedded-skills/deep-research')

if (!fs.existsSync(dir)) {
  errors.push(`missing dir: assets/embedded-skills/deep-research`)
} else {
  for (const fname of REQUIRED) {
    if (!fs.existsSync(path.join(dir, fname))) {
      errors.push(`missing assets/embedded-skills/deep-research/${fname}`)
    }
  }
}

if (errors.length > 0) {
  console.error('[check-deep-research-skill-asset-present] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-deep-research-skill-asset-present] OK')
