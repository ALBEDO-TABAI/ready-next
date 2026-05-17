import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RSSAnalysisAction, RSSAnalysisJobStatus } from '../main/modules/database'
import { findReusableVideoFile } from '../main/modules/rss-engine/item-analysis-manager'

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

  it('should reuse the copy-analysis source video before visual derivatives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rss-video-reuse-'))
    try {
      const copyDir = join(root, 'copy-analysis')
      const sceneDir = join(root, 'visual-analysis', 'BV1h9Ln6DEJE', 'scenes')
      mkdirSync(copyDir, { recursive: true })
      mkdirSync(sceneDir, { recursive: true })
      const copyVideo = join(copyDir, 'BV1h9Ln6DEJE.mp4')
      writeFileSync(copyVideo, 'source-video')
      writeFileSync(join(sceneDir, 'BV1h9Ln6DEJE-Scene-001.mp4'), 'scene-clip')

      const hit = await findReusableVideoFile(root, 'https://www.bilibili.com/video/BV1h9Ln6DEJE/')

      assert.strictEqual(hit, copyVideo)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('should reuse a visual-analysis original video for later copy analysis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rss-video-reuse-visual-'))
    try {
      const visualDir = join(root, 'visual-analysis', 'BV1h9Ln6DEJE')
      mkdirSync(visualDir, { recursive: true })
      const visualVideo = join(visualDir, 'BV1h9Ln6DEJE.mp4')
      writeFileSync(visualVideo, 'source-video')

      const hit = await findReusableVideoFile(root, 'https://www.bilibili.com/video/BV1h9Ln6DEJE/')

      assert.strictEqual(hit, visualVideo)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
