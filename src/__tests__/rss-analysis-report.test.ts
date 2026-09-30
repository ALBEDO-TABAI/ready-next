import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseManager } from '../main/modules/database'
import type { RSSAnalysisJob } from '../main/modules/database/records'
import { RSSRepository } from '../main/modules/repositories/rss-repository'
import { RSSItemAnalysisManager } from '../main/modules/rss-engine/item-analysis-manager'
import { rssSubagentRunner } from '../main/modules/rss-engine/subagent-runner'
import { readAnalysisReport } from '../main/modules/rss-engine/analysis-report'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('all report producers keep separate task files and publish verified identities', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS report publication')) return
  const db = new DatabaseManager(true)
  const root = mkdtempSync(join(tmpdir(), 'rss-report-publication-'))
  const repo = new RSSRepository()
  for (const name of ['markInterruptedRSSAnalysisJobs', 'findActiveRSSAnalysisJob', 'createRSSAnalysisJob',
    'getRSSAnalysisJob', 'listRSSAnalysisJobs', 'getLatestRSSAnalysisByItemIds'] as const) {
    Object.defineProperty(repo, name, { value: db.rss[name].bind(db.rss), configurable: true })
  }
  repo.getContentStore = () => db.rss.content
  let resolveJob: (job: RSSAnalysisJob) => void = () => {}
  let rejectPublication = false
  repo.updateRSSAnalysisJob = (id, patch) => {
    if (rejectPublication && patch.status === 'success') throw new Error('simulated publication failure')
    const result = db.rss.updateRSSAnalysisJob(id, patch)
    if (result && (patch.status === 'success' || patch.status === 'failed')) resolveJob(result)
    return result
  }
  let generation = 0
  const sourceId = db.rss.addRSSSource({ name: 'Reports', url: 'https://example.test/rss' })
  const web = { id: 'web', source_id: sourceId, guid: 'web', title: 'Web', link: 'https://example.test/article', summary: 'web' }
  const video = { ...web, id: 'video', guid: 'video', title: 'Video', link: 'https://example.test/video.mp4' }
  db.rss.upsertRSSItems([web, video])
  db.rss.content.finishLoad(db.rss.content.beginLoad(web.id)!, { status: 'ready', markdown: 'Saved body', sourceUrl: web.link })
  // Only paid/network boundaries are replaced; queue, files, publication and SQLite are real.
  t.mock.method(rssSubagentRunner, 'buildCopyDeliverables', async () => ({ correctedTranscript: 'Corrected', structuredTranscript: 'Structured', report: `Copy ${++generation}` }))
  t.mock.method(rssSubagentRunner, 'summarizeVisual', async () => `Visual ${++generation}`)
  const manager = new RSSItemAnalysisManager({ repository: repo,
    runCopySkill: async (input) => {
      const transcriptPath = join(input.params.outputDir as string, 'video_文字稿.md')
      writeFileSync(transcriptPath, 'Original transcript')
      return { success: true, skillId: input.skillId, action: input.action, command: [], outputs: { transcriptPath }, stdout: '', stderr: '' }
    },
    articleAnalysis: { read: (id) => db.rss.content.getArticle(id), load: async (id) => db.rss.content.getArticle(id)!, summarize: async () => `Web ${++generation} 😀 saved text` },
    startSkillChildRunAndWait: async (input) => {
      writeFileSync(join(input.params.outputDir as string, 'scene_scores.json'), '{"scenes":[]}')
      return { success: true, status: 'completed', childRunId: 'isolated-report-test', closeEvent: null }
    },
  })
  manager.initialize()
  const run = async (itemId: string, action: 'copy' | 'visual') => {
    const finished = new Promise<RSSAnalysisJob>((resolve) => { resolveJob = resolve })
    await manager.startItemAnalysis({ itemId, action, title: 'ignored', link: 'ignored', targetDir: root, force: true })
    const result = await finished
    await new Promise((resolve) => setImmediate(resolve))
    return result
  }
  try {
    for (const [itemId, action] of [['web', 'copy'], ['video', 'copy'], ['video', 'visual']] as const) {
      const first = await run(itemId, action)
      assert.equal(first.status, 'success', first.error || '')
      const original = readAnalysisReport(first)
      const second = await run(itemId, action)
      assert.equal(second.status, 'success', second.error || '')
      assert.notEqual(first.output_dir, second.output_dir)
      assert.deepEqual(readAnalysisReport(db.rss.getRSSAnalysisJob(first.id)!), original)
      assert.notEqual(readAnalysisReport(second).artifact.sha256, original.artifact.sha256)
      assert.equal(original.artifact.jobId, first.id)
    }
    rejectPublication = true
    const failed = await run('web', 'copy')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.report_path, null)
    assert.equal(JSON.parse(failed.meta_json!).reportArtifact, undefined)
    assert.throws(() => readAnalysisReport(failed), /尚未成功/)
    rejectPublication = false
    const legacyPath = join(root, 'legacy.md')
    writeFileSync(legacyPath, 'Legacy file must stay unchanged')
    db.rss.createRSSAnalysisJob({ id: 'legacy-paused', itemId: web.id, action: 'copy', sourceUrl: web.link,
      title: web.title, targetDir: root, outputDir: root, reportPath: legacyPath, status: 'paused', progress: 5,
      metaJson: JSON.stringify({ sourceRevision: db.rss.content.getArticle(web.id)!.sourceRevision }) })
    const resumed = new Promise<RSSAnalysisJob>((resolve) => { resolveJob = resolve })
    manager.resumeJob('legacy-paused')
    const resumedJob = await resumed
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(resumedJob.status, 'success')
    assert.equal(resumedJob.output_dir.endsWith('copy-analysis/legacy-paused'), true)
    assert.equal(readFileSync(legacyPath, 'utf8'), 'Legacy file must stay unchanged')
    const createJob = db.rss.createRSSAnalysisJob.bind(db.rss)
    Object.defineProperty(repo, 'createRSSAnalysisJob', { value: (input: Parameters<typeof createJob>[0]) => {
      const job = createJob(input)
      mkdirSync(join(job.output_dir, '文案分析报告.md'))
      return job
    }, configurable: true })
    const fileFailed = await run('web', 'copy')
    assert.equal(fileFailed.status, 'failed')
    assert.equal(fileFailed.report_path, null)
    assert.equal(JSON.parse(fileFailed.meta_json!).reportArtifact, undefined)
    Object.defineProperty(repo, 'createRSSAnalysisJob', { value: createJob })
    const success = await run('web', 'copy')
    const context = { readAnalysisReport: (input: Parameters<typeof manager.readReport>[0]) => manager.readReport(input) }
    const denied = JSON.parse(await executeRSSTool('rss_read_analysis_report', { jobId: success.id }, { ...context, readAccessDenied: true }))
    assert.equal(denied.ok, false)
    const first = JSON.parse(await executeRSSTool('rss_read_analysis_report', { jobId: success.id, length: 13 }, context))
    assert.equal(first.ok, true)
    let text = first.data.text, offset = first.data.nextOffset
    while (offset !== null) {
      const page = manager.readReport({ jobId: success.id, offset, length: 13, expectedRevision: first.data.revision })
      text += page.text
      offset = page.nextOffset
    }
    assert.equal(text, readAnalysisReport(success).text)
    assert.throws(() => manager.readReport({ jobId: success.id, offset: 13 }), /版本缺失/)
    assert.throws(() => manager.readReport({ jobId: success.id, expectedRevision: '0'.repeat(64) }), /版本缺失/)
    db.rss.removeRSSSource(sourceId)
    assert.match(manager.readReport({ jobId: success.id }).sourceWarning!, /更新或删除/)
    assert.throws(() => readAnalysisReport({ ...success, meta_json: '{}' }), /历史报告/)
    const bytes = readFileSync(success.report_path!)
    writeFileSync(success.report_path!, 'Replaced report')
    assert.throws(() => readAnalysisReport(success), /已变化/)
    writeFileSync(success.report_path!, bytes)
    const outside = join(root, 'outside.md')
    writeFileSync(outside, bytes)
    unlinkSync(success.report_path!)
    symlinkSync(outside, success.report_path!)
    assert.throws(() => readAnalysisReport(success), /移出任务目录/)
    db.rss.deleteRSSAnalysisJob(success.id)
    assert.throws(() => manager.readReport({ jobId: success.id }), /不存在/)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
