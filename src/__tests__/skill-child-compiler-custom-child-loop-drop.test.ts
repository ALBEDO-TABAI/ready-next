import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

interface ChildLoopFixtureManifest {
  id: string
  name: string
  description?: string
  version?: string
  actions: Array<{ name: string; runtime?: string; entry?: string; description?: string }>
  child_loop?: { version?: number; actions: string[] }
}

function writeManifestFixture(dir: string, manifest: ChildLoopFixtureManifest): void {
  writeFileSync(join(dir, 'ready-skill.json'), JSON.stringify(manifest, null, 2))
}

const baseManifest = (id: string): ChildLoopFixtureManifest => ({
  id,
  name: id,
  description: 'fixture',
  version: '0.0.1',
  actions: [
    { name: 'a_long_action', runtime: 'python', entry: 'scripts/a.py', description: 'fixture' },
    { name: 'b_long_action', runtime: 'python', entry: 'scripts/b.py', description: 'fixture' },
  ],
  child_loop: { version: 1, actions: ['a_long_action', 'b_long_action'] },
})

describe('Stage N Phase 0.4 — custom child_loop dropped at compile', () => {
  it('drops child_loop on a custom-source skill manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-n-custom-child-loop-'))
    writeManifestFixture(dir, baseManifest('fake-custom-child-loop'))

    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    }

    try {
      const definition = compileSkillDefinition({ folderPath: dir, source: 'custom' })
      assert.strictEqual(
        definition.childLoop,
        undefined,
        'custom child_loop must be dropped at compile time',
      )
      assert.ok(
        warnings.some((line) => line.includes('fake-custom-child-loop') && line.includes('child_loop')),
        `expected warning naming the skill; got: ${warnings.join(' | ')}`,
      )
    } finally {
      console.warn = originalWarn
    }
  })

  it('preserves child_loop on an embedded-source skill manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-n-embedded-child-loop-'))
    writeManifestFixture(dir, baseManifest('fake-embedded-child-loop'))

    const definition = compileSkillDefinition({ folderPath: dir, source: 'embedded' })
    assert.ok(definition.childLoop, 'embedded child_loop must survive compile')
    assert.deepStrictEqual(
      [...(definition.childLoop?.actions ?? [])].sort(),
      ['a_long_action', 'b_long_action'],
    )
  })

  it('does not warn when a custom skill has no child_loop declaration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-n-custom-no-loop-'))
    const manifest = baseManifest('fake-custom-no-loop')
    delete manifest.child_loop
    writeManifestFixture(dir, manifest)

    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    }
    try {
      const definition = compileSkillDefinition({ folderPath: dir, source: 'custom' })
      assert.strictEqual(definition.childLoop, undefined)
      assert.ok(
        !warnings.some((line) => line.includes('child_loop')),
        `unexpected child_loop warning: ${warnings.join(' | ')}`,
      )
    } finally {
      console.warn = originalWarn
    }
  })
})
