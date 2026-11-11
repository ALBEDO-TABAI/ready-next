import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import { rssB10Fixture } from './utils/rss-b10-fixture'

test('daily entries preserve edition intake, sort by final score and snapshot the same truthful reasons as sieve',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t)
  f.put('older',f.now-3600000);f.put('newer');await f.judge()
  // A source feedback change lowers both equally; recency must still determine the larger final score.
  f.rss.sieve.recordBehavior({id:'feedback',itemId:'older',action:'less',reason:'shallow',at:f.now})
  const expected=f.rss.sieve.rank(f.rss.content.query({scope:'library'}).items,f.now)
  const report=f.rss.digests.generate({kind:'daily',from:f.now-86400000,until:Date.now()+1000,timezone:'UTC'},f.now)
  const result=f.rss.digests.read({view:'entries',reportId:report.id})
  assert.equal(result.view,'entries');if(result.view!=='entries') throw new Error('unexpected view')
  assert.deepEqual(result.entries.map(e=>e.source.itemId),expected.map(i=>i.id))
  for(const entry of result.entries) {
    assert.deepEqual(entry.source.sieve,expected.find(i=>i.id===entry.source.itemId)!.sieve)
    assert.equal(entry.source.sieve!.reason,'符合：基础标准')
  }
  assert.equal(f.rss.digests.generate({kind:'daily',from:f.now-86400000,until:report.until,timezone:'UTC'},f.now).id,report.id)
})
test('today exposes only its top five, each with a score and truthful reason',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t)
  for(let i=0;i<7;i++) f.put(`item-${i}`,f.now-i*1000)
  await f.judge()
  const items=f.rss.sieve.today(f.now)
  assert.equal(items.length,5)
  assert.ok(items.every(item=>item.sieve.reason==='符合：基础标准'))
  assert.ok(items.every((item,i)=>i===0 || item.sieve.score<=items[i-1].sieve.score))
  assert.equal(f.rss.learning.metrics(f.now).screened,5)
})
