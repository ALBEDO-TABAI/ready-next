import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES,
  BROWSER_SURFACE_PRESENTING_TASK_STATUSES,
  browserTaskStatusLabel,
  isBrowserSupervisionVisibleTaskStatus,
  isBrowserSurfacePresentingTaskStatus,
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

test('paused tasks remain in history without forcing a native browser surface', () => {
  assert.deepEqual(BROWSER_SURFACE_PRESENTING_TASK_STATUSES, ['queued', 'running', 'waiting_human'])
  assert.equal(isBrowserSupervisionVisibleTaskStatus('paused'), true)
  assert.equal(isBrowserSurfacePresentingTaskStatus('paused'), false)
  assert.equal(isBrowserSurfacePresentingTaskStatus('queued'), true)
  assert.equal(isBrowserSurfacePresentingTaskStatus('running'), true)
  assert.equal(isBrowserSurfacePresentingTaskStatus('waiting_human'), true)
})

test('browser task labels distinguish waiting_human from running work', () => {
  assert.equal(browserTaskStatusLabel('waiting_human'), '等待确认')
  assert.equal(browserTaskStatusLabel('running'), '运行中')
  assert.equal(isBrowserTaskTerminalStatus('completed'), true)
  assert.equal(isBrowserTaskTerminalStatus('waiting_human'), false)
})
