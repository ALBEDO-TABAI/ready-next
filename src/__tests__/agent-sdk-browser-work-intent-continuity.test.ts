import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBrowserWorkIntent } from '../shared/browser-work-intent'
import { AgentSdkIntentTracker } from '../main/modules/agent-control/runtime-core/agent-sdk-intent-tracker'

test('bare retry inherits the complete browser research contract without a sticky write boolean', () => {
  const tracker = new AgentSdkIntentTracker()
  const original = resolveBrowserWorkIntent('在小红书这里搜索：\n词一\n词二')
  tracker.trackBrowserWorkIntent('scope-1', original, 'new_task')

  const retried = tracker.trackBrowserWorkIntent(
    'scope-1',
    resolveBrowserWorkIntent('再试一次'),
    'continue_task',
  )

  assert.equal(retried.kind, 'site_research')
  assert.deepEqual(retried.queries, ['词一', '词二'])
  assert.equal(retried.persistenceRequested, false)
  assert.equal(retried.batchScope, 'none')
})

test('substantive new task and explicit reset cannot inherit an unrelated browser contract', () => {
  const tracker = new AgentSdkIntentTracker()
  tracker.trackBrowserWorkIntent(
    'scope-1',
    resolveBrowserWorkIntent('保存全部笔记到文件夹'),
    'new_task',
  )

  const unrelated = tracker.trackBrowserWorkIntent(
    'scope-1',
    resolveBrowserWorkIntent('帮我写一篇咖啡文章'),
    'new_task',
  )
  assert.equal(unrelated.kind, 'observe')

  tracker.resetCollectionIntents('scope-1')
  const retry = tracker.trackBrowserWorkIntent(
    'scope-1',
    resolveBrowserWorkIntent('继续'),
    'continue_task',
  )
  assert.equal(retry.kind, 'observe')
})
