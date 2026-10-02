import assert from 'node:assert/strict'
import test from 'node:test'

import { RSSItemAnalysisManager } from '../main/modules/rss-engine/item-analysis-manager'
import type { RSSAnalysisJob } from '../main/modules/database/records'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function job(status: RSSAnalysisJob['status']): RSSAnalysisJob {
  return {
    id: 'job-1',
    item_id: 'item-1',
    action: 'copy',
    source_url: 'https://example.com/item',
    title: 'Example',
    target_dir: '/tmp/rss-target',
    output_dir: '/tmp/rss-target/output',
    status,
    progress: 50,
    message: null,
    error: null,
    report_path: null,
    meta_json: '{}',
    created_at: '2026-08-21T00:00:00.000Z',
    updated_at: '2026-08-21T00:00:00.000Z',
    started_at: null,
    finished_at: null,
  }
}

test('RSS terminal wait returns the durable running job at its bounded deadline', async (t) => {
  if (skipIfSqliteUnavailable(t, 'rss terminal wait transitive sqlite guard')) return
  const manager = new RSSItemAnalysisManager()
  manager.getJob = () => job('running_script')
  const result = await manager.waitForTerminal('job-1', undefined, 0)
  assert.equal(result.status, 'running_script')
})

test('RSS terminal wait returns paused immediately and still honors cancellation', async () => {
  const manager = new RSSItemAnalysisManager()
  manager.getJob = () => job('paused')
  assert.equal((await manager.waitForTerminal('job-1')).status, 'paused')

  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    manager.waitForTerminal('job-1', abort.signal),
    /rss_analysis_wait_aborted/,
  )
})
