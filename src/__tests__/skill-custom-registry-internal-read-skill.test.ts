/**
 * B Phase 1 PR2 T1-9 — the auto-generated `read_skill` action now defaults
 * to `visibility: 'internal'`. Manifests that explicitly declare
 * `'public'` continue to be honored. Uses a real filesystem fixture so the
 * registry's SKILL.md detection runs.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCustomSkillManifestFromFolder } from '../main/modules/skills-runtime/custom-skill-registry'

function withFixture(body: (folderPath: string) => void): void {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'custom-skill-vis-')))
  try {
    body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('auto-generated read_skill action defaults to visibility: internal', () => {
  withFixture((dir) => {
    writeFileSync(join(dir, 'SKILL.md'), '# test skill\nbody', 'utf-8')
    writeFileSync(
      join(dir, 'ready-skill.json'),
      JSON.stringify({ id: 'ref-only', name: 'Reference Only' }),
      'utf-8',
    )
    const manifest = loadCustomSkillManifestFromFolder(dir)
    assert.ok(manifest, 'manifest loaded')
    const readAction = manifest!.actions.find((a) => a.name === 'read_skill')
    assert.ok(readAction, 'auto-generated read_skill action present')
    assert.equal(readAction!.visibility, 'internal')
  })
})

test('explicit visibility: public in manifest is preserved', () => {
  withFixture((dir) => {
    writeFileSync(join(dir, 'SKILL.md'), '# body', 'utf-8')
    writeFileSync(
      join(dir, 'ready-skill.json'),
      JSON.stringify({
        id: 'ref-public',
        name: 'Public Reference',
        actions: [
          {
            name: 'read_skill',
            runtime: 'reference',
            visibility: 'public',
            entry: 'SKILL.md',
          },
        ],
      }),
      'utf-8',
    )
    const manifest = loadCustomSkillManifestFromFolder(dir)
    assert.ok(manifest)
    const readAction = manifest!.actions.find((a) => a.name === 'read_skill')
    assert.equal(readAction?.visibility, 'public')
  })
})
