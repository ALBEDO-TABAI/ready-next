import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createElement, type DragEvent } from 'react'
import { mountPageUI } from './utils/page-ui-harness'
import { useAttachmentIntake } from '../renderer/components/agent/chat-panel/drag-drop/use-attachment-intake'
import { useAgent } from '../renderer/stores/useAgent'
import { beginSkillDrag, endSkillDrag } from '../renderer/modules/workbench/skill-drag'
import { writeReadyRefTransfer } from '../shared/ready-ref'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('skill drag mention contract', () => {
  it('drops skills into chat as @ mentions rather than legacy slash commands', async () => {
    // eslint-disable-next-line ready/no-source-grep-test -- The catalog handler is private; verify its sender wiring alongside the real intake behavior below.
    const skillsPanel = readFileSync(
      resolve(repoRoot, 'renderer/components/layout/SkillsCenterPanel.tsx'),
      'utf8',
    )
    assert.match(skillsPanel, /beginSkillDrag\(ref, \{ type: 'skill-folder', name: payload\.name, path: payload\.path, skillId: payload\.skillId \}\)/)
    assert.match(skillsPanel, /writeReadyRefTransfer\(e\.dataTransfer, ref, payload\.name\)/)
    const ui = await mountPageUI(), previous = useAgent.getState()
    let drop: ReturnType<typeof useAttachmentIntake>['handleDrop'] | undefined
    let focused = 0
    function Harness() {
      drop = useAttachmentIntake({
        addAttachments: useAgent.getState().addAttachments,
        setInputValue: useAgent.getState().setInputValue,
        setIsDragOver: () => {}, focusInputWithResize: () => { focused++ },
      }).handleDrop
      return null
    }
    const data = new Map<string, string>()
    const dataTransfer = { files: [], get types() { return [...data.keys()] },
      setData: (format: string, value: string) => { data.set(format, value) }, getData: (format: string) => data.get(format) || '' }
    const ref = { kind: 'file' as const, id: 'skill-object' }
    beginSkillDrag(ref, { type: 'skill-folder', name: '写作', skillId: 'writing', path: '/skills/writing' })
    writeReadyRefTransfer(dataTransfer, ref, '写作')
    try {
      await ui.render(createElement(Harness))
      for (const [draft, expected] of [['', '@[写作] '], ['已有文字  ', '已有文字 @[写作] ']]) {
        useAgent.getState().setInputValue(draft)
        await drop!({ dataTransfer, preventDefault() {}, stopPropagation() {} } as unknown as DragEvent)
        assert.equal(useAgent.getState().inputValue, expected)
        const attachment = useAgent.getState().attachments.at(-1)!
        assert.equal(attachment.source, 'skill-folder')
        assert.equal(attachment.skillId, 'writing')
        assert.equal(attachment.skillFolderPath, '/skills/writing')
        assert.doesNotMatch(useAgent.getState().inputValue, /\/skill/)
      }
      assert.equal(focused, 2)
    } finally { endSkillDrag(); await ui.close(); useAgent.setState(previous, true) }
  })
})
