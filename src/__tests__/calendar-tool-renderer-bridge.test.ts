import assert from 'node:assert/strict'
import test from 'node:test'

import { executeCalendarTool } from '../main/modules/tools/calendar-tools'
import { executeRSSTool } from '../main/modules/tools/rss-tools'

test('calendar tools await renderer bridge payloads instead of returning only queued receipts', async () => {
  const emitted: string[] = []
  const result = await executeCalendarTool('calendar_capture_session', {}, {
    emitToolAction: (tool) => emitted.push(tool),
    requestModuleToolAction: async (tool, args) => {
      assert.equal(tool, 'calendar.captureSession')
      assert.deepEqual(args, {})
      return {
        summary: '日程会话已捕获：已加载 1 个事件。',
        events: [{ id: 'event-1', title: '123' }],
      }
    },
  })

  assert.deepEqual(emitted, [])
  const payload = JSON.parse(result) as Record<string, unknown>
  assert.equal(payload.message, '日程会话已捕获：已加载 1 个事件。')
  assert.deepEqual(payload.events, [{ id: 'event-1', title: '123' }])
})

test('rss tools also use renderer bridge payloads when available', async () => {
  const result = await executeRSSTool('rss_capture_session', {}, {
    requestModuleToolAction: async (tool) => {
      assert.equal(tool, 'rss.captureSession')
      return {
        summary: 'RSS 会话已捕获：当前共 3 条内容。',
        totalItems: 3,
      }
    },
  })

  const payload = JSON.parse(result) as Record<string, unknown>
  assert.equal(payload.message, 'RSS 会话已捕获：当前共 3 条内容。')
  assert.equal(payload.totalItems, 3)
})

test('RSS missing or failed bridge results never claim a completed operation', async () => {
  const missing = JSON.parse(await executeRSSTool('rss_fetch_updates', {}))
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'module_bridge_unavailable')
  const failed = JSON.parse(await executeRSSTool('rss_fetch_updates', {}, {
    requestModuleToolAction: async () => ({ ok: false, error: 'offline', message: '已完成' }),
  }))
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'offline')
  assert.equal(failed.message, 'RSS 操作未完成。')
})
