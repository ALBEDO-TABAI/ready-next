import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { NativeRSSScraper } from '../main/modules/rss-engine/scrapers/native-rss'
import { generateSubscriptionsOpml } from '../main/modules/rss-engine/opml'
import { rssB10Fixture } from './utils/rss-b10-fixture'
import { runMigrations } from '../main/modules/migrations'

test('OPML imports nested groups atomically, preserves existing and disabled sources and deduplicates repeat files',t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t)
  const xml=`<opml version="2.0"><body><outline text="科技"><outline text="视频"><outline text="新来源" xmlUrl="https://NEW.test/feed"/></outline><outline text="覆盖不了" xmlUrl="https://example.test/feed"/></outline></body></opml>`
  const first=f.rss.importOpml(xml)
  assert.equal(first.added,1);assert.equal(first.existing,1)
  assert.equal(f.rss.getRSSSources().length,2)
  assert.equal(f.rss.getRSSSources().find(s=>s.id===f.source)!.name,'来源')
  assert.equal(f.rss.getRSSSources().find(s=>s.id!==f.source)!.group_name,'科技 / 视频')
  const before=f.rss.getRSSSources()
  assert.equal(f.rss.importOpml(xml).added,0)
  assert.deepEqual(f.rss.getRSSSources(),before)
  f.db.prepare('UPDATE rss_sources SET enabled=0 WHERE id=?').run(f.source)
  assert.equal(f.rss.importOpml(xml).added,0)
  assert.equal(f.rss.getRSSSources().length,1)
  const exported=generateSubscriptionsOpml(f.rss.getRSSSources())
  assert.equal(f.rss.importOpml(exported).added,0)
  assert.throws(()=>f.rss.importOpml('<opml><body><outline></body>'),/OPML 格式错误/)
  assert.throws(()=>f.rss.importOpml('<opml><body><outline xmlUrl="file:///tmp/a"/></body></opml>'),/HTTP/)
  assert.equal(f.rss.getRSSSources().length,1)
  f.rss.importOpml('<opml><body><outline xmlUrl="https://space.bilibili.com/123"/></body></opml>')
  assert.equal(f.rss.getRSSSources().find(s=>s.url==='https://space.bilibili.com/123')!.platform,'bilibili')
  runMigrations(f.db)
  assert.equal(f.db.prepare('PRAGMA table_info(rss_sources)').all<{name:string}>().some(c=>c.name==='fetch_interval'),false)
})
for(const version of ['1','1.1']) test(`JSON Feed ${version} fixture maps identity, text, authors, dates and cover without network`,async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const scraper=new NativeRSSScraper(),raw=readFileSync(new URL(`./fixtures/rss/feed-${version}.json`,import.meta.url),'utf8')
  class FixtureScraper extends NativeRSSScraper {
    protected async httpGet() { return {text:raw,status:200,headers:new Headers({'content-type':'application/feed+json'})} }
  }
  const parsed=await new FixtureScraper().fetchItems('https://example.test/feed'),item=parsed.items[0]
  assert.equal(parsed.error,undefined);assert.equal(parsed.items.length,1)
  assert.equal(item.itemId,scraper.parseFeed(raw,'https://example.test/feed').items[0].itemId)
  assert.notEqual(item.itemId,scraper.parseFeed(raw,'https://another.test/feed').items[0].itemId)
  assert.equal(item.description,version==='1'?'正文内容':'纯文本内容')
  assert.equal(item.author,version==='1'?'作者':'甲, 乙')
  assert.equal(item.link,`https://example.test/${version==='1'?'one':'two'}`)
  assert.equal(item.pubDate,version==='1'?'2026-11-10T12:00:00.000Z':'2026-11-11T12:00:00.000Z')
  assert.ok(item.coverImage?.startsWith('https://example.test/'))
  assert.match(scraper.parseFeed(raw.replace('https://jsonfeed.org/version/','https://unknown.test/version/'),'https://example.test/feed').error!,/JSON Feed 格式错误/)
})
