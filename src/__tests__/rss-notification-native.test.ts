import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RSSStore } from '../main/modules/database/rss-store'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { deliverRSSNotifications, type RSSNotificationPort } from '../main/modules/rss-engine/sieve-notifications'
import { rssB10Fixture } from './utils/rss-b10-fixture'

function noon(now:number) {const date=new Date(now);date.setHours(12,0,0,0);return date.getTime()}
function notificationFixture(t:test.TestContext,path?:string) {
  const f=rssB10Fixture(t,path),topic=f.rss.organization.save({name:'必须知道',description:'关注'})
  const sent:string[]=[],opened:string[]=[],clicks:(()=>void)[]=[]
  const port:RSSNotificationPort={available:()=>true,send:(item,click)=>{sent.push(item.id);clicks.push(click)},open:id=>opened.push(id)}
  return {...f,topic,sent,opened,clicks,port}
}
test('V5 opt-in and quiet hours gate notifications; persistent claims survive repeat consumption and a reopened database',t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const root=mkdtempSync(join(tmpdir(),'rss-notification-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const path=join(root,'fixture.db'),f=notificationFixture(t,path),now=noon(f.now)
  for(const id of ['one','two','three','four']) {
    f.put(id,now)
    const article=f.rss.content.getArticle(id)!
    for(const definitionId of ['curated',f.topic.id]) f.rss.organization.setManual({itemId:id,definitionId,expectedArticleRevision:article.revision,expectedRuleRevision:1,decision:true})
  }
  assert.equal(deliverRSSNotifications(f.rss,f.port,now),0,'default is no urgent topic')
  f.rss.learning.saveTopicNotification({topicId:f.topic.id,urgent:true})
  const quiet=new Date(now);quiet.setHours(23)
  assert.equal(deliverRSSNotifications(f.rss,f.port,quiet.getTime()),0)
  assert.equal(deliverRSSNotifications(f.rss,f.port,now),3)
  assert.equal(deliverRSSNotifications(f.rss,f.port,now),0)
  f.clicks[0]();assert.equal(f.opened[0],f.sent[0])
  const reopened:DatabaseConnection=new Database(path);t.after(()=>reopened.close())
  const rss=new RSSStore(()=>reopened)
  assert.equal(deliverRSSNotifications(rss,f.port,now),0)
  assert.equal(deliverRSSNotifications(rss,f.port,now+86400000),1)
  assert.equal(new Set(f.sent).size,4)
  assert.equal(deliverRSSNotifications(rss,f.port,now+86400000),0)
  rss.learning.requestOpen('one');const pending=rss.learning.pendingOpen()!
  rss.learning.requestOpen('two');rss.learning.ackOpen(pending.id)
  assert.equal(rss.learning.pendingOpen()!.itemId,'two','old ack cannot erase a newer click')
})
test('notifications reject low scores, disabled topics and unavailable ports; configured daytime silence works',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=notificationFixture(t),now=noon(f.now)
  f.put('low',now);await f.judge()
  f.rss.learning.saveTopicNotification({topicId:f.topic.id,urgent:true})
  assert.equal(deliverRSSNotifications(f.rss,f.port,now),0,'neutral final score is below 85')
  f.rss.organization.setManual({itemId:'low',definitionId:'curated',expectedArticleRevision:f.rss.content.getArticle('low')!.revision,expectedRuleRevision:1,decision:true})
  f.rss.learning.saveTopicNotification({topicId:f.topic.id,urgent:false})
  assert.equal(deliverRSSNotifications(f.rss,f.port,now),0)
  f.rss.learning.saveTopicNotification({topicId:f.topic.id,urgent:true})
  assert.equal(deliverRSSNotifications(f.rss,{...f.port,available:()=>false},now),0)
  f.rss.learning.saveNotificationSettings({quietStart:'11:00',quietEnd:'13:00'})
  assert.equal(deliverRSSNotifications(f.rss,f.port,now),0)
  const end=new Date(now);end.setHours(13)
  assert.equal(deliverRSSNotifications(f.rss,f.port,end.getTime()),1)
})
test('an uncertain notification send stays claimed and is not retried',t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=notificationFixture(t),now=noon(f.now);f.put('one',now)
  for(const definitionId of ['curated',f.topic.id]) f.rss.organization.setManual({itemId:'one',definitionId,expectedArticleRevision:f.rss.content.getArticle('one')!.revision,expectedRuleRevision:1,decision:true})
  f.rss.learning.saveTopicNotification({topicId:f.topic.id,urgent:true})
  t.mock.method(console,'error',()=>{})
  assert.equal(deliverRSSNotifications(f.rss,{...f.port,send:()=>{throw new Error('unknown OS result')}},now),0)
  assert.equal(deliverRSSNotifications(f.rss,f.port,now),0)
  assert.equal(f.rss.sieve.delivery('one'),now)
})
