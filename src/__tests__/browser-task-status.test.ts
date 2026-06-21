import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES,
  browserTaskStatusLabel,
  isBrowserSupervisionVisibleTaskStatus,
  isBrowserTaskTerminalStatus,
} from '../shared/browser-task-status'

test('browser supervision visible statuses include waiting_human but exclude terminal statuses', () => {
  assert.deepEqual(
    BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES,
    ['queued', 'running', 'paused', 'waiting_human'],
  )
  assert.equal(isBrowserSupervisionVisibleTaskStatus('waiting_human'), true)
  assert.equal(isBrowserSupervisionVisibleTaskStatus('completed'), false)
  assert.equal(isBrowserSupervisionVisibleTaskStatus('failed'), false)
  assert.equal(isBrowserSupervisionVisibleTaskStatus('cancelled'), false)
})

test('browser task labels distinguish waiting_human from running work', () => {
  assert.equal(browserTaskStatusLabel('waiting_human'), '等待确认')
  assert.equal(browserTaskStatusLabel('running'), '运行中')
  assert.equal(isBrowserTaskTerminalStatus('completed'), true)
  assert.equal(isBrowserTaskTerminalStatus('waiting_human'), false)
})
