import assert from 'node:assert/strict'
import test from 'node:test'

import { executePetTool } from '../main/modules/tools/pet-tools'

test('pet_show_sticky_note uses the product action bridge and returns applied evidence', async () => {
  const requests: Array<{ action: string; args: Record<string, unknown> }> = []
  const result = JSON.parse(await executePetTool('pet_show_sticky_note', {
    body: '等构建完成后截图确认',
  }, {
    requestModuleToolAction: async (action, args) => {
      requests.push({ action, args })
      return { ok: true, noteId: 'note-1', applied: true, snapshotRevision: 3 }
    },
  })) as { success: boolean; noteId: string; applied: boolean; snapshotRevision: number }

  assert.equal(result.success, true)
  assert.equal(result.applied, true)
  assert.equal(result.snapshotRevision, 3)
  assert.deepEqual(requests, [{
    action: 'pet.showStickyNote',
    args: { body: '等构建完成后截图确认' },
  }])
})
