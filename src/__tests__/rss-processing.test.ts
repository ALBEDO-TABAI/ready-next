import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseManager } from '../main/modules/database'
import { RSSStore } from '../main/modules/database/rss-store'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { RSSProcessingService } from '../main/modules/rss-engine/processing-service'
import { buildRSSJudgmentInput, type RSSJudgmentInput } from '../main/modules/rss-engine/processing-judgment'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { ProviderOutputIncompleteError } from '../main/modules/agent-control/runtime-core/provider-output-status'

function fixture() {
  const db = new DatabaseManager(true)
  const source = db.rss.addRSSSource({ name: 'Source', url: 'https://example.test/feed' })
  const put = (id: string, title = 'A new release') => db.rss.upsertRSSItems([{ id, source_id: source, guid: id, title, link: `https://example.test/${id}`, summary: 'Version 2 supports video editing.' }])
  const store = db.rss.processing
  const clock = () => Date.UTC(2026, 9, 1, 12)
  const service = (complete?: (input: RSSJudgmentInput, signal: AbortSignal) => Promise<string>, hasModel = true) => new RSSProcessingService({
    store, getArticle: (id) => db.rss.content.getArticle(id), hasModel: () => hasModel, now: clock, notify: () => {},
    prepare: (input) => (signal) => complete ? complete(input, signal) : Promise.resolve(JSON.stringify({ decisions: input.definitions.map((d) => ({ definitionId: d.id, included: true, reason: 'Relevant update', evidence: 'Version 2' })) })),
  })
  return { db, source, put, store, service, clock }
}

test('automatic intake skips first import, ignores unchanged refresh and preserves manual decisions', async () => {
  const f = fixture()
  try {
    f.put('old'); assert.equal(f.store.list().total, 0)
    f.db.rss.setRSSSourceDraftSeeded(f.source, true)
    f.put('old'); assert.equal(f.store.list().total, 0)
    f.put('new'); assert.equal(f.store.list().total, 1)
    f.put('new'); assert.equal(f.store.list().total, 1)
    f.db.rss.markRSSRead('new'); f.db.rss.toggleRSSStarred('new')
    f.db.rss.organization.setManual({ itemId: 'new', expectedArticleRevision: f.db.rss.content.getArticle('new')!.revision, definitionId: 'curated', expectedRuleRevision: 1, decision: false })
    await f.service().wake()
    assert.equal(f.store.list().jobs[0].status, 'success')
    const m = f.db.rss.content.getArticle('new')!.classifications[0]
    assert.equal(m.included, false); assert.equal(m.origin, 'manual')
    f.db.rss.organization.setManual({ itemId: 'new', expectedArticleRevision: f.db.rss.content.getArticle('new')!.revision, definitionId: 'curated', expectedRuleRevision: 1, decision: null })
    assert.equal(f.db.rss.content.getArticle('new')!.classifications[0].included, true)
  } finally { f.db.close() }
})

test('rule changes and deleted or changed articles reject late results atomically', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    const worker = f.service(async (input) => {
      const definition = f.db.rss.organization.list().find((d) => d.id === 'curated')!
      f.db.rss.organization.save({ id: definition.id, name: definition.name, expectedRevision: definition.revision, description: 'Different criteria' })
      return JSON.stringify({ decisions: input.definitions.map((d) => ({ definitionId: d.id, included: true, reason: 'yes', evidence: 'Version 2' })) })
    })
    await worker.wake()
    assert.equal(f.store.list().jobs[0].status, 'stale')
    assert.deepEqual(f.db.rss.content.getArticle('one')!.classifications, [])
  } finally { f.db.close() }
})

test('no model, disabled automation and daily call limit do not drop pending work or retry unknown calls', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one'); f.put('two')
    await f.service(undefined, false).wake()
    assert.equal(f.store.list().jobs.filter((j) => j.startedAt !== null).length, 0)
    assert.equal(f.store.status(f.clock(), false).blocked, 'model')
    f.store.configure({ enabled: false, dailyLimit: 1 })
    await f.service().wake(); assert.equal(f.store.list().jobs.filter((j) => j.startedAt !== null).length, 0)
    f.store.configure({ enabled: true, dailyLimit: 1 })
    let calls = 0
    await f.service(async () => { calls++; throw new Error('Connection lost') }).wake()
    assert.equal(calls, 1); assert.equal(f.store.status(f.clock(), true).blocked, 'limit')
    assert.equal(f.store.list().jobs.filter((j) => j.status === 'unknown').length, 1)
    f.store.configure({ enabled: true, dailyLimit: 10 })
    await f.service().wake()
    assert.equal(f.store.list().jobs.filter((j) => j.status === 'unknown').length, 1)
    assert.equal(f.store.list().jobs.filter((j) => j.status === 'success').length, 1)
  } finally { f.db.close() }
})

test('all definition batches are consumed and status paging is shared with Agent without starting work', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 17; i++) f.db.rss.organization.save({ name: `Topic ${i}`, description: `Rule ${i}` })
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    assert.equal(f.store.list().total, 3)
    const context = { getProcessing: () => f.store, hasProcessingModel: () => true }
    const first = JSON.parse(await executeRSSTool('rss_read_processing', { limit: 1 }, context)).data
    f.put('two')
    const second = JSON.parse(await executeRSSTool('rss_read_processing', { limit: 10, offset: first.nextOffset, snapshot: first.snapshot }, context)).data
    assert.equal(second.total, 3); assert.equal(second.jobs.length, 2)
    assert.equal(new Set([...first.jobs, ...second.jobs].map((j: { id: string }) => j.id)).size, 3)
    assert.equal(f.store.status(f.clock(), true).callsToday, 0)
    const denied = JSON.parse(await executeRSSTool('rss_read_processing', {}, { ...context, readAccessDenied: true }))
    assert.equal(denied.ok, false)
    await f.service().wake()
    assert.equal(f.db.rss.content.getArticle('one')!.classifications.length, 18)
    assert.equal(f.store.status(f.clock(), true).callsToday, 6)
  } finally { f.db.close() }
})

test('deletion retains started attempts in the limit while rejecting late output', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    await f.service(async (input) => {
      f.db.rss.removeRSSSource(f.source)
      return JSON.stringify({ decisions: input.definitions.map((d) => ({ definitionId: d.id, included: true, reason: 'yes', evidence: 'Version 2' })) })
    }).wake()
    assert.equal(f.store.list().jobs[0].status, 'stale')
    assert.equal(f.store.status(f.clock(), true).callsToday, 1)
    assert.equal(f.db.rss.content.getArticle('one'), null)
  } finally { f.db.close() }
})

test('intake and queue commit together and an already idle worker wakes for newly saved items', async () => {
  const f = fixture()
  const runner = f.service()
  try {
    await runner.start()
    f.db.rss.setRSSSourceDraftSeeded(f.source, true)
    const raw = f.db.getRawDb()!
    raw.exec("CREATE TRIGGER fail_processing BEFORE INSERT ON rss_processing_jobs BEGIN SELECT RAISE(ABORT,'fixture'); END")
    assert.throws(() => f.put('rolled-back'), /fixture/)
    assert.equal(f.db.rss.content.getArticle('rolled-back'), null)
    raw.exec('DROP TRIGGER fail_processing')
    f.put('new')
    await new Promise((resolve) => setImmediate(resolve))
    await runner.wake()
    assert.equal(f.store.list().jobs[0].status, 'success')
    assert.equal(f.store.status(f.clock(), true).callsToday, 1)
  } finally { await runner.stop(); f.db.close() }
})

test('saved body continues eligible new-item processing without charging historical article reads', async () => {
  const f = fixture()
  try {
    f.put('history')
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('new')
    for (const id of ['history', 'new']) {
      const claim = f.db.rss.content.beginLoad(id)!
      assert.equal(f.db.rss.content.finishLoad(claim, { status: 'ready', markdown: 'Version 2 full content', sourceUrl: `https://example.test/${id}` }), true)
    }
    assert.equal(f.store.list({ itemId: 'history' }).total, 0)
    assert.equal(f.store.list({ itemId: 'new' }).total, 2)
    await f.service().wake()
    assert.equal(f.store.list({ itemId: 'new' }).jobs.filter((j) => j.status === 'success').length, 1)
    assert.equal(f.store.status(f.clock(), true).callsToday, 1)
    assert.equal(f.db.rss.content.getArticle('new')!.classifications[0].stale, false)
  } finally { f.db.close() }
})

test('explicit request takes over paused automatic work; display names never enter semantic criteria', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    const original = f.store.list().jobs[0]
    f.store.configure({ enabled: false, dailyLimit: 100 })
    const ids = f.store.enqueue('one', 'manual', original.articleRevision)
    assert.notEqual(ids[0], original.id)
    assert.equal(f.store.get(original.id)!.status, 'canceled')
    let received = ''
    const before = f.db.rss.organization.list().find((d) => d.id === 'curated')!
    f.db.rss.organization.save({ id: before.id, expectedRevision: before.revision, name: 'Name contains do not curate anything', description: before.description })
    await f.service(async (input) => { received = JSON.stringify(input); return JSON.stringify({ decisions: [{ definitionId: 'curated', included: true, reason: 'Relevant', evidence: 'Version 2' }] }) }).wake()
    assert.equal(f.store.get(ids[0])!.status, 'success')
    assert.ok(!received.includes('Name contains')); assert.ok(!received.includes('精选'))
    assert.equal(f.store.status(f.clock(), true).callsToday, 1)
  } finally { f.db.close() }
})

test('cancel and restart never publish old receipts; explicit retry remains separate and budgeted', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    const job = f.store.list().jobs[0]
    assert.ok(f.store.claim(job.id, f.clock(), true))
    f.store.recover()
    assert.equal(f.store.list().jobs[0].status, 'unknown')
    await f.service().wake(); assert.deepEqual(f.db.rss.content.getArticle('one')!.classifications, [])
    const retried = f.store.enqueue('one', 'manual')
    assert.equal(retried.length, 1)
    const runner = f.service(async (input) => {
      runner.cancel(retried[0])
      return JSON.stringify({ decisions: input.definitions.map((d) => ({ definitionId: d.id, included: true, reason: 'yes', evidence: 'Version 2' })) })
    })
    await runner.wake()
    assert.equal(f.store.get(retried[0])!.status, 'canceled')
    assert.deepEqual(f.db.rss.content.getArticle('one')!.classifications, [])
    assert.equal(f.store.status(f.clock(), true).callsToday, 2)
  } finally { f.db.close() }
})

test('invalid semantic output is a visible failure and long input is explicitly bounded', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one', 'X'.repeat(3000))
    const article = f.db.rss.content.getArticle('one')!
    const input = buildRSSJudgmentInput(article, f.store.list().jobs[0].definitions)
    assert.equal(input.source.titleTruncated, true)
    await f.service(async () => JSON.stringify({ decisions: [{ definitionId: 'curated', included: true, reason: 'yes', evidence: 'not present' }] })).wake()
    assert.equal(f.store.list().jobs[0].status, 'failed')
    assert.deepEqual(f.db.rss.content.getArticle('one')!.classifications, [])
  } finally { f.db.close() }
})

test('preflight capacity failure is not a started call; acknowledged incomplete output is failed, not unknown', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    const preflight = new RSSProcessingService({ store: f.store, getArticle: (id) => f.db.rss.content.getArticle(id),
      hasModel: () => true, now: f.clock, notify: () => {}, prepare: () => { throw new Error('model capacity insufficient') } })
    await preflight.wake()
    assert.equal(f.store.list().jobs[0].status, 'failed'); assert.equal(f.store.status(f.clock(), true).callsToday, 0)
    const [retry] = f.store.enqueue('one', 'manual')
    await f.service(async () => { throw new ProviderOutputIncompleteError() }).wake()
    assert.equal(f.store.get(retry)!.status, 'failed')
    assert.doesNotMatch(f.store.get(retry)!.message!, /未知/)
    assert.equal(f.store.status(f.clock(), true).callsToday, 1)
  } finally { f.db.close() }
})

test('real disk reopen preserves unknown attempts and continues only unstarted work', async () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'rss-processing-reopen-'))
  const path = join(directory, 'ready.db')
  let reopened: DatabaseConnection | undefined
  let worker: RSSProcessingService | undefined
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('started'); f.put('pending')
    const started = f.store.list({ itemId: 'started' }).jobs[0]
    f.store.claim(started.id, f.clock(), true)
    f.db.getRawDb()!.prepare('VACUUM INTO ?').run(path)
    f.db.close()
    const SQLite = createRequire(import.meta.url)('better-sqlite3')
    reopened = new SQLite(path)
    const rss = new RSSStore(() => reopened || null)
    let calls = 0
    worker = new RSSProcessingService({ store: rss.processing, getArticle: (id) => rss.content.getArticle(id), hasModel: () => true, now: f.clock, notify: () => {},
      prepare: (input) => async () => { calls++; return JSON.stringify({ decisions: input.definitions.map((d) => ({ definitionId: d.id, included: true, reason: 'Relevant', evidence: 'Version 2' })) }) } })
    await worker.start()
    assert.equal(rss.processing.get(started.id)!.status, 'unknown')
    assert.equal(rss.processing.list({ itemId: 'pending' }).jobs[0].status, 'success')
    assert.equal(rss.processing.status(f.clock(), true).callsToday, 2)
    assert.equal(calls, 1)
  } finally { await worker?.stop(); reopened?.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('failure to commit a successful task rolls back its derived memberships', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    f.db.getRawDb()!.exec("CREATE TRIGGER fail_result BEFORE UPDATE OF status ON rss_processing_jobs WHEN NEW.status='success' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END")
    await f.service().wake()
    assert.equal(f.store.list().jobs[0].status, 'failed')
    assert.deepEqual(f.db.rss.content.getArticle('one')!.classifications, [])
    assert.equal(f.store.status(f.clock(), true).callsToday, 1)
  } finally { f.db.close() }
})
