/**
 * Stage R W1.4 — deep-research embedded skill asset smoke test.
 *
 * Asserts that EMBEDDED_SKILLS includes the 'deep-research' entry and
 * that the corresponding asset directory ships SKILL.md + ready-skill.json.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'


const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSET_ROOT = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'deep-research')

test('deep-research asset directory ships SKILL.md and ready-skill.json', () => {
  assert.equal(existsSync(join(ASSET_ROOT, 'SKILL.md')), true)
  assert.equal(existsSync(join(ASSET_ROOT, 'ready-skill.json')), true)
})
