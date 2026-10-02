import ts from 'typescript'
import { captureAnalysisReport } from '../main/modules/rss-engine/analysis-report'
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseManager } from '../main/modules/database'
import type { RSSAnalysisJob } from '../main/modules/database/records'
import { RSSRepository } from '../main/modules/repositories/rss-repository'
import { RSSItemAnalysisManager } from '../main/modules/rss-engine/item-analysis-manager'
import { rssSubagentRunner } from '../main/modules/rss-engine/subagent-runner'
import { readAnalysisReport } from '../main/modules/rss-engine/analysis-report'
import { readAnalysisAssets } from '../main/modules/rss-engine/analysis-assets'
import type { RSSAnalysisAssetKind } from '../shared/rss-analysis-assets'
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
  t.mock.method(rssSubagentRunner, 'buildCopyDeliverables', async () => ({ correctedTranscript: 'Corrected😀 '.repeat(2000) + 'TRANSCRIPT-END', structuredTranscript: 'Structured', report: `Copy ${++generation}` }))
  t.mock.method(rssSubagentRunner, 'summarizeVisual', async () => `Visual ${++generation}`)
  const manager = new RSSItemAnalysisManager({ repository: repo,
    runCopySkill: async (input) => {
      const transcriptPath = join(input.params.outputDir as string, 'video_文字稿.md')
      writeFileSync(transcriptPath, 'Original transcript')
      const videoPath = String(input.params.input).startsWith('http') ? join(input.params.outputDir as string, 'video.mp4') : String(input.params.input)
      if (!existsSync(videoPath)) writeFileSync(videoPath, 'SYNTHETIC-FILE-NOT-A-DECODED-VIDEO')
      return { success: true, skillId: input.skillId, action: input.action, command: [], outputs: { transcriptPath, videoPath }, stdout: '', stderr: '' }
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
    let savedVideoJob!: RSSAnalysisJob
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
      const assets = manager.readAssets({ jobId: first.id })
      assert.ok('entries' in assets)
      const roles: RSSAnalysisAssetKind[] = itemId === 'web' ? ['source_article'] : action === 'copy' ? ['corrected_transcript', 'structured_transcript'] : ['scene_scores']
      for (const kind of roles) {
        const receipt = JSON.parse(first.meta_json!).analysisAssets[kind]
        let offset = 0, text = ''
        do {
          const part = manager.readAssets({ jobId: first.id, kind, offset, length: 1023, expectedRevision: receipt.sha256 })
          assert.ok('text' in part && typeof part.text === 'string')
          text += part.text
          offset = part.nextOffset ?? -1
        } while (offset >= 0)
        assert.equal(text, readFileSync(join(first.output_dir, receipt.fileName), 'utf8'))
      }
      if (itemId === 'video') {
        savedVideoJob = first
        const media = manager.readAssets({ jobId: first.id, kind: 'source_video' })
        assert.ok('contentRead' in media && media.contentRead === false)
        assert.ok('state' in media && media.state === 'available')
        assert.throws(() => manager.readAssets({ jobId: first.id, kind: roles[0], offset: 1 }), /版本缺失/)
      }
    }
    const legacy = readAnalysisAssets({ jobId: savedVideoJob.id }, () => ({ ...savedVideoJob, meta_json: '{}' }))
    assert.equal(legacy.state, 'unverifiable', 'unbound legacy manifests cannot grant artifact access')
    const videoRef = manager.readAssets({ jobId: savedVideoJob.id, kind: 'source_video' })
    assert.ok('path' in videoRef && typeof videoRef.path === 'string')
    writeFileSync(videoRef.path, 'Changed bytes')
    const changed = manager.readAssets({ jobId: savedVideoJob.id, kind: 'source_video' })
    assert.ok('state' in changed && changed.state === 'changed')
    unlinkSync(videoRef.path)
    const missing = manager.readAssets({ jobId: savedVideoJob.id })
    assert.ok('entries' in missing && missing.entries?.some((entry) => entry.kind === 'source_video' && entry.state === 'missing'))
    rejectPublication = true
    const failed = await run('web', 'copy')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.report_path, null)
    assert.equal(JSON.parse(failed.meta_json!).reportArtifact, undefined)
    assert.equal(JSON.parse(failed.meta_json!).analysisAssets, undefined)
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
    const assetsRead = JSON.parse(await executeRSSTool('rss_read_analysis_assets', { jobId: success.id, kind: 'source_article' }, { readAnalysisAssets: (input) => manager.readAssets(input) }))
    assert.equal(assetsRead.ok, true)
    assert.match(assetsRead.data.text, /Saved body/)
    const assetsDenied = JSON.parse(await executeRSSTool('rss_read_analysis_assets', { jobId: success.id }, { readAccessDenied: true, readAnalysisAssets: () => { throw new Error('must not read') } }))
    assert.equal(assetsDenied.error, 'rss_read_not_authorized')
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
    const retainedInput = manager.readAssets({ jobId: success.id, kind: 'source_article' })
    assert.ok('text' in retainedInput && retainedInput.text?.includes('Saved body'), 'source deletion preserves the published input snapshot')
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


test('the production Codex analysis-result port consumes the shared published report identity', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS production report consumer')) return
  const db = new DatabaseManager(true), root = mkdtempSync(join(tmpdir(), 'rss-production-report-'))
  try {
    const source = db.rss.addRSSSource({ name: 'Reports', url: 'https://report.invalid/feed' })
    db.rss.upsertRSSItems([{ id: 'article', source_id: source, guid: 'article', title: 'Article', link: 'https://report.invalid/article', summary: 'Saved source' }])
    const path = join(root, '文案分析报告.md'); writeFileSync(path, '😀Verified report')
    const job = db.rss.createRSSAnalysisJob({ id: 'job', itemId: 'article', action: 'copy', sourceUrl: 'https://report.invalid/article', title: 'Article', targetDir: root, outputDir: root, status: 'running_subagent', progress: 98 })
    const artifact = captureAnalysisReport({ ...job, report_path: path })
    db.rss.updateRSSAnalysisJob(job.id, { status: 'success', reportPath: path, metaJson: JSON.stringify({ reportArtifact: artifact }) })
    const repo = new RSSRepository()
    Object.defineProperty(repo, 'getRSSAnalysisJob', { value: db.rss.getRSSAnalysisJob.bind(db.rss) })
    repo.getContentStore = () => db.rss.content
    const manager = new RSSItemAnalysisManager({ repository: repo })
    // Execute the actual production method body; replace only its singleton import.
    const filename = join(process.cwd(), 'src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts')
    const sourceFile = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
    let method: ts.MethodDeclaration | undefined
    const visit = (node: ts.Node) => { if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === 'getAnalysisResult') method = node; ts.forEachChild(node, visit) }
    visit(sourceFile); assert.ok(method?.body)
    const body = method!.body!.getText(sourceFile).replace("const { getRSSItemAnalysisManager } = await import('../../rss-engine/item-analysis-manager')", '')
    const compiled = ts.transpile(`async function port(payload) ${body}`, { target: ts.ScriptTarget.ES2022 })
    const port = new Function('getRSSItemAnalysisManager', 'abortSignal', compiled + '; return port')(() => manager, new AbortController().signal)
    const result = await port({ jobId: job.id })
    assert.equal(result.ok, true); assert.equal(result.reportDigest, artifact.sha256); assert.equal(result.reportPath, path)
    writeFileSync(path, 'Changed bytes')
    await assert.rejects(port({ jobId: job.id }), /文件已变化/)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
