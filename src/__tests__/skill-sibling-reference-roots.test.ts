import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveDeclaredSiblingSkillReadRoots } from '../main/modules/skills-runtime/skill-sibling-reference-roots'
import { parseSiblingSkillReferenceIds } from '../main/modules/skills-runtime/skill-sibling-references'

test('sibling SKILL.md links declare deduped read-only skill dependencies', () => {
  assert.deepEqual(parseSiblingSkillReferenceIds([
    'Read [shared](../lark-shared/SKILL.md) first.',
    'Then [shared again](../lark-shared/SKILL.md#auth).',
    'Reject [escape](../../outside/SKILL.md).',
    'Reject [non skill](../lark-shared/README.md).',
  ].join('\n')), ['lark-shared'])
})

test('only registered advisory sibling skills become read-only roots', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ready-sibling-skill-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const larkIm = join(root, 'lark-im')
  const larkShared = join(root, 'lark-shared')
  const executableSibling = join(root, 'executable-sibling')
  mkdirSync(larkIm)
  mkdirSync(larkShared)
  mkdirSync(executableSibling)
  writeFileSync(join(larkIm, 'SKILL.md'), [
    '[shared](../lark-shared/SKILL.md)',
    '[executable](../executable-sibling/SKILL.md)',
    '[missing](../missing/SKILL.md)',
  ].join('\n'))

  assert.deepEqual(resolveDeclaredSiblingSkillReadRoots({
    selectedSkillId: 'lark-im',
    skills: [
      { id: 'lark-im', managedPath: larkIm, executionMode: 'executable' },
      { id: 'lark-shared', managedPath: larkShared, executionMode: 'advisory' },
      { id: 'executable-sibling', managedPath: executableSibling, executionMode: 'executable' },
    ],
  }), [realpathSync.native(larkShared)])
})
