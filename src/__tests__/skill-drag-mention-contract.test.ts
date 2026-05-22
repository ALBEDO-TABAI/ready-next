import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('skill drag mention contract', () => {
  it('drops skills into chat as @ mentions rather than legacy slash commands', () => {
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: drag/drop wiring lives inside unexported React handlers, so the regression is the literal payload contract until those handlers are extracted.
    const attachmentIntake = readFileSync(
      resolve(repoRoot, 'renderer/components/agent/chat-panel/drag-drop/use-attachment-intake.ts'),
      'utf8',
    )
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: drag/drop wiring lives inside unexported React handlers, so the regression is the literal payload contract until those handlers are extracted.
    const skillsPanel = readFileSync(
      resolve(repoRoot, 'renderer/components/layout/SkillsCenterPanel.tsx'),
      'utf8',
    )

    assert.match(attachmentIntake, /const mention = `@\[\$\{data\.name\}\]`/)
    assert.doesNotMatch(attachmentIntake, /data\.defaultCommand\s*\|\|/)
    assert.match(skillsPanel, /setData\('text\/plain', `@\[\$\{payload\.name\}\]`\)/)
  })
})
