/** Explicit live evaluation: a seeded reference plus seven new synthetic articles, no retries. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseManager } from '../src/main/modules/database'
import { AppSettingsRepository } from '../src/main/modules/repositories/app-settings-repository'
import { RSSProcessingService } from '../src/main/modules/rss-engine/processing-service'
import { RSS_JUDGMENT_INSTRUCTIONS } from '../src/main/modules/rss-engine/processing-judgment'
import { completeRSSModel, isRSSModelConfigured } from '../src/main/modules/rss-engine/model-completion'

const fixtures = [
  { id: 'original', kind: 'new', title: 'Atlas 2 launches', author: 'Lumen', date: '2026-09-20', text: 'On September 20, 2026, Lumen released Atlas 2, an AI video editing application. This announcement is the initial global product release.' },
  { id: 'chinese-reprint', kind: 'duplicate', title: 'Lumen 的 Atlas 2 视频编辑工具已发布', author: '行业转载', date: '2026-09-21', text: '本文转载 Lumen 9 月 20 日的官方发布：Atlas 2 是一款 AI 视频编辑应用。这是同一次全球产品发布的中文报道，没有新增产品进展。' },
  { id: 'japanese-report', kind: 'duplicate', title: 'Atlas 2 のリリースを紹介', author: '日本語ニュース', date: '2026-09-22', text: 'Lumen は2026年9月20日にAI動画編集アプリ Atlas 2 を世界向けに公開した。本記事はその発表を日本語で紹介するもので、新機能の追加や別地域への展開を発表するものではない。' },
  { id: 'new-feature', kind: 'progress', title: 'Atlas 2 adds offline video editing', author: 'Lumen', date: '2026-09-24', text: 'On September 24, Lumen added offline video editing to Atlas 2. This capability was not included in the September 20 initial release.' },
  { id: 'unrelated-company-news', kind: 'new', title: 'Lumen raises new funding', author: 'Lumen', date: '2026-09-25', text: 'On September 25, Lumen announced a twelve-million-dollar financing round. This is a corporate financing event, with no announcement about Atlas 2 features, distribution, or release plans.' },
  { id: 'same-title-other-entity', kind: 'new', title: 'Atlas 2 launches', author: 'Boreal Robotics', date: '2026-09-26', text: 'Boreal Robotics released its Atlas 2 warehouse robot on September 26. This physical robot has no affiliation with Lumen or its video editing application, despite the identical product name.' },
  { id: 'insufficient-preview', kind: 'insufficient', title: 'Atlas 2 launches', author: null, date: '2026-09-27', text: 'Subscribe to read the full article. The preview does not identify the publisher, company, product type, or event date.' },
  { id: 'correction', kind: 'progress', title: 'Correction to the Atlas 2 offline capability announcement', author: 'Lumen', date: '2026-09-28', text: 'On September 28, Lumen corrected its September 24 Atlas 2 announcement: offline video editing is not available. The earlier statement was incorrect. This correction concerns the already released Lumen video editor, not the Boreal robot.' },
] as const
const [reference, ...allCases] = fixtures

async function main() {
  const [settingsPath, evidence, firstCase] = process.argv.slice(2)
  assert.ok(settingsPath && evidence, 'usage: Electron --import tsx scripts/evaluate-rss-events.ts <settings-db> <evidence-dir>')
  const firstIndex = firstCase ? allCases.findIndex((entry) => entry.id === firstCase) : 0
  assert.ok(firstIndex >= 0, 'unknown first case')
  const cases = allCases.slice(firstIndex)
  const SQLite = createRequire(import.meta.url)('better-sqlite3')
  const settingsDb = new SQLite(settingsPath, { readonly: true, fileMustExist: true })
  const values = new Map<string, string>(settingsDb.prepare("SELECT key,value FROM settings WHERE key IN ('ai_provider_workspace','ai_model_config','ai_saved_configs')").all().map((row: { key: string; value: string }) => [row.key, row.value]))
  settingsDb.close()
  const settings = new AppSettingsRepository()
  settings.getSetting = (key) => values.get(key)
  settings.setSetting = (key, value) => { values.set(key, value) } // Legacy normalization stays in memory; never mutate the user's settings.
  const config = settings.getAIConfig()
  assert.ok(isRSSModelConfigured(config), 'the selected model is not configured')
  mkdirSync(evidence, { recursive: true })
  const db = new DatabaseManager(true), rss = db.rss
  const results: unknown[] = [], requests: Array<{ jobId: string; input: unknown; output?: string }> = []
  const wireReads: Promise<void>[] = []
  const originalFetch = globalThis.fetch
  let wireIndex = 0
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(target).origin === new URL(config.baseUrl!).origin) {
      const index = ++wireIndex
      wireReads.push(response.clone().text().then((body) => {
        writeFileSync(join(evidence, `wire-${index}.txt`), body.split(config.apiKey!).join('[redacted]'), { mode: 0o600 })
      }).catch(() => { writeFileSync(join(evidence, `wire-${index}-interrupted.txt`), 'Response capture did not finish.') }))
    }
    return response
  }
  let complete = false
  const persist = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify({ runSucceeded: complete, requestedCases: cases.map((entry) => entry.id), skippedPriorCases: allCases.slice(0, firstIndex).map((entry) => entry.id), provider: config.provider, model: config.model, seededReference: reference, maxCalls: cases.length,
    calls: requests.length, results, requests, jobs: rss.processing.list({ limit: 100 }).jobs }, null, 2))
  const service = new RSSProcessingService({ store: rss.processing, getArticle: (id) => rss.content.getArticle(id), hasModel: () => true,
    now: () => Date.now(), notify: () => {}, prepare: (input, jobId) => async (signal) => {
      assert.ok(requests.length < cases.length, 'evaluation call cap reached')
      const receipt = { jobId, input, output: undefined as string | undefined }; requests.push(receipt); persist()
      const output = await completeRSSModel(config, { system: RSS_JUDGMENT_INSTRUCTIONS, user: JSON.stringify(input), maxTokens: 6000, runId: jobId, signal })
      receipt.output = output; persist(); return output
    } })
  try {
    rss.processing.configure({ enabled: true, dailyLimit: cases.length })
    const curated = rss.organization.list().find((entry) => entry.kind === 'curated')!
    rss.organization.save({ id: curated.id, expectedRevision: curated.revision, name: curated.name, icon: curated.icon, visible: curated.visible,
      position: curated.position, filterIds: curated.filterIds, description: '收录有明确发布主体与具体事实的产品、融资或政策消息；缺少明确事实时保留证据不足。' })
    const referenceSource = rss.addRSSSource({ name: reference.author, url: 'https://synthetic.invalid/reference/feed' })
    rss.upsertRSSItems([{ id: reference.id, source_id: referenceSource, guid: reference.id, title: reference.title, author: reference.author,
      link: 'https://synthetic.invalid/reference', summary: reference.text, published_at: Date.parse(reference.date) / 1000 }])
    const article = rss.content.getArticle(reference.id)!
    rss.events.apply(reference.id, article.revision, rss.events.context(reference.id, Date.now()), {
      kind: 'new', eventId: null, factId: null, quote: reference.text, sourceRole: 'direct', reason: 'Preaccepted synthetic reference, not a live model result.' })
    const original = rss.events.memberships([reference.id])[reference.id]
    const originalEvent = original.eventId, originalFact = original.factId
    for (const entry of cases) {
      const source = rss.addRSSSource({ name: entry.author || 'Unidentified preview', url: `https://synthetic.invalid/${entry.id}/feed` })
      rss.setRSSSourceDraftSeeded(source, true)
      rss.upsertRSSItems([{ id: entry.id, source_id: source, guid: entry.id, title: entry.title, author: entry.author,
        link: `https://synthetic.invalid/${entry.id}`, summary: entry.text, published_at: Date.parse(entry.date) / 1000 }])
      await service.wake()
      const job = rss.processing.list({ itemId: entry.id }).jobs[0]
      const membership = rss.events.memberships([entry.id])[entry.id]
      const relation = entry.kind === 'new' ? 'original' : entry.kind === 'insufficient' ? null : entry.kind
      const pass = job?.status === 'success' && membership?.relation === relation && (
        entry.kind === 'new' ? membership.eventId !== originalEvent : entry.kind === 'insufficient' ? membership.eventId === null
          : membership.eventId === originalEvent && (entry.kind === 'duplicate' ? membership.factId === originalFact : membership.factId !== originalFact))
      results.push({ id: entry.id, expectedKind: entry.kind, pass, jobStatus: job?.status, membership })
      persist(); console.log(JSON.stringify({ case: entry.id, pass, status: job?.status }))
      assert.equal(job?.status, 'success', 'stop after an unsuccessful request; do not retry an uncertain paid call')
    }
    complete = (results as Array<{ pass: boolean }>).every((entry) => entry.pass)
    persist(); assert.equal(complete, true, 'one or more semantic cases did not match the expected event relationship')
  } finally { await service.stop(); await Promise.all(wireReads); globalThis.fetch = originalFetch; persist(); await (db.getRawDb() as unknown as { backup(path: string): Promise<void> }).backup(join(evidence, 'synthetic-results.sqlite')); db.close() }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'semantic evaluation failed'); process.exitCode = 1 })
