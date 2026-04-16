import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  __reloadSessionContinuityFromDiskForTests,
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
  getBrowserWorkflowState,
  rememberBrowserWorkflowState,
} from '../main/modules/agent-control/session-continuity'

const TEST_STORAGE_PATH = join(tmpdir(), 'ready-session-continuity-persisted.json')

beforeEach(() => {
  __setSessionContinuityStoragePathForTests(TEST_STORAGE_PATH)
  __resetSessionContinuityForTests()
})

afterEach(() => {
  __resetSessionContinuityForTests()
  __setSessionContinuityStoragePathForTests(null)
  rmSync(TEST_STORAGE_PATH, { force: true })
})

test('browser workflow state survives an in-memory reset by reloading from disk', () => {
  rememberBrowserWorkflowState('scope-persisted', {
    url: 'https://jimeng.example.com/workspace',
    title: '即梦工作台',
    workflowKind: 'upload_generate',
    stage: 'submit',
    attachmentName: 'poster.png',
    promptPreview: '做一张温暖的美食海报',
    evidence: ['preview_visible', 'prompt_matched'],
    running: false,
    uploadMounted: true,
    promptFilled: true,
    status: 'failed',
    canResume: true,
    lastFailureReason: '页面未确认进入运行态',
  })

  __resetSessionContinuityForTests({ keepPersisted: true })
  __reloadSessionContinuityFromDiskForTests()

  const restored = getBrowserWorkflowState('scope-persisted')
  assert.equal(restored?.url, 'https://jimeng.example.com/workspace')
  assert.equal(restored?.workflowKind, 'upload_generate')
  assert.equal(restored?.canResume, true)
  assert.equal(restored?.lastFailureReason, '页面未确认进入运行态')
})
