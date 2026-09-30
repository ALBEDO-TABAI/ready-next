import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { DatabaseManager } from '../main/modules/database'
import { __getMigrationNamesForTests, __runMigrationForTests } from '../main/modules/migrations'
import { RSSOrganizationStore } from '../main/modules/database/rss-organization-store'
import { RSSContentStore } from '../main/modules/database/rss-content-store'
import { generateMasterFeed, generateCategoryFeeds } from '../main/modules/rss-engine/feed-generator'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function fixture() {
  const db = new DatabaseManager(true)
  const source = db.rss.addRSSSource({ name: 'Source', url: 'https://example.test/feed' })
  const row = (id: string, title = id) => ({ id, source_id: source, guid: id, title, link: `https://example.test/${id}`, summary: 'Saved summary' })
  const put = (id: string, title?: string) => db.rss.upsertRSSItems([row(id, title)])
  const topic = (name: string) => db.rss.organization.save({ name, description: `About ${name}`, icon: 'tag' })
  const assign = (id: string, definitionId: string, decision: boolean | null) => db.rss.organization.setManual({ itemId: id,
    expectedArticleRevision: db.rss.content.getArticle(id)!.revision, definitionId,
    expectedRuleRevision: db.rss.organization.list().find((entry) => entry.id === definitionId)!.ruleRevision, decision })
  return { db, source, row, put, topic, assign }
}

test('organization migration preserves all nonempty historical categories and article states without reclassification', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS organization migration')) return
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys=ON')
  try {
    for (const name of __getMigrationNamesForTests().filter((name) => Number(name.slice(0, 3)) < 80)) __runMigrationForTests(name, raw)
    raw.prepare("INSERT INTO rss_sources(id,name,url,group_name) VALUES ('source','Source','https://example.test/feed','default')").run()
    for (const [id, tag] of [['design', '设计'], ['unknown', '未见过,不拆分'], ['null', null], ['other', '其他']] as const) {
      raw.prepare('INSERT INTO rss_items(id,source_id,guid,title,link,ai_tags,read,starred,inbox_visible) VALUES (?,\'source\',?,?,?,?,1,1,0)').run(id, id, id, `https://example.test/${id}`, tag)
    }
    const before = raw.prepare('SELECT id,content_revision,read,starred,inbox_visible FROM rss_items ORDER BY id').all()
    __runMigrationForTests('080_rss_organization', raw)
    let content!: RSSContentStore
    const organization = new RSSOrganizationStore(() => raw, (id) => content.getArticle(id)?.revision || null)
    content = new RSSContentStore(() => raw, organization)
    assert.deepEqual(raw.prepare('SELECT id,content_revision,read,starred,inbox_visible FROM rss_items ORDER BY id').all(), before)
    assert.equal(raw.pragma('table_info(rss_items)').some((column: { name: string }) => column.name === 'ai_tags'), false)
    assert.deepEqual(organization.list().filter((entry) => entry.kind === 'topic').map((entry) => entry.name).sort(), ['设计', '未见过,不拆分', '其他'].sort())
    assert.deepEqual(content.getArticle('null')!.classifications, [])
    const old = content.getArticle('unknown')!.classifications[0]
    assert.equal(old.origin, 'legacy'); assert.equal(old.included, true)
    const definition = organization.list().find((entry) => entry.id === old.definitionId)!
    organization.save({ id: definition.id, expectedRevision: definition.revision, name: definition.name, description: 'New criteria' })
    assert.equal(content.getArticle('unknown')!.classifications[0].stale, true)
  } finally { raw.close() }
})

test('definitions, manual inclusion and exclusion, shared queries and export use one relation', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS organization read chain')) return
  const { db, source, put, topic, assign } = fixture()
  try {
    const a = topic('Video'), b = topic('Tutorial')
    put('one'); put('two'); put('three')
    assign('one', a.id, true); assign('one', b.id, true); assign('two', a.id, true); assign('three', b.id, true)
    const query = db.rss.content.query({ collectionId: a.id, categoryId: b.id, limit: 1 })
    assert.deepEqual(query.items.map((item) => item.id), ['one'])
    assert.equal(query.total, 1)
    assert.ok(query.definitions.some((definition) => definition.id === a.id))
    const agent = JSON.parse(await executeRSSTool('rss_query_items', { collectionId: a.id, categoryId: b.id }, { getContent: () => db.rss.content }))
    assert.deepEqual(agent.data.items.map((item: { id: string }) => item.id), ['one'])
    assert.equal(db.rss.getRSSStats().categories.find((entry) => entry.id === a.id)?.count, 2)
    const full = db.rss.getAllRSSItems()
    const xml = generateMasterFeed(full, [{ id: source, name: 'Source', url: 'https://example.test/feed' }])
    assert.match(xml, /Video/); assert.match(xml, /Tutorial/)
    const feeds = generateCategoryFeeds(full, [], db.rss.organization.list())
    assert.match(feeds[a.id], /<title>one<\/title>/)
    assert.doesNotMatch(feeds[a.id], /<title>three<\/title>/)
    assign('one', a.id, false)
    assert.equal(db.rss.content.query({ collectionId: a.id, categoryId: b.id }).total, 0)
    put('one', 'Updated title')
    assert.equal(db.rss.content.getArticle('one')!.classifications.find((entry) => entry.definitionId === a.id)?.included, false)
    assert.throws(() => db.rss.content.query({ ...query.query, expectedRevision: query.revision }), /cursor_stale/)
    assign('one', a.id, null)
    assert.equal(db.rss.content.getArticle('one')!.classifications.some((entry) => entry.definitionId === a.id), false)
  } finally { db.close() }
})

test('presentation edits keep rule and body versions; stale edits and deletions cannot mutate another target', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS definition versioning')) return
  const { db, put, topic, assign } = fixture()
  try {
    put('one')
    const claim = db.rss.content.beginLoad('one')!
    db.rss.content.finishLoad(claim, { status: 'ready', markdown: 'Body stays saved', sourceUrl: 'https://example.test/one' })
    const before = db.rss.content.getArticle('one')!
    const definition = topic('Original')
    assign('one', definition.id, true)
    const saved = db.rss.organization.save({ id: definition.id, expectedRevision: definition.revision, name: 'Renamed', description: definition.description, visible: false, position: 1, icon: 'video' })
    assert.equal(saved.ruleRevision, definition.ruleRevision)
    assert.equal(db.rss.content.getArticle('one')!.revision, before.revision)
    assert.throws(() => db.rss.organization.save({ id: definition.id, expectedRevision: definition.revision, name: 'Late', description: 'Stale' }), /变化/)
    const changed = db.rss.organization.save({ id: saved.id, expectedRevision: saved.revision, name: saved.name, description: 'Changed rule' })
    assert.equal(changed.ruleRevision, saved.ruleRevision + 1)
    assert.equal(db.rss.content.getArticle('one')!.classifications[0].origin, 'manual')
    assert.equal(db.rss.content.getArticle('one')!.classifications[0].stale, false)
    db.rss.organization.remove({ id: changed.id, expectedRevision: changed.revision })
    assert.equal(db.rss.content.getArticle('one')!.body.markdown, 'Body stays saved')
    assert.deepEqual(db.rss.content.getArticle('one')!.classifications, [])
    assert.throws(() => db.rss.content.query({ collectionId: changed.id }), /已删除/)
    const all = db.rss.organization.list().find((entry) => entry.kind === 'all')!
    assert.throws(() => db.rss.organization.remove({ id: all.id, expectedRevision: all.revision }), /不能删除/)
    assert.throws(() => db.rss.organization.save({ id: all.id, expectedRevision: all.revision, name: all.name, description: all.description, visible: false }), /必须保留/)
  } finally { db.close() }
})

test('creating more than one hundred topics never makes the shared all-view settings unsavable', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS definition binding growth')) return
  const { db } = fixture()
  try {
    for (let index = 0; index < 101; index++) db.rss.organization.save({ name: `Topic ${index}`, description: `Criteria ${index}`, position: index, visible: false })
    const all = db.rss.organization.list().find((entry) => entry.id === 'all')!
    assert.equal(all.filterIds.length, 101)
    const saved = db.rss.organization.save({ id: all.id, expectedRevision: all.revision, name: '所有资讯', description: all.description,
      icon: all.icon, position: all.position, visible: all.visible, filterIds: all.filterIds })
    assert.equal(saved.filterIds.length, 101)
    assert.equal(saved.ruleRevision, all.ruleRevision)
  } finally { db.close() }
})
