import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { RSSProcessingService } from '../main/modules/rss-engine/processing-service'
import { RSSContentService } from '../main/modules/rss-engine/content-service'
import { previewRSSWorkContext, sendableRSSWorkContext } from '../main/modules/rss-engine/work-context-service'
import { rssWorkContextSources } from '../main/modules/rss-engine/work-context-runtime'
import { RSSWorkPrivacySchema } from '../shared/rss-sieve'
import type { RSSJudgmentInput } from '../main/modules/rss-engine/processing-judgment'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { sieveGroup } from '../main/modules/rss-engine/ipc/sieve-group'

const now = Date.UTC(2026,10,11,12)
function output(input: RSSJudgmentInput, score = 100) {
  return JSON.stringify({ relevance:{score,because:input.workContext ? 'work' : 'standard',reason:'相关',workRef:input.workContext?.split('\n')[0] ?? null},
    decisions:input.definitions.map(d => ({definitionId:d.id,included:true,reason:'符合',evidence:input.source.title})),
    ...(input.eventContext && !input.eventContext.manual && !input.eventContext.reused ? {event:{kind:'insufficient',eventId:null,factId:null,quote:null,sourceRole:'unknown',reason:'证据不足'}} : {}) })
}
function setup() {
  const db = new DatabaseManager(true), rss = db.rss
  const source = rss.addRSSSource({name:'source',url:'https://example.test/feed'})
  rss.setRSSSourceDraftSeeded(source,true)
  const put = (id:string,sourceId=source,publishedAt=now) => rss.upsertRSSItems([{id,source_id:sourceId,guid:id,title:id,link:`https://example.test/${id}`,summary:'摘要',published_at:publishedAt/1000}])
  const runner = (complete:(input:RSSJudgmentInput)=>Promise<string> = async input => output(input)) => new RSSProcessingService({store:rss.processing,getArticle:id=>rss.content.getArticle(id),hasModel:()=>true,now:()=>now,notify:()=>{},prepare:input=>()=>complete(input)})
  return {db,rss,source,put,runner}
}
test('V7 preferred sources get the daily slot; 18 definitions still cost one request', async t => {
  if (skipIfSqliteUnavailable(t,'RSS sieve')) return
  const f=setup()
  try {
    for(let i=0;i<17;i++) f.rss.organization.save({name:`主题${i}`,description:'相关报道'})
    const preferred=f.rss.addRSSSource({name:'preferred',url:'https://preferred.test/feed'})
    f.rss.setRSSSourceDraftSeeded(preferred,true)
    f.put('low'); f.put('high',preferred)
    f.rss.sieve.recordBehavior({id:'less',itemId:'low',action:'less',reason:'source',at:now})
    f.rss.processing.configure({enabled:true,dailyLimit:1})
    const sent:string[]=[]
    await f.runner(async input=>{sent.push(input.source.title);assert.equal(input.definitions.length,18);return output(input)}).wake()
    assert.deepEqual(sent,['high'])
    assert.equal(f.rss.processing.status(now,true).callsToday,1)
    assert.equal(f.rss.processing.list({itemId:'low'}).jobs[0].status,'queued')
    assert.equal(f.rss.content.getArticle('high')!.classifications.length,18)
  } finally {f.db.close()}
})
test('V1/V2 queries enforce 48h, unread, threshold, top12/top5, remainder and immediate feedback', async t => {
  if(skipIfSqliteUnavailable(t,'RSS sieve'))return
  const f=setup()
  try {
    for(let i=0;i<15;i++)f.put(`new-${i}`,f.source,now-i*1000)
    f.put('old',f.source,now-49*3600000); f.put('read');f.rss.markRSSRead('read')
    for(const article of f.rss.content.query().items){const claim=f.rss.content.beginLoad(article.id)!;f.rss.content.finishLoad(claim,{status:'ready',markdown:'完整正文'.repeat(200),sourceUrl:article.link})}
    await f.runner().wake()
    const before=f.rss.sieve.query({},now)
    assert.equal(before.items.length,12);assert.equal(before.remainingCount,3)
    assert.equal(f.rss.sieve.today(now).length,5)
    assert.equal(before.items[0].sieve.reason,'符合：精选')
    assert.ok(![...before.items,...before.remaining].some(i=>['old','read'].includes(i.id)))
    const score=before.items.find(i=>i.id==='new-0')!.sieve.score
    f.rss.sieve.recordBehavior({id:'feedback',itemId:'new-1',action:'less',reason:'source',at:now})
    const after=f.rss.sieve.query({threshold:0},now)
    assert.ok(after.items.find(i=>i.id==='new-0')!.sieve.score<score)
    const highThreshold = f.rss.sieve.query({ threshold: 100 }, now)
    assert.equal(highThreshold.items.length, 1)
    assert.equal(highThreshold.items[0].sieve.explore, true)
    assert.ok(highThreshold.items[0].sieve.score < 100)
    assert.equal(highThreshold.remainingCount, 14)
    f.rss.organization.setManual({itemId:'new-0',expectedArticleRevision:f.rss.content.getArticle('new-0')!.revision,definitionId:'curated',expectedRuleRevision:1,decision:false})
    assert.ok(!f.rss.sieve.query({threshold:0},now).items.some(i=>i.id==='new-0'))
  } finally {f.db.close()}
})
test('V6 settings preview and actual request use identical title snapshot; updates never rejudge history', async t=>{
  if(skipIfSqliteUnavailable(t,'RSS sieve'))return
  const f=setup()
  try {
    const sources={pages:()=>[{id:'page',title:'页面标题',editedAt:now}],projects:()=>[],calendar:()=>[{title:'日程标题',startsAt:now+1}],books:()=>[{title:'书名',reading:true}]}
    const context=()=>previewRSSWorkContext(f.rss.sieve,sources,now)
    // Invoke the real IPC group using its normal response envelope.
    const handlers=new Map<string, (...args:unknown[])=>unknown>()
    const ipc = {removeHandler:(name:string)=>handlers.delete(name),handle:(name:string,handler:(...args:unknown[])=>unknown)=>handlers.set(name,handler)}
    const handle=sieveGroup.register(ipc as Parameters<typeof sieveGroup.register>[0],{store:()=>f.rss.sieve,workContext:context,notify:()=>{}})
    const send=async(id:string, workRef?:string|null)=>{
      f.put(id)
      let input:RSSJudgmentInput|undefined
      const runner=new RSSProcessingService({store:f.rss.processing,getArticle:id=>f.rss.content.getArticle(id),hasModel:()=>true,now:()=>now,notify:()=>{},
        workContext:()=>sendableRSSWorkContext(f.rss.sieve,sources,now),prepare:value=>async()=>{input=value;const response=JSON.parse(output(value));if(workRef!==undefined)response.relevance.workRef=workRef;return JSON.stringify(response)}})
      await runner.wake();return input!
    }
    assert.equal((await send('unanswered')).workContext,undefined)
    f.rss.sieve.configurePrivacy(RSSWorkPrivacySchema.parse({answer:'enabled',enabled:true}))
    const preview=handlers.get('rss:sieveWorkContext')!() as {success:true;data:{text:string}}
    assert.equal((await send('enabled')).workContext,preview.data.text)
    for(const [id,ref]of [['foreign','不存在'],['absent',null]]as const){
      await send(id,ref)
      assert.equal(f.rss.processing.list({itemId:id}).jobs[0].status,'failed')
      assert.deepEqual(f.rss.content.getArticle(id)!.classifications,[])
    }
    f.rss.sieve.configurePrivacy({...f.rss.sieve.privacy(),calendar:false})
    assert.equal((await send('no-calendar')).workContext,'页面标题\n书名')
    f.rss.sieve.excludePage({objectId:'page',excluded:true})
    assert.equal(context().text,'书名')
    f.rss.sieve.configurePrivacy({...f.rss.sieve.privacy(),enabled:false})
    assert.equal((await send('disabled')).workContext,undefined)
    assert.equal(f.rss.processing.status(now,true).callsToday,6)
    handle.dispose();assert.equal(handlers.size,0)
  }finally{f.db.close()}
})
test('T2 full text is fetched before the only model call; failures use capped summary and are not retried',async t=>{
  if(skipIfSqliteUnavailable(t,'RSS sieve'))return
  for(const success of [true,false]){
    const f=setup()
    try{
      f.put('one');let fetches=0,calls=0
      const content=new RSSContentService({content:f.rss.content,
        fetchHtml:async url=>{fetches++;if(!success)throw new Error('fetch failed');return {html:'完整正文'.repeat(200),finalUrl:url}},
        extractor:{extract:async({html})=>({title:'title',contentMarkdown:html,metadata:{},structuredData:[],metaLookup:{},diagnostics:{confidence:1,extractionSource:'readability',warnings:[]}})}})
      t.after(()=>content.stop())
      const worker=new RSSProcessingService({store:f.rss.processing,getArticle:id=>f.rss.content.getArticle(id),hasModel:()=>true,now:()=>now,notify:()=>{},
        loadArticle:id=>content.loadForJudgment(id),
        prepare:input=>async()=>{calls++;assert.equal(input.source.text,success?'完整正文'.repeat(200):'摘要');return output(input)}})
      await worker.wake();await worker.wake()
      assert.equal(fetches,1);assert.equal(calls,1)
      assert.equal(f.rss.sieve.relevance('one')?.score,success?100:70)
      assert.equal(f.rss.sieve.relevance('one')?.summaryOnly,!success)
    }finally{f.db.close()}
  }
})

test('T2 source projections read only titles and filter excluded, non-present and non-reading objects',t=>{
  if(skipIfSqliteUnavailable(t,'RSS sieve'))return
  const f=setup()
  try{
    const db=f.db.getRawDb()!
    db.prepare("INSERT INTO workspaces(root) VALUES('/fixture')").run()
    const workspace=db.prepare("SELECT id FROM workspaces WHERE root='/fixture'").get<{id:number}>()!.id
    for(const [id,title,metadata]of [['page','页面.md','{}'],['book','书籍.md','{"类型":"书","状态":"在读"}'],['unread','未读.md','{"类型":"书","状态":"想读"}']]){
      db.prepare("INSERT INTO objects(id,kind,workspace_id,current_path,path_key,last_known_path,status,identity_state,mtime_ns,observed_since) VALUES(?,'markdown',?,?,?,?,'present','local',?,?)")
        .run(id,workspace,`/fixture/${title}`,`/fixture/${title}`,`/fixture/${title}`,String(BigInt(now)*1000000n),now)
      db.prepare("INSERT INTO documents(workspace_id,path,name,ext,object_id,frontmatter_json,indexed_at) VALUES(?,?,?,'md',?,?,?)").run(workspace,`/fixture/${title}`,title,id,metadata,now)
    }
    f.rss.sieve.configurePrivacy(RSSWorkPrivacySchema.parse({answer:'enabled',enabled:true}))
    const sources=rssWorkContextSources(db,()=>[{title:'会议',startsAt:now+1}])
    assert.equal(previewRSSWorkContext(f.rss.sieve,sources,now).text,'页面\n会议\n书籍')
    f.rss.sieve.excludePage({objectId:'page',excluded:true})
    assert.equal(previewRSSWorkContext(f.rss.sieve,sources,now).text,'会议\n书籍')
    f.rss.sieve.excludePage({objectId:'book',excluded:true})
    assert.equal(previewRSSWorkContext(f.rss.sieve,sources,now).text,'会议')
  }finally{f.db.close()}
})
test('T2 background fetch serializes, spaces requests and pauses a captcha origin',async t=>{
  if(skipIfSqliteUnavailable(t,'RSS sieve'))return
  const f=setup()
  let service:RSSContentService|undefined
  try{
    f.put('one');f.put('two');f.put('three')
    const starts:number[]=[];let active=0,maxActive=0
    service=new RSSContentService({content:f.rss.content,fetchHtml:async url=>{
      starts.push(Date.now());maxActive=Math.max(maxActive,++active)
      await new Promise(resolve=>setTimeout(resolve,10));active--
      return {html:url.endsWith('/two')?'<title>安全验证</title>':'<article>正文</article>',finalUrl:url}
    },extractor:{extract:async()=>({title:'title',contentMarkdown:'完整正文',metadata:{},structuredData:[],metaLookup:{},diagnostics:{confidence:1,extractionSource:'readability',warnings:[]}})} })
    const results=await Promise.all(['one','two','three'].map(id=>service!.loadForJudgment(id)))
    assert.equal(maxActive,1);assert.equal(starts.length,2)
    assert.ok(starts[1]-starts[0]>=1950)
    assert.equal(results[0].body.markdown,'完整正文');assert.equal(results[0].body.status,'ready');assert.equal(results[1].body.status,'missing');assert.equal(f.rss.content.getArticle('two')!.body.status,'missing');assert.equal(results[2].body.status,'missing')
    await service.loadForJudgment('two');assert.equal(starts.length,2)
  }finally{await service?.stop();f.db.close()}
})
test('V1/V2 event duplicates lose rank, manual topic decisions win, and every feedback reason persists',async t=>{
  if(skipIfSqliteUnavailable(t,'RSS sieve'))return
  const f=setup()
  try{
    const topic=f.rss.organization.save({name:'测试主题',description:'相关'})
    f.put('one');f.put('two');await f.runner().wake()
    const first=f.rss.content.getArticle('one')!,second=f.rss.content.getArticle('two')!
    f.rss.events.apply('one',first.revision,f.rss.events.context('one',now,false),{kind:'new',eventId:null,factId:null,quote:'one',sourceRole:'direct',reason:'独立事件'})
    const membership=f.rss.events.memberships(['one']).one
    f.rss.events.apply('two',second.revision,f.rss.events.context('two',now,false),{kind:'duplicate',eventId:membership.eventId,factId:membership.factId,quote:'two',sourceRole:'secondary',reason:'同一事件'})
    const ranked=f.rss.sieve.query({threshold:0},now).items
    assert.equal(ranked[0].sieve.score-ranked[1].sieve.score,20)
    const duplicate=ranked[1]
    f.rss.organization.setManual({itemId:duplicate.id,expectedArticleRevision:duplicate.revision,definitionId:topic.id,expectedRuleRevision:topic.ruleRevision,decision:true})
    assert.equal(f.rss.sieve.query({topicId:topic.id},now).items[0].id,duplicate.id)
    f.rss.organization.setManual({itemId:duplicate.id,expectedArticleRevision:duplicate.revision,definitionId:topic.id,expectedRuleRevision:topic.ruleRevision,decision:false})
    assert.ok(!f.rss.sieve.query({topicId:topic.id},now).items.some(i=>i.id===duplicate.id))
    const other=ranked[0]
    const source=f.rss.sieve.preference('source',f.source)
    for(const reason of ['topic','known']as const){
      const before=f.rss.sieve.preference('topic',topic.id)
      const oldScore=f.rss.sieve.query({threshold:0},now).items.find(i=>i.id===other.id)!.sieve.score
      f.rss.sieve.recordBehavior({id:reason,itemId:other.id,action:'less',reason,topicId:topic.id,at:now})
      assert.ok(f.rss.sieve.preference('topic',topic.id)<before)
      assert.ok(f.rss.sieve.query({threshold:0},now).items.find(i=>i.id===other.id)!.sieve.score<oldScore)
      assert.equal(f.rss.sieve.preference('source',f.source),source)
    }
    const before=f.rss.sieve.preference('topic',topic.id)
    f.rss.sieve.recordBehavior({id:'more',itemId:other.id,action:'more',reason:'topic',topicId:topic.id,at:now})
    assert.ok(f.rss.sieve.preference('topic',topic.id)>before)
    f.rss.sieve.recordBehavior({id:'shallow',itemId:other.id,action:'less',reason:'shallow',at:now})
    assert.ok(f.rss.sieve.preference('source',f.source)<source)
    assert.equal(f.rss.sieve.behaviors(other.id).length,4)
  }finally{f.db.close()}
})
