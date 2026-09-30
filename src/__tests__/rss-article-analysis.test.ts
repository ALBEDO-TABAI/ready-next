import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseManager } from '../main/modules/database'
import type { RSSAnalysisJob } from '../main/modules/database/records'
import { RSSRepository } from '../main/modules/repositories/rss-repository'
import { RSSItemAnalysisManager } from '../main/modules/rss-engine/item-analysis-manager'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { readAnalysisReport } from '../main/modules/rss-engine/analysis-report'

function fixture(summarize: (text: string) => Promise<string>, partial = false) {
  const db = new DatabaseManager(true)
  const root = mkdtempSync(join(tmpdir(), 'rss-article-analysis-'))
  const sourceId = db.rss.addRSSSource({ name: 'Authoritative source', url: 'https://example.test/feed' })
  const item = { id: 'article', source_id: sourceId, guid: 'article', title: 'Saved title', link: 'https://example.test/article', summary: 'Saved summary' }
  db.rss.upsertRSSItems([item])
  const text = '# Original article\n\n' + '正文内容😀。'.repeat(4000) + '\nTAIL-MUST-REACH-MODEL'
  db.rss.content.finishLoad(db.rss.content.beginLoad(item.id)!, { status: partial ? 'partial' : 'ready', markdown: text, sourceUrl: item.link })
  const repository = new RSSRepository()
  for (const name of ['markInterruptedRSSAnalysisJobs', 'findActiveRSSAnalysisJob', 'createRSSAnalysisJob', 'getRSSAnalysisJob', 'listRSSAnalysisJobs', 'getLatestRSSAnalysisByItemIds'] as const) {
    Object.defineProperty(repository, name, { value: db.rss[name].bind(db.rss) })
  }
  repository.getContentStore = () => db.rss.content
  let terminal!: (job: RSSAnalysisJob) => void
  const finished = new Promise<RSSAnalysisJob>((resolve) => { terminal = resolve })
  repository.updateRSSAnalysisJob = (id, patch) => {
    const result = db.rss.updateRSSAnalysisJob(id, patch)
    if (result && (patch.status === 'success' || patch.status === 'failed')) terminal(result)
    return result
  }
  const manager = new RSSItemAnalysisManager({
    repository,
    articleAnalysis: {
      read: (id) => db.rss.content.getArticle(id),
      load: async (id) => db.rss.content.getArticle(id)!,
      summarize: async (input) => {
        assert.equal(input.title, item.title)
        assert.equal(input.link, item.link)
        assert.equal(input.extractedText, text)
        assert.ok(input.sourceScope)
        return summarize(input.extractedText)
      },
    },
  })
  const start = () => {
    manager.initialize()
    return manager.startItemAnalysis({ itemId: item.id, action: 'copy', title: 'Untrusted title', link: 'https://wrong.test', targetDir: root })
  }
  return { db, root, text, item, manager, start, finished, close: () => { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('web analysis publishes the exact shared article and an honest partial-input report', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS canonical article analysis')) return
  const f = fixture(async () => 'Analysis of the supplied source.', true)
  try {
    const queued = await f.start()
    assert.equal(queued.title, 'Saved title')
    const result = await f.finished
    assert.equal(result.status, 'success')
    assert.equal(JSON.parse(readFileSync(join(result.output_dir, '网页原文.json'), 'utf8')).markdown, f.text)
    assert.match(readFileSync(result.report_path!, 'utf8'), /仅基于已获取的部分正文/)
    const meta = JSON.parse(result.meta_json!)
    assert.equal(meta.reportArtifact.jobId, result.id)
    assert.equal(readAnalysisReport(result).text, readFileSync(result.report_path!, 'utf8'))
    assert.equal(meta.articleSource.revision, f.db.rss.content.getArticle(f.item.id)?.revision)
    assert.match(f.manager.getItemProgress([f.item.id])[f.item.id].sourceWarning!, /部分正文/)
    f.db.rss.upsertRSSItems([{ ...f.item, title: 'Updated source' }])
    assert.match(f.manager.getItemProgress([f.item.id])[f.item.id].sourceWarning!, /旧版本/)
    const readback = JSON.parse(await executeRSSTool('rss_read_article', { itemId: f.item.id }, {
      getContent: () => f.db.rss.content,
      getAnalysisProgress: (ids) => f.manager.getItemProgress(ids),
    }))
    assert.equal(readback.ok, true)
    assert.equal(readback.analysis.jobId, result.id)
    assert.equal(readback.analysis.reportPath, result.report_path)
    assert.match(readback.analysis.sourceWarning, /旧版本/)
    assert.equal(f.manager.listJobs(f.item.id).length, 1, 'a later Agent read must not create or restart analysis')
    assert.equal(f.db.rss.getRSSAnalysisJob(result.id)?.status, 'success', 'historical completion stays historical')
    assert.equal(dirname(result.output_dir).endsWith('copy-analysis'), true)
  } finally { f.close() }
})

test('a source change while the model runs cannot publish a successful current report', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS stale article report')) return
  let entered!: () => void, release!: (value: string) => void
  const called = new Promise<void>((resolve) => { entered = resolve })
  const f = fixture(async () => { entered(); return new Promise((resolve) => { release = resolve }) })
  try {
    await f.start()
    await called
    f.db.rss.upsertRSSItems([{ ...f.item, title: 'Changed during analysis' }])
    release('Old-version analysis')
    const result = await f.finished
    assert.equal(result.status, 'failed')
    assert.equal(result.report_path, null)
    assert.match(result.error!, /原文已更新/)
  } finally { f.close() }
})

test('reading old analysis history is pure and startup recovery never sweeps retained jobs', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS retained analysis history')) return
  const f = fixture(async () => 'New analysis')
  try {
    for (let index = 0; index < 503; index++) {
      f.db.rss.createRSSAnalysisJob({ id: `history-${index}`, itemId: f.item.id, action: 'copy', sourceUrl: f.item.link,
        title: f.item.title, targetDir: f.root, outputDir: f.root,
        status: index === 0 ? 'queued' : index === 1 ? 'paused' : 'success', progress: 100, message: '旧任务正在排队' })
    }
    const sql = f.db.getRawDb()!
    sql.exec("UPDATE rss_analysis_jobs SET updated_at='2000-01-01T00:00:00.000Z'")
    const rows = () => sql.prepare('SELECT * FROM rss_analysis_jobs ORDER BY id').all()
    const before = rows()
    f.manager.listJobs()
    f.manager.getItemProgress()
    await executeRSSTool('rss_read_article', { itemId: f.item.id }, {
      getContent: () => f.db.rss.content, getAnalysisProgress: (ids) => f.manager.getItemProgress(ids),
    })
    assert.deepEqual(rows(), before, 'all read surfaces must preserve old rows and interrupted state')
    await assert.rejects(f.manager.startItemAnalysis({ itemId: f.item.id, action: 'copy', title: f.item.title,
      link: f.item.link, targetDir: f.root }), /启动恢复/)
    assert.deepEqual(rows(), before, 'rejected admission must not perform implicit recovery')
    f.manager.initialize()
    assert.equal(rows().length, 503)
    assert.equal(f.db.rss.getRSSAnalysisJob('history-0')?.status, 'failed')
    assert.equal(f.db.rss.getRSSAnalysisJob('history-0')?.message, '任务因应用重启而中断')
    assert.equal(f.db.rss.getRSSAnalysisJob('history-1')?.status, 'paused')
    assert.equal(f.db.rss.getRSSAnalysisJob('history-2')?.status, 'success')
    f.db.rss.updateRSSAnalysisJob('history-0', { status: 'queued' })
    f.manager.initialize()
    f.manager.listJobs()
    assert.equal(f.db.rss.getRSSAnalysisJob('history-0')?.status, 'queued', 'rebinding cannot interrupt a newly admitted job')
    f.db.rss.updateRSSAnalysisJob('history-0', { status: 'failed' })
    await f.start()
    assert.equal((await f.finished).status, 'success')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(rows().length, 504, 'completion must not sweep retained history')
  } finally { f.close() }
})

test('failed startup recovery remains retryable and does not admit tasks', async () => {
  const repository = new RSSRepository()
  let attempts = 0
  repository.markInterruptedRSSAnalysisJobs = () => {
    if (++attempts === 1) throw new Error('database unavailable')
    return 0
  }
  const manager = new RSSItemAnalysisManager({ repository })
  assert.throws(() => manager.initialize(), /database unavailable/)
  await assert.rejects(manager.startItemAnalysis({ itemId: 'none', action: 'copy', title: '', link: '', targetDir: '' }), /启动恢复/)
  manager.initialize()
  manager.initialize()
  assert.equal(attempts, 2)
})
