import assert from 'node:assert/strict'
import test from 'node:test'

import { setActivePetWindowManager } from '../main/modules/pet/active-pet-window-manager'
import type { PetWindowManager } from '../main/modules/pet/pet-window-manager'
import { executePetTool } from '../main/modules/tools/pet-tools'
import { DEFAULT_PET_SETTINGS } from '../shared/pet'

test('pet_show_sticky_note enables the desktop pet and pushes the newest sticky note first', async () => {
  const pushed: Array<{ id: string; body: string }> = []
  const updates: Array<Record<string, unknown>> = []
  const fakeManager = {
    getSettings: () => ({ ...DEFAULT_PET_SETTINGS, enabled: false }),
    updateSettings: (patch: Record<string, unknown>) => {
      updates.push(patch)
      return { ...DEFAULT_PET_SETTINGS, ...patch }
    },
    show: async () => undefined,
    pushStickyNote: (note: { body: string }) => {
      const pushedNote = { id: `note-${pushed.length + 1}`, body: note.body }
      pushed.unshift(pushedNote)
      return pushedNote
    },
    dismissStickyNote: (id: string) => {
      const index = pushed.findIndex((note) => note.id === id)
      if (index === -1) return false
      pushed.splice(index, 1)
      return true
    },
    clearStickyNotes: () => {
      pushed.splice(0, pushed.length)
    },
  } as unknown as PetWindowManager

  setActivePetWindowManager(fakeManager)

  const result = JSON.parse(await executePetTool('pet_show_sticky_note', {
    body: '等构建完成后截图确认',
  })) as { success: boolean; note: { id: string; body: string } }

  assert.equal(result.success, true)
  assert.equal(result.note.body, '等构建完成后截图确认')
  assert.deepEqual(updates, [{ enabled: true }])
  assert.deepEqual(pushed.map((note) => note.body), ['等构建完成后截图确认'])
})
