import assert from 'node:assert/strict'
import test from 'node:test'

import { DatabaseManager } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('boot recovery settles ownerless remote inbound events as failed', (t) => {
  if (skipIfSqliteUnavailable(t, 'remote channel running-event boot recovery')) return
  const db = new DatabaseManager(true)
  try {
    db.upsertAgentChannel({
      id: 'channel-recovery',
      type: 'local-debug',
      name: 'Recovery test channel',
      enabled: true,
      configJson: '{}',
    })
    db.upsertAgentChannelEvent({
      eventId: 'event-running',
      channelId: 'channel-recovery',
      status: 'running',
    })
    db.upsertAgentChannelEvent({
      eventId: 'event-done',
      channelId: 'channel-recovery',
      status: 'done',
    })

    assert.equal(db.failRunningAgentChannelEventsOnBoot(), 1)
    assert.deepEqual(
      {
        status: db.getAgentChannelEvent('event-running')?.status,
        error: db.getAgentChannelEvent('event-running')?.error,
      },
      {
        status: 'failed',
        error: 'app_restart_before_inbound_settlement',
      },
    )
    assert.equal(db.getAgentChannelEvent('event-done')?.status, 'done')
    assert.equal(db.failRunningAgentChannelEventsOnBoot(), 0)
  } finally {
    db.close()
  }
})
