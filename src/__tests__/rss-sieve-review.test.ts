import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { __getMigrationNamesForTests, __runMigrationForTests } from '../main/modules/migrations'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { RSSStore } from '../main/modules/database/rss-store'
import { performance } from 'node:perf_hooks'
import { DatabaseManager } from '../main/modules/database'
import { RSSProcessingService } from '../main/modules/rss-engine/processing-service'
import { RSSContentService, type RSSContentServiceDeps } from '../main/modules/rss-engine/content-service'
import * as judgment from '../main/modules/rss-engine/processing-judgment'
import { previewRSSWorkContext, sendableRSSWorkContext } from '../main/modules/rss-engine/work-context-service'
import { RSSWorkPrivacySchema } from '../shared/rss-sieve'
import { RSS_PROCESSING_METHOD } from '../shared/rss-processing'
import { sieveGroup } from '../main/modules/rss-engine/ipc/sieve-group'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const testModel = { provider:'custom' as const, model:'test', baseUrl:'https://example.test/v1', apiKey:'test', maxOutputTokensOverride:32000 }
const now = Date.now()
function response(input: judgment.RSSJudgmentInput, included: true | null = true) {
  return JSON.stringify({ relevance:{score:100,because:'standard',reason:'相关',workRef:null},
    decisions:input.definitions.map(d=>({definitionId:d.id,included,reason:'判断',evidence:included ? input.source.title : null})),
    ...(input.eventContext && !input.eventContext.manual && !input.eventContext.reused ? {event:{kind:'insufficient',eventId:null,factId:null,quote:null,sourceRole:'unknown',reason:'证据不足'}} : {}) })
}
function setup(t: TestContext) {
  if (skipIfSqliteUnavailable(t,'RSS review')) return
  const db = new DatabaseManager(true), rss = db.rss
  t.after(()=>db.close())
  const source=rss.addRSSSource({name:'source',url:'https://example.test/feed'})
  rss.setRSSSourceDraftSeeded(source,true)
  const put=(id:string, sourceId=source, link=`https://example.test/${id}`)=>rss.upsertRSSItems([{id,source_id:sourceId,guid:id,title:id,link,summary:'摘要',published_at:now/1000}])
  const run=(extra: Partial<ConstructorParameters<typeof RSSProcessingService>[0]>={})=>new RSSProcessingService({store:rss.processing,getArticle:id=>rss.content.getArticle(id),hasModel:()=>true,now:()=>Date.now(),notify:()=>{},prepare:input=>async()=>response(input),...extra})
  const saveBody=(id:string)=>{const claim=rss.content.beginLoad(id)!;rss.content.finishLoad(claim,{status:'ready',markdown:'正文'.repeat(400),sourceUrl:`https://example.test/${id}`});return rss.content.getArticle(id)!}
  return {db,rss,source,put,run,saveBody}
}
const extractor: RSSContentServiceDeps['extractor'] = {extract:async ({html})=>({title:'title',contentMarkdown:html.includes('<article>')?'完整正文'.repeat(100):'',metadata:{},structuredData:[],metaLookup:{},diagnostics:{confidence:1,extractionSource:'readability',warnings:[]}})}

test('R1 v2 classifications and queued jobs survive the sieve upgrade',async t=>{
  if(skipIfSqliteUnavailable(t,'RSS upgrade'))return
  const Sqlite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection
  const db=new Sqlite(':memory:');t.after(()=>db.close())
  for(const name of __getMigrationNamesForTests().filter(name=>Number(name.slice(0,3))<155)) __runMigrationForTests(name,db)
  __runMigrationForTests('162_rss_item_pictures',db)
  const rss=new RSSStore(()=>db)
  db.exec("INSERT INTO rss_sources(id,name,url) VALUES('s','Source','https://example.test/feed')")
  for(const id of ['saved','queued'])db.prepare("INSERT INTO rss_items(id,source_id,guid,title,link,summary) VALUES(?,'s',?,?,'https://example.test/article','摘要')").run(id,id,id)
  const article=rss.content.getArticle('saved')!
  const result=db.prepare("INSERT INTO rss_classification_results(item_id,definition_id,method,decision,origin,reason,evidence,content_revision,rule_revision) VALUES('saved','curated','rss-organize-v2',1,'model','符合','saved',?,1) RETURNING id").get<{id:number}>(article.revision)!
  db.prepare("INSERT INTO rss_memberships(item_id,definition_id,result_id) VALUES('saved','curated',?)").run(result.id)
  const definitions=rss.organization.list().filter(d=>d.kind==='curated').map(({id,name,description,ruleRevision})=>({id,name,description,ruleRevision}))
  db.prepare("INSERT INTO rss_processing_jobs(id,item_id,title,article_revision,fingerprint,method,definitions_json,trigger_kind,status,created_at,event_requested) VALUES('old-queue','queued','queued',?,'old-fingerprint','rss-organize-v2',?,'automatic','queued',?,0)")
    .run(rss.content.getArticle('queued')!.revision,JSON.stringify(definitions),now)
  __runMigrationForTests('155_rss_sieve',db)
  __runMigrationForTests('156_rss_sieve_learning_delivery',db)
  assert.equal(rss.content.getArticle('saved')!.classifications[0].stale,false)
  assert.equal(rss.content.query({collectionId:'curated'}).items[0].id,'saved')
  await new RSSProcessingService({store:rss.processing,getArticle:id=>rss.content.getArticle(id),hasModel:()=>true,now:()=>now,notify:()=>{},prepare:input=>async()=>response(input)}).wake()
  assert.equal(rss.processing.get('old-queue')?.status,'success')
  assert.equal(RSS_PROCESSING_METHOD,'rss-organize-v2')
})

test('R2 interactive reader accepts recaptcha comments and articles about captcha',async t=>{
  const f=setup(t);if(!f)return
  for(const html of ['<title>文章</title><article>正文</article><div class="g-recaptcha"></div>','<title>验证码技术详解</title><article>正文</article>']){
    f.put('one')
    const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async url=>({html,finalUrl:url})})
    assert.equal((await content.load('one',true)).body.status,'ready')
    await content.stop()
  }
})
for(const error of ['challenge','HTTP 403 Forbidden','HTTP 429 Too Many Requests','HTTP 503 Service Unavailable']){
  test(`R2/R12 background ${error} pauses the origin`,async t=>{
    const f=setup(t);if(!f)return
    f.put('a');f.put('b');let calls=0
    const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async url=>{calls++;if(error!=='challenge')throw new Error(error);return {html:'<title>Just a moment...</title>',finalUrl:url}}})
    await content.loadForJudgment('a');await content.loadForJudgment('b')
    assert.equal(calls,1);await content.stop()
  })
}
for(const link of ['https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f6a7b8c9d0?xsec_token=T&xsec_source=pc_user','https://www.bilibili.com/video/BV1bb411c7mE','https://weibo.com/detail/Pabc123','https://www.douyin.com/video/7400000000000000000']){
  test(`session S10 an item of a login platform is never fetched in the background and still opens for the reader: ${new URL(link).hostname}`,async t=>{
    const f=setup(t);if(!f)return
    f.put('a',f.source,link);let calls=0
    const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async url=>{calls++;return {html:'<title>正文</title><article>正文</article>',finalUrl:url}}})
    const original=f.rss.content.getArticle('a')!
    const judged=await content.loadForJudgment('a')
    assert.equal(calls,0);assert.equal(judged.revision,original.revision)
    assert.equal((await content.load('a',true)).body.status,'ready');assert.equal(calls,1)
    await content.stop()
  })
}
for(const link of ['/relative','', 'https://example.test/network']){
  test(`R3 fetch failure ${link || 'empty URL'} uses one capped summary judgment`,async t=>{
    const f=setup(t);if(!f)return
    f.put('a',f.source,link);let calls=0
    const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async()=>{throw new Error('network failure')}})
    const original=f.rss.content.getArticle('a')!
    const loaded=await content.loadForJudgment('a')
    assert.equal(loaded.revision,original.revision)
    await f.run({loadArticle:id=>content.loadForJudgment(id),prepare:input=>async()=>{calls++;assert.equal(input.source.textKind,'source_summary');return response(input)}}).wake()
    assert.equal(calls,1);assert.equal(f.rss.sieve.relevance('a')?.score,70)
    assert.equal(f.rss.processing.status(Date.now(),true).unresolved,0);await content.stop()
  })
}
test('R3 stopping during prefetch leaves work queued without unresolved items',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');let reject!: (error:Error)=>void, entered!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve})
  const worker=f.run({loadArticle:()=>new Promise((_resolve,fail)=>{reject=fail;entered()})})
  const draining=worker.wake();await started
  const stopped=worker.stop();reject(new Error('RSS content service stopped'))
  await Promise.all([draining,stopped])
  assert.equal(f.rss.processing.status(Date.now(),true).unresolved,0)
  assert.equal(f.rss.processing.list({itemId:'a'}).jobs[0].status,'queued')
})
test('R4 two slots fetch and judge in order without stale records; disabled prefetch stays queued',async t=>{
  const f=setup(t);if(!f)return
  for(const id of ['a','b','c','d'])f.put(id)
  f.db.getRawDb()!.exec("UPDATE rss_processing_jobs SET created_at=CASE item_id WHEN 'a' THEN 1 WHEN 'b' THEN 2 WHEN 'c' THEN 3 ELSE 4 END")
  f.rss.processing.configure({enabled:true,dailyLimit:2});const steps:string[]=[]
  const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async url=>{steps.push(`fetch ${url.split('/').pop()}`);return {html:'<article>正文</article>',finalUrl:url}}})
  t.after(()=>content.stop())
  await f.run({loadArticle:id=>content.loadForJudgment(id),prepare:input=>async()=>{steps.push(`judge ${input.source.title}`);return response(input)}}).wake()
  assert.deepEqual(steps,['fetch a','judge a','fetch b','judge b'])
  assert.equal(f.rss.processing.list().total,4)
  for(const id of ['c','d'])assert.equal(f.rss.processing.list({itemId:id}).jobs[0].status,'queued')
  f.rss.processing.configure({enabled:true,dailyLimit:3})
  await f.run({loadArticle:async id=>{f.rss.processing.configure({enabled:false,dailyLimit:3});return content.loadForJudgment(id)}}).wake()
  assert.equal(f.rss.processing.list({itemId:'c'}).jobs[0].status,'queued')
  f.rss.processing.configure({enabled:true,dailyLimit:3});await f.run().wake()
  assert.equal(f.rss.processing.list({itemId:'c'}).jobs[0].status,'success')
})
test('R5 unrelated topic edits preserve relevance and scores; base rule and article edits invalidate',async t=>{
  const f=setup(t);if(!f)return
  const topic=f.rss.organization.save({name:'无关主题',description:'旧标准'})
  f.put('a');await f.run({prepare:input=>async()=>{const value=JSON.parse(response(input));value.decisions.find((d:{definitionId:string})=>d.definitionId===topic.id).included=null;return JSON.stringify(value)}}).wake()
  const before=f.rss.sieve.query({},now).items.map(i=>({id:i.id,score:i.sieve.score}))
  assert.equal(before.length,1)
  f.rss.organization.save({id:topic.id,name:topic.name,expectedRevision:topic.revision,description:'新标准'})
  assert.deepEqual(f.rss.sieve.query({},now).items.map(i=>({id:i.id,score:i.sieve.score})),before)
  f.db.getRawDb()!.exec("UPDATE rss_relevance SET method='other-method'")
  assert.equal(f.rss.sieve.relevance('a'),null)
  f.db.getRawDb()!.exec("UPDATE rss_relevance SET method='rss-sieve-relevance-v1'")
  assert.ok(f.rss.sieve.relevance('a'))
  const base=f.rss.organization.list().find(d=>d.kind==='curated')!
  f.rss.organization.save({id:base.id,name:base.name,expectedRevision:base.revision,description:'改变基础标准'})
  assert.equal(f.rss.sieve.relevance('a'),null)
  f.rss.processing.enqueue('a','manual');await f.run().wake()
  assert.ok(f.rss.sieve.relevance('a'))
  f.saveBody('a');assert.equal(f.rss.sieve.relevance('a'),null)
})
test('R6 no claimed membership or learned preference means no fabricated reason',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');await f.run({prepare:input=>async()=>response(input,null)}).wake()
  const result=f.rss.sieve.query({threshold:0},now)
  assert.equal(result.items.length,0)
  assert.equal(result.remaining[0].sieve.reason,'')
})
test('R7 queue orders manual first then source preference then creation time',t=>{
  const f=setup(t);if(!f)return
  const high=f.rss.addRSSSource({name:'high',url:'https://high.test/feed'});f.rss.setRSSSourceDraftSeeded(high,true)
  for(const [id,source] of [['manual-low',f.source],['auto-high',high],['manual-high-new',high],['manual-high-old',high]])f.put(id,source)
  f.db.getRawDb()!.exec("UPDATE rss_processing_jobs SET trigger_kind=CASE WHEN item_id='auto-high' THEN 'automatic' ELSE 'manual' END,created_at=CASE item_id WHEN 'manual-high-old' THEN 1 ELSE 2 END")
  f.rss.sieve.recordBehavior({id:'less',itemId:'manual-low',action:'less',reason:'source',at:now})
  f.rss.sieve.recordBehavior({id:'high-read',itemId:'manual-high-old',action:'open',at:now})
  const order:string[]=[]
  for(let i=0;i<4;i++){const next=f.rss.processing.next()!;order.push(next.itemId);f.rss.processing.cancel(next.id,now)}
  assert.deepEqual(order,['manual-high-old','manual-high-new','manual-low','auto-high'])
})
test('R8 context builder failure cannot stop a judgment',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');let calls=0
  await f.run({workContext:()=>{throw new Error('calendar unavailable')},prepare:input=>async()=>{calls++;assert.equal(input.workContext,undefined);return response(input)}}).wake()
  assert.equal(calls,1);assert.equal(f.rss.processing.list({itemId:'a'}).jobs[0].status,'success')
})
const sources={pages:()=>[{id:'p',title:'页面',editedAt:now}],projects:()=>[],calendar:()=>[{title:'会议',startsAt:now+1}],books:()=>[{title:'书籍',reading:true}]}
test('R9 preview contains unsent titles before consent',t=>{
  const f=setup(t);if(!f)return
  assert.equal(previewRSSWorkContext(f.rss.sieve,sources,now).text,'页面\n会议\n书籍')
})
test('R10 300 article query and 200 enqueues stay local and bounded',async t=>{
  const f=setup(t);if(!f)return
  for(let i=0;i<300;i++)f.put(`a-${i}`)
  f.rss.processing.configure({enabled:true,dailyLimit:1000});await f.run().wake()
  const original=f.rss.processing.get.bind(f.rss.processing)
  f.rss.processing.get=()=>{throw new Error('sieve must not hydrate processing history')}
  const start=performance.now();const result=f.rss.sieve.query({},now);const queryMs=performance.now()-start
  f.rss.processing.get=original
  assert.equal(result.items.length+result.remainingCount,300)
  const enqueueStart=performance.now();for(let i=0;i<200;i++)f.put(`queued-${i}`);const enqueueMs=performance.now()-enqueueStart
  t.diagnostic(`300 query: ${queryMs.toFixed(1)} ms; 200 enqueues: ${enqueueMs.toFixed(1)} ms`)
  assert.ok(queryMs<2000);assert.ok(enqueueMs<2000)
})
test('R11 output budget grows with standards and stays capped',()=>{
  assert.ok('rssJudgmentBudget' in judgment,'a shared output budget must be available to the request builder')
  if(!('rssJudgmentBudget' in judgment))return
  const budget=(count:number)=>judgment.rssJudgmentBudget(count,32000)
  assert.ok(budget(30).maxTokens>budget(8).maxTokens)
  assert.equal(budget(200).maxTokens,32000);assert.ok(budget(200).reasonLimit<budget(8).reasonLimit)
  assert.throws(()=>budget(500),/标准太多/)
  const input:judgment.RSSJudgmentInput={definitions:Array.from({length:30},(_,i)=>({id:String(i),description:'规则'})),source:{title:'文章',titleTruncated:false,url:'https://example.test',urlTruncated:false,author:null,authorTruncated:false,publishedAt:null,text:'正文',textKind:'saved_body',bodyStatus:'ready',offset:0,totalLength:2,truncated:false}}
  const request=judgment.buildRSSJudgmentRequest(input,'budget-test',testModel)
  assert.equal(request.maxTokens,9500);assert.equal(JSON.parse(request.user).definitions.length,30)
})
test('R13 source preference is distinct engaged/delivered with smoothing, not action count',t=>{
  const f=setup(t);if(!f)return
  const small=f.rss.addRSSSource({name:'small',url:'https://small.test/feed'});f.rss.setRSSSourceDraftSeeded(small,true)
  for(let i=0;i<100;i++)f.put(`big-${i}`)
  for(let i=0;i<3;i++)f.put(`small-${i}`,small)
  for(let i=0;i<30;i++)f.rss.sieve.recordBehavior({id:`big-open-${i}`,itemId:`big-${i}`,action:'open',at:now})
  for(let i=0;i<3;i++)f.rss.sieve.recordBehavior({id:`small-open-${i}`,itemId:`small-${i}`,action:'open',at:now})
  assert.ok(f.rss.sieve.preference('source',f.source)<0.5)
  // Overall engagement is 33 distinct articles out of 103 deliveries (30/100 + 3/3).
  assert.ok(f.rss.sieve.preference('source',small)>0.55)
  assert.ok(f.rss.sieve.preference('source',small)<1)
  const before=f.rss.sieve.preference('source',small)
  f.rss.sieve.recordBehavior({id:'repeat',itemId:'small-0',action:'open',at:now+1})
  f.rss.sieve.recordBehavior({id:'star',itemId:'small-0',action:'star',at:now+2})
  assert.equal(f.rss.sieve.preference('source',small),before)
})
test('R14 manual base inclusion pins the default sieve',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');f.put('b');await f.run().wake()
  f.rss.organization.setManual({itemId:'b',expectedArticleRevision:f.rss.content.getArticle('b')!.revision,definitionId:'curated',expectedRuleRevision:1,decision:true})
  const items=f.rss.sieve.query({},now).items
  assert.equal(items[0].id,'b');assert.equal(items[0].sieve.pinned,true)
})
test('R15 prefetch and reading both use browser credentials',async t=>{
  const f=setup(t);if(!f)return
  f.put('background');f.put('reader');const options:unknown[]=[]
  const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async (...args)=>{options.push(args[2]);return {html:'<article>正文</article>',finalUrl:args[0]}}})
  await content.loadForJudgment('background');await content.load('reader')
  assert.deepEqual(options,['include','include']);await content.stop()
})
test('R16 privacy IPC patches retain disabled categories and reject unknown fields',t=>{
  const f=setup(t);if(!f)return
  f.rss.sieve.configurePrivacy(RSSWorkPrivacySchema.parse({calendar:false}))
  const handlers=new Map<string,(...args:unknown[])=>unknown>()
  const ipc={removeHandler:(name:string)=>handlers.delete(name),handle:(name:string,handler:(...args:unknown[])=>unknown)=>handlers.set(name,handler)}
  const handle=sieveGroup.register(ipc as Parameters<typeof sieveGroup.register>[0],{store:()=>f.rss.sieve,pictures:()=>f.rss.pictures,workContext:()=>previewRSSWorkContext(f.rss.sieve,sources,now),notify:()=>{}})
  const update=handlers.get('rss:sieveConfigurePrivacy')!
  assert.deepEqual(update(null,{answer:'enabled',enabled:true}),{success:true,data:{answer:'enabled',enabled:true,pages:true,calendar:false,books:true}})
  assert.equal((update(null,{calendar:undefined}) as {success:true;data:{calendar:boolean}}).data.calendar,false)
  assert.equal((update(null,{unknown:true}) as {success:boolean}).success,false);handle.dispose()
})
test('R17 long relevance reasons are truncated and unused title history is not stored',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');await f.run({prepare:input=>async()=>{const out=JSON.parse(response(input));out.relevance.reason='字'.repeat(50);return JSON.stringify(out)}}).wake()
  assert.equal(f.rss.processing.list({itemId:'a'}).jobs[0].status,'success')
  assert.equal(f.rss.sieve.relevance('a')?.reason.length,40)
  assert.equal(f.db.getRawDb()!.prepare("SELECT name FROM sqlite_master WHERE name='rss_work_context'").get(),undefined)
})

test('R6 work reasons use the saved category and prior preferences cannot supply a reason',async t=>{
  const f=setup(t);if(!f)return
  f.rss.sieve.configurePrivacy({answer:'enabled',enabled:true})
  for(const [kind,title,expected] of [['page','页面','因为你在写《页面》'],['calendar','会议','和你的日程《会议》有关'],['book','书籍','和你在读的《书籍》有关']] as const){
    f.put(kind)
    await f.run({workContext:()=>sendableRSSWorkContext(f.rss.sieve,sources,now),prepare:input=>async()=>{
      const out=JSON.parse(response(input,null));out.relevance={score:100,because:'work',reason:'模型提示',workRef:title};return JSON.stringify(out)
    }}).wake()
    const item=[...f.rss.sieve.query({threshold:0},now).items].find(i=>i.id===kind)!
    assert.equal(item.sieve.reason,expected);assert.equal(item.relevance?.workKind,kind)
  }
})

test('R8 context dependencies contain corrupt settings, calendar errors and unavailable database',async t=>{
  const f=setup(t);if(!f)return
  const {SettingsStore}=await import('../main/modules/database/settings-store')
  const {RSSSieveStore}=await import('../main/modules/database/rss-sieve-store')
  const warnings=t.mock.method(console,'warn',()=>{})
  const settings=new SettingsStore(()=>f.db.getRawDb())
  settings.setSetting('rss:sieve-work-privacy','broken JSON')
  assert.deepEqual(sendableRSSWorkContext(f.rss.sieve,sources,now),{text:'',entries:[]})
  settings.setSetting('rss:sieve-work-privacy',JSON.stringify({answer:'enabled',enabled:true}))
  f.put('calendar-error')
  await f.run({workContext:()=>sendableRSSWorkContext(f.rss.sieve,{...sources,calendar:()=>{throw new Error('calendar failed')}},now),prepare:input=>async()=>{
    assert.equal(JSON.parse(judgment.buildRSSJudgmentRequest(input,'test',testModel).user).workContext,undefined)
    return response(input)
  }}).wake()
  assert.equal(f.rss.processing.list({itemId:'calendar-error'}).jobs[0].status,'success')
  assert.deepEqual(sendableRSSWorkContext(new RSSSieveStore(()=>null,f.rss.content),sources,now),{text:'',entries:[]})
  assert.equal(warnings.mock.calls.length,3)
})

test('R9 sending gates all titles while preview and allowed transmission share exact text',async t=>{
  const f=setup(t);if(!f)return
  let reads=0
  const forbidden=()=>{reads++;throw new Error('sending read private sources without consent')}
  for(const privacy of [{answer:'unanswered',enabled:false},{answer:'later',enabled:true},{answer:'enabled',enabled:false}] as const){
    f.rss.sieve.configurePrivacy(privacy)
    assert.equal(previewRSSWorkContext(f.rss.sieve,sources,now).text,'页面\n会议\n书籍')
    const context=sendableRSSWorkContext(f.rss.sieve,{pages:forbidden,projects:forbidden,calendar:forbidden,books:forbidden},now)
    assert.deepEqual(context,{text:'',entries:[]})
    f.put(privacy.answer)
    await f.run({workContext:()=>context,prepare:input=>async()=>{
      const sent=judgment.buildRSSJudgmentRequest(input,'test',testModel).user
      for(const title of ['页面','会议','书籍'])assert.ok(!sent.includes(title))
      return response(input)
    }}).wake()
  }
  assert.equal(reads,0)
  f.rss.sieve.configurePrivacy({answer:'enabled',enabled:true,calendar:false})
  const preview=previewRSSWorkContext(f.rss.sieve,sources,now)
  const sending=sendableRSSWorkContext(f.rss.sieve,sources,now)
  assert.deepEqual(sending,preview)
  const input=judgment.buildRSSJudgmentInput(f.rss.content.getArticle('enabled')!,[],undefined,sending)
  const payload=JSON.parse(judgment.buildRSSJudgmentRequest(input,'test',testModel).user)
  assert.equal(payload.workContext,preview.text)
  assert.equal(payload.workEntries,undefined,'category bookkeeping stays local')
})

test('R2 background challenge recognition requires both an exact title and a short extracted body',async t=>{
  const f=setup(t);if(!f)return
  for(const html of ['<title>验证码的实现</title><article>正文</article>','<title>Just a moment...</title><article>正文</article>','<title>正常文章</title><article>正文</article><div class="g-recaptcha"></div>']){
    f.put('normal')
    const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async url=>({html,finalUrl:url})})
    assert.equal((await content.loadForJudgment('normal')).body.markdown,'完整正文'.repeat(100));await content.stop()
    f.rss.deleteRSSItems(['normal'])
  }
})

test('R1 older queued topic-only v2 jobs still publish classification without inventing base validity',async t=>{
  const f=setup(t);if(!f)return
  const topic=f.rss.organization.save({name:'旧主题',description:'相关报道'})
  f.put('old-batch')
  const targets=[{id:topic.id,name:topic.name,description:topic.description,ruleRevision:topic.ruleRevision}]
  f.db.getRawDb()!.prepare("UPDATE rss_processing_jobs SET method='rss-organize-v2',definitions_json=? WHERE item_id='old-batch'").run(JSON.stringify(targets))
  await f.run().wake()
  assert.equal(f.rss.processing.list({itemId:'old-batch'}).jobs[0].status,'success')
  assert.equal(f.rss.content.getArticle('old-batch')!.classifications.find(c=>c.definitionId===topic.id)?.included,true)
  assert.equal(f.rss.sieve.relevance('old-batch'),null)
})

test('N1 topic edit and manual prefetch produce only one paid judgment',async t=>{
  const f=setup(t);if(!f)return
  const topic=f.rss.organization.save({name:'主题',description:'旧规则'})
  f.put('a')
  f.rss.organization.save({id:topic.id,name:topic.name,description:'新规则',expectedRevision:topic.revision})
  f.rss.processing.enqueue('a','manual');let calls=0
  await f.run({loadArticle:async id=>f.saveBody(id),prepare:input=>async()=>{calls++;return response(input)}}).wake()
  assert.equal(calls,1)
  assert.equal(f.rss.processing.status(Date.now(),true).callsToday,1)
})
for(const kind of ['403','network','challenge'] as const)test(`N2 ${kind} prefetch preserves reader state and opening still loads`,async t=>{
  const f=setup(t);if(!f)return
  f.put('a');const original=f.rss.content.getArticle('a')!;let calls=0,fetches=0
  const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async url=>{
    if(++fetches===1){
      if(kind==='403')throw Object.assign(new Error('HTTP 403 Forbidden'),{kind:'login_required'})
      if(kind==='network')throw new Error('network failure')
      return {html:'<title>Just a moment...</title>',finalUrl:url}
    }
    return {html:'<article>正文</article>',finalUrl:url}
  }})
  t.after(()=>content.stop())
  await f.run({loadArticle:id=>content.loadForJudgment(id),prepare:input=>async()=>{calls++;assert.equal(input.source.textKind,'source_summary');return response(input)}}).wake()
  assert.equal(calls,1);assert.equal(f.rss.sieve.relevance('a')?.score,70)
  const saved=f.rss.content.getArticle('a')!
  assert.deepEqual(saved.body,original.body);assert.equal(saved.revision,original.revision)
  // These are the states for which the reader automatically calls loadArticle.
  assert.ok(['missing','stale','loading'].includes(saved.body.status))
  assert.equal((await content.load('a')).body.status,'ready');assert.equal(fetches,2)
})
for(const first of ['prefetch','reader'] as const)test(`N2 ${first} shares one credentialed request with the other caller`,async t=>{
  const f=setup(t);if(!f)return
  f.put('a');let release!:()=>void,entered!:()=>void
  const started=new Promise<void>(r=>{entered=r}),hold=new Promise<void>(r=>{release=r}),credentials:string[]=[]
  const content=new RSSContentService({content:f.rss.content,extractor,fetchHtml:async(url,_signal,mode)=>{
    credentials.push(mode);entered();await hold;return {html:'<article>正文</article>',finalUrl:url}
  }})
  t.after(()=>content.stop())
  const initial=first==='prefetch'?content.loadForJudgment('a'):content.load('a');await started
  const other=first==='prefetch'?content.load('a'):content.loadForJudgment('a')
  await Promise.resolve();release()
  const [a,b]=await Promise.all([initial,other])
  assert.deepEqual(credentials,['include']);assert.equal(a.revision,b.revision)
  assert.equal(a.body.markdown,'完整正文'.repeat(100))
})
test('N2 prefetch joining a reader challenge still pauses the source',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');f.put('b');let fetches=0,release!:()=>void
  const hold=new Promise<void>(resolve=>{release=resolve})
  const content=new RSSContentService({content:f.rss.content,
    extractor:{extract:async input=>({...await extractor.extract(input),contentMarkdown:'Verify you are human'})},
    fetchHtml:async url=>{fetches++;await hold;return {html:'<title>Just a moment...</title>',finalUrl:url}}})
  t.after(()=>content.stop())
  const reader=content.load('a'),background=content.loadForJudgment('a')
  await Promise.resolve();release();await Promise.all([reader,background])
  await content.loadForJudgment('b')
  assert.equal(fetches,1)
  assert.equal(f.rss.content.getArticle('b')!.body.status,'missing')
})
test('N2 saved prefetch evidence publishes a new event once and later reading does not rejudge',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');let calls=0,fetches=0
  const body='Version 2 was released.'+'完整正文'.repeat(250),quote='Version 2 was released.'
  const content=new RSSContentService({content:f.rss.content,extractor:{extract:async input=>({...await extractor.extract(input),contentMarkdown:body})},fetchHtml:async url=>{fetches++;return {html:'<article>正文</article>',finalUrl:url}}})
  t.after(()=>content.stop())
  const worker=f.run({loadArticle:id=>content.loadForJudgment(id),prepare:input=>async()=>{
    calls++;const value=JSON.parse(response(input))
    value.decisions.forEach((d:{evidence:string})=>{d.evidence=quote})
    value.event={kind:'new',eventId:null,factId:null,quote,sourceRole:'direct',reason:'独立发布'}
    return JSON.stringify(value)
  }})
  await worker.wake()
  assert.equal(f.rss.processing.list({itemId:'a'}).jobs[0].status,'success')
  assert.equal(f.rss.processing.status(Date.now(),true).unresolved,0)
  const saved=f.rss.content.getArticle('a')!
  assert.equal(saved.body.markdown,body);assert.equal(saved.event?.quote,quote)
  assert.equal(saved.classifications[0].evidence,quote)
  assert.equal((await content.load('a')).revision,saved.revision)
  await worker.wake()
  assert.equal(calls,1);assert.equal(fetches,1)
  assert.equal(f.rss.processing.status(Date.now(),true).callsToday,1)
  assert.equal(f.rss.processing.list({itemId:'a'}).total,1)
})
for(const length of [30,799,800])test(`N2 body length ${length} selects the longer saved text and caps short input`,async t=>{
  const f=setup(t);if(!f)return
  const summary='订阅源摘要。'.repeat(24),body=length===30?'Subscribe to keep reading…    ':'文'.repeat(length)
  f.rss.upsertRSSItems([{id:'a',source_id:f.source,guid:'a',title:'a',link:'https://example.test/a',summary,published_at:now/1000}])
  const content=new RSSContentService({content:f.rss.content,extractor:{extract:async input=>({...await extractor.extract(input),contentMarkdown:body})},fetchHtml:async url=>({html:'<article>正文</article>',finalUrl:url})})
  t.after(()=>content.stop())
  const expected=body.length>summary.length?body:summary
  await f.run({loadArticle:id=>content.loadForJudgment(id),prepare:input=>async()=>{
    assert.equal(input.source.text,expected)
    assert.equal(input.source.textKind,length<800?'source_summary':'saved_body');return response(input)
  }}).wake()
  assert.equal(f.rss.processing.list({itemId:'a'}).jobs[0].status,'success')
  assert.equal(f.rss.sieve.relevance('a')?.score,length<800?70:100)
  assert.equal(f.rss.content.getArticle('a')!.body.markdown,body)
})
test('N3 equal ten percent engagement is neutral for big and small sources',async t=>{
  const f=setup(t);if(!f)return
  const small=f.rss.addRSSSource({name:'small',url:'https://small.test/feed'});f.rss.setRSSSourceDraftSeeded(small,true)
  for(const [source,count] of [[f.source,50],[small,10]] as const){
    for(let i=0;i<count;i++)f.put(`${source}-${i}`,source)
    for(let i=0;i<count/10;i++)f.rss.sieve.recordBehavior({id:`read-${source}-${i}`,itemId:`${source}-${i}`,action:'open',at:now})
    assert.ok(Number.isFinite(f.rss.sieve.preference('source',source)))
  }
  assert.equal(f.rss.sieve.preference('source',f.source),0.5)
  assert.equal(f.rss.sieve.preference('source',small),0.5)
  const id=`${f.source}-49`;f.saveBody(id);await f.run().wake()
  assert.ok(f.rss.sieve.query({},now).items.some(i=>i.id===id && i.sieve.score>=60))
})
test('N4 budgets respect model limits and reject impossible output before claiming',async t=>{
  const f=setup(t);if(!f)return
  const config={provider:'custom' as const,model:'unknown',baseUrl:'https://example.test/v1',apiKey:'test',agentProtocol:'openai' as const}
  f.rss.processing.configure({enabled:false,dailyLimit:100})
  f.put('a');const input=judgment.buildRSSJudgmentInput(f.rss.content.getArticle('a')!,[])
  assert.equal(judgment.buildRSSJudgmentRequest({...input,definitions:Array.from({length:25},(_,i)=>({id:String(i),description:'规则'}))},'default',config).maxTokens,8192)
  assert.equal(judgment.buildRSSJudgmentRequest(input,'anthropic',{...config,agentProtocol:'anthropic'}).maxTokens,4096)
  const request=(count:number,cap:number)=>judgment.buildRSSJudgmentRequest({...input,definitions:Array.from({length:count},(_,i)=>({id:String(i),description:'规则'}))},'test', {...config,maxOutputTokensOverride:cap})
  assert.equal(request(1,8192).maxTokens,6000)
  assert.equal(request(25,8192).maxTokens,8192)
  assert.match(request(25,8192).system,/reason 最多 11[0-9] 字/)
  assert.equal(request(10,4096).maxTokens,4096)
  for(let i=0;i<30;i++)f.rss.organization.save({name:`主题${i}`,description:'规则'})
  f.rss.processing.enqueue('a','manual');let calls=0
  await f.run({prepare:(value,id)=>{judgment.buildRSSJudgmentRequest(value,id,{...config,maxOutputTokensOverride:4096});return async()=>{calls++;return response(value)}}}).wake()
  const job=f.rss.processing.list({itemId:'a'}).jobs.find(j=>j.trigger==='manual')!
  assert.equal(job.status,'failed');assert.match(job.message!,/标准太多，超出模型单次输出上限（31 个标准，上限 4096）/)
  assert.equal(calls,0);assert.equal(f.rss.processing.status(Date.now(),true).callsToday,0)
})
test('N5 migration permits a later table replacement without a dangling view',t=>{
  const f=setup(t);if(!f)return
  const db=f.db.getRawDb()!
  db.exec('CREATE TABLE replacement AS SELECT * FROM rss_source_preferences; DROP TABLE rss_source_preferences; ALTER TABLE replacement RENAME TO rss_source_preferences;')
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='rss_source_preference_scores'").get(),undefined)
})
test('N6 preview and sendable context have distinct public entry points',async()=>{
  const api=await import('../main/modules/rss-engine/work-context-service')
  assert.ok('previewRSSWorkContext' in api);assert.ok('sendableRSSWorkContext' in api)
  assert.equal('readRSSWorkContext' in api,false)
})
for(const action of ['open','star','highlight','fastcard','more'] as const)test(`N8 recent ${action} supplies only an honest topic reason`,async t=>{
  const f=setup(t);if(!f)return
  const topic=f.rss.organization.save({name:'主题',description:'规则'});f.put('a');await f.run().wake()
  f.rss.sieve.recordBehavior({id:'engagement',itemId:'a',action,at:now,...(action==='more'?{reason:'topic' as const,topicId:topic.id}:{})})
  // Isolate the topic reason from model, membership evidence and source contributions.
  f.db.getRawDb()!.exec("UPDATE rss_relevance SET score=0;")
  f.db.getRawDb()!.prepare("INSERT INTO rss_source_preferences VALUES(?,0,100,0)").run(f.source)
  const item=f.rss.sieve.query({threshold:0},now).items.concat(f.rss.sieve.query({threshold:0},now).remaining)[0]
  assert.equal(item.sieve.reason==='和你最近收藏的几篇相近',action!=='open')
  f.db.getRawDb()!.exec(`UPDATE rss_behaviors SET occurred_at=${now-31*86400000}`)
  const old=f.rss.sieve.query({threshold:0},now)
  assert.ok([...old.items,...old.remaining].every(i=>i.sieve.reason!=='和你最近收藏的几篇相近'))
})

test('N3 normalized engagement covers small, strong, silent and empty sources',t=>{
  const f=setup(t);if(!f)return
  const groups=[['baseline',150,15],['small-one',10,1],['small-two',20,2],['strong',100,20],['silent',100,0],['empty',0,0]] as const
  for(const [name,delivered,engaged] of groups){
    const source=f.rss.addRSSSource({name,url:`https://${name}.test/feed`})
    for(let i=0;i<delivered;i++)f.put(`${name}-${i}`,source)
    for(let i=0;i<engaged;i++)f.rss.sieve.recordBehavior({id:`${name}-read-${i}`,itemId:`${name}-${i}`,action:'finish',at:now})
  }
  // 38 / 380 overall; the same 10% rate stays neutral at every sample size.
  for(const [name,delivered,engaged] of groups){
    const source=f.db.getRawDb()!.prepare('SELECT id FROM rss_sources WHERE name=?').get<{id:string}>(name)!.id
    const rate=(engaged+1)/(delivered+10)
    const expected=rate/(rate+0.1)
    assert.ok(Math.abs(f.rss.sieve.preference('source',source)-expected)<1e-12,name)
  }
  f.db.getRawDb()!.exec('DELETE FROM rss_behaviors')
  assert.ok(Number.isFinite(f.rss.sieve.preference('source',f.source)),'zero engagement must not divide by zero')
})

test('N1 refreshed manual work cancels identical queued automatic work',async t=>{
  const f=setup(t);if(!f)return
  f.put('a');f.rss.processing.enqueue('a','manual');let calls=0
  await f.run({loadArticle:async id=>f.saveBody(id),prepare:input=>async()=>{calls++;return response(input)}}).wake()
  assert.equal(calls,1)
  assert.ok(f.rss.processing.list().jobs.filter(j=>j.trigger==='automatic').every(j=>j.status==='canceled'))
})

test('N3 a small source read twice rises above neutral without saturating; explicit less still lowers it',t=>{
  const f=setup(t);if(!f)return
  const small=f.rss.addRSSSource({name:'small',url:'https://small.test/feed'})
  for(let i=0;i<98;i++)f.put(`base-${i}`)
  for(let i=0;i<2;i++)f.put(`small-${i}`,small)
  for(let i=0;i<8;i++)f.rss.sieve.recordBehavior({id:`base-read-${i}`,itemId:`base-${i}`,action:'open',at:now})
  for(let i=0;i<2;i++)f.rss.sieve.recordBehavior({id:`small-read-${i}`,itemId:`small-${i}`,action:'open',at:now})
  const twoOfTwo=f.rss.sieve.preference('source',small)
  assert.ok(twoOfTwo>0.5&&twoOfTwo<0.8,`two reads of two stay well below the top: ${twoOfTwo}`)
  f.rss.sieve.recordBehavior({id:'less',itemId:'small-0',action:'less',reason:'source',at:now})
  assert.ok(f.rss.sieve.preference('source',small)<1)
})
