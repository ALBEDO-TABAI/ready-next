import { describe, it } from 'node:test'
import assert from 'node:assert'
import type { RSSAnalysisAction, RSSAnalysisJobStatus } from '../main/modules/database'

describe('RSS Analysis Contracts', () => {
  it('should cover supported actions and statuses', () => {
    const actions: RSSAnalysisAction[] = ['copy', 'visual']
    const statuses: RSSAnalysisJobStatus[] = [
      'queued',
      'paused',
      'running_script',
      'running_subagent',
      'success',
      'failed',
      'skipped',
    ]

    assert.ok(actions.includes('copy'))
    assert.ok(actions.includes('visual'))
    assert.ok(statuses.includes('running_script'))
    assert.ok(statuses.includes('running_subagent'))
    assert.ok(statuses.includes('paused'))
  })

  it('should represent progress payload with bounded range', () => {
    const progress = {
      itemId: 'rss-item-1',
      jobId: 'job-1',
      action: 'copy' as RSSAnalysisAction,
      status: 'running_script' as RSSAnalysisJobStatus,
      progress: 65,
      message: '脚本处理中',
      error: null,
      outputDir: '/tmp/rss-item-1/copy-analysis',
      reportPath: null,
      updatedAt: new Date().toISOString(),
    }

    assert.ok(progress.progress >= 0)
    assert.ok(progress.progress <= 100)
    assert.strictEqual(progress.status, 'running_script')
  })
})
