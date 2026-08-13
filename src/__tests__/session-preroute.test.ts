import assert from 'node:assert/strict'
import test from 'node:test'

import { createGenericSettingIPCHandler } from '../main/modules/settings-engine/generic-setting-ipc-handler'

test('retired preroute and knowledge keys cannot be restored through generic settings', () => {
  const writes: Array<{ key: string; value: string }> = []
  const notifications: Array<{ key: string; value: string }> = []
  const handler = createGenericSettingIPCHandler({
    repository: { setSetting: (key, value) => writes.push({ key, value }) },
    onSettingChanged: (key, value) => notifications.push({ key, value }),
  })

  for (const key of ['agent.sessionPrerouteMode', 'agent.knowledgeSystemEnabled']) {
    assert.deepEqual(handler({}, { key, value: 'true' }), {
      success: false,
      error: 'retired_agent_control_setting',
    })
  }
  assert.deepEqual(writes, [])
  assert.deepEqual(notifications, [])

  assert.deepEqual(handler({}, { key: 'appearance.theme', value: 'dark' }), { success: true })
  assert.deepEqual(writes, [{ key: 'appearance.theme', value: 'dark' }])
})
