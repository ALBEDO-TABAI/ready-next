import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseSkillRequiredBins } from '../main/modules/skills-runtime/skill-frontmatter'
import {
  buildSkillShellBaseAllowlist,
  skillHasExecutableSurface
} from '../main/modules/skills-runtime/skill-executable-surface'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'

test('Agent Skills metadata.requires.bins admits bare programs and rejects paths or destructive commands', () => {
  const bins = parseSkillRequiredBins([
    '---',
    'name: lark-im',
    'metadata:',
    '  requires:',
    '    bins: ["lark-cli", "node", "../escape", "rm", "lark-cli"]',
    '---',
    '# body',
  ].join('\n'))

  assert.deepEqual(bins, ['lark-cli', 'node'])
})

test('declared bins form an executable skill surface without scripts/', () => {
  assert.equal(skillHasExecutableSurface({ managedPath: null, requiredBins: ['lark-cli'] }), true)
  assert.equal(skillHasExecutableSurface({ managedPath: null, requiredBins: [] }), false)
})

test('declared bins are immediate without unlocking the generic shell allowlist', () => {
  const baseAllowlist = new Set(['bash', 'curl'])
  assert.deepEqual(
    [...buildSkillShellBaseAllowlist({
      baseAllowlist,
      requiredBins: ['lark-cli'],
      hasScripts: false,
      allowSkillScripts: false,
    })],
    ['lark-cli'],
  )
  assert.deepEqual(
    [...buildSkillShellBaseAllowlist({
      baseAllowlist,
      requiredBins: ['lark-cli'],
      hasScripts: false,
      allowSkillScripts: true,
    })],
    ['lark-cli'],
  )
  assert.deepEqual(
    [...buildSkillShellBaseAllowlist({
      baseAllowlist,
      requiredBins: ['lark-cli'],
      hasScripts: true,
      allowSkillScripts: true,
    })],
    ['bash', 'curl', 'lark-cli'],
  )
})

test('skill compiler carries required bins into the runtime definition', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-required-bin-'))
  writeFileSync(join(root, 'SKILL.md'), [
    '---',
    'name: lark-im',
    'description: search messages with Lark CLI',
    'metadata:',
    '  requires:',
    '    bins: ["lark-cli"]',
    '---',
    '# Lark IM',
  ].join('\n'))

  try {
    const definition = compileSkillDefinition({ folderPath: root, source: 'custom' })
    assert.deepEqual(definition.requiredBins, ['lark-cli'])
    assert.equal(definition.executionMode, 'advisory')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
