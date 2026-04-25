import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('skill drag mention contract', () => {
  it('drops skills into chat as @ mentions rather than legacy slash commands', () => {
    const chatPanel = readFileSync(
      resolve(repoRoot, 'renderer/components/agent/ChatPanel.tsx'),
      'utf8',
    )
    const skillsPanel = readFileSync(
      resolve(repoRoot, 'renderer/components/layout/SkillsCenterPanel.tsx'),
      'utf8',
    )

    assert.match(chatPanel, /const mention = `@\[\$\{data\.name\}\]`/)
    assert.doesNotMatch(chatPanel, /data\.defaultCommand\s*\|\|/)
    assert.match(skillsPanel, /setData\('text\/plain', `@\[\$\{payload\.name\}\]`\)/)
  })
})
