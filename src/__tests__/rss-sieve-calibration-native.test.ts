import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import { RSSCalibrationService } from '../main/modules/rss-engine/sieve-calibration'
import { rssB10Fixture } from './utils/rss-b10-fixture'
import type { RSSCompletionRequest } from '../main/modules/rss-engine/model-completion'

function calibration(f:ReturnType<typeof rssB10Fixture>,options:{ready?:boolean;complete?:(request:RSSCompletionRequest)=>Promise<string>}={}) {
  return new RSSCalibrationService({rss:f.rss,hasModel:()=>options.ready??true,now:()=>f.now,notify:()=>{},prepare:request=>()=>options.complete?.(request)??Promise.resolve(JSON.stringify({text:'关注视频制作与独立出版',explanation:'最近常收藏这两类文章'}))})
}
function evidence(f:ReturnType<typeof rssB10Fixture>) { f.put('read');f.rss.sieve.recordBehavior({id:'open',itemId:'read',action:'open',at:f.now}) }

test('V3 a single weekly proposal leaves focus unchanged; accepting reaches the next real judgment request',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t);evidence(f)
  let calls=0
  const service=calibration(f,{complete:async request=>{calls++;assert.match(request.user,/read/);return JSON.stringify({text:'新的关注',explanation:'根据阅读记录'})}})
  await Promise.all([service.wake(),service.wake()]);await service.wake()
  assert.equal(calls,1);assert.deepEqual(f.rss.sieve.focus(),{text:'',version:0})
  assert.equal(f.rss.processing.status(f.now,true).callsToday,1)
  const proposal=f.rss.learning.calibration(f.now)!
  assert.equal(proposal.status,'pending')
  assert.deepEqual(f.rss.learning.accept({week:proposal.week,expectedVersion:0}),{text:'新的关注',version:1})
  f.put('next');let requested=false
  await f.judge(input=>{assert.equal(input.focus,'新的关注');requested=true})
  assert.equal(requested,true)
  assert.throws(()=>f.rss.learning.accept({week:proposal.week,expectedVersion:0}),/失效/)
})
test('dismissal persists this week; manual focus edits reject stale acceptance; edited proposal saves once',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t);evidence(f)
  await calibration(f).wake();const p=f.rss.learning.calibration(f.now)!
  f.rss.learning.dismiss({week:p.week})
  await calibration(f,{complete:async()=>{throw new Error('must not request')}}).wake()
  assert.equal(f.rss.learning.calibration(f.now)!.status,'dismissed')
  assert.equal(f.rss.sieve.focus().version,0)
  const g=rssB10Fixture(t);evidence(g);await calibration(g).wake()
  g.rss.sieve.saveFocus({text:'我刚改过',expectedVersion:0})
  assert.throws(()=>g.rss.learning.accept({week:p.week,expectedVersion:0}),/已变化/)
  assert.equal(g.rss.sieve.focus().text,'我刚改过')
  const h=rssB10Fixture(t);evidence(h);await calibration(h).wake()
  assert.equal(h.rss.learning.accept({week:p.week,expectedVersion:0,text:'手动改写建议'}).text,'手动改写建议')
})
test('model unready and exhausted shared budget leave calibration queued without a request; failed requests never retry',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t);evidence(f)
  await calibration(f,{ready:false}).wake();assert.equal(f.rss.learning.calibration(f.now)!.status,'queued')
  f.rss.processing.configure({enabled:true,dailyLimit:1});await f.judge()
  await calibration(f,{complete:async()=>{throw new Error('over quota')}}).wake()
  assert.equal(f.rss.learning.calibration(f.now)!.status,'queued')
  f.rss.processing.configure({enabled:true,dailyLimit:2})
  let calls=0
  const service=calibration(f,{complete:async()=>{calls++;throw new Error('request failed')}})
  await service.wake();await service.wake()
  assert.equal(calls,1);assert.equal(f.rss.learning.calibration(f.now)!.status,'failed')
  assert.equal(f.rss.processing.status(f.now,true).callsToday,2)
  assert.equal(f.rss.sieve.focus().text,'')
})
test('interrupted weekly call recovers as unknown and cannot be claimed twice',t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t);evidence(f);f.rss.learning.queue(f.now)
  assert.equal(f.rss.learning.claim(f.now,true),true)
  assert.equal(f.rss.learning.claim(f.now,true),false)
  f.rss.learning.recover()
  assert.equal(f.rss.learning.calibration(f.now)!.status,'unknown')
  assert.equal(f.rss.learning.claim(f.now,true),false)
})
test('V2 topic feedback immediately changes the next article score and persists in SQLite',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t),topic=f.rss.organization.save({name:'主题',description:'关注'})
  f.put('one');f.put('two');await f.judge()
  const before=f.rss.sieve.query({},f.now).items.find(i=>i.id==='two')!.sieve.score
  f.rss.sieve.recordBehavior({id:'more',itemId:'one',action:'more',reason:'topic',topicId:topic.id,at:f.now})
  const after=f.rss.sieve.query({},f.now).items.find(i=>i.id==='two')!.sieve.score
  assert.ok(after>before)
  assert.ok(f.db.prepare('SELECT value FROM rss_topic_preferences WHERE topic_id=?').get<{value:number}>(topic.id)!.value>0.5)
  f.rss.sieve.recordBehavior({id:'less',itemId:'one',action:'less',reason:'source',at:f.now})
  assert.ok(f.rss.sieve.query({},f.now).items.find(i=>i.id==='two')!.sieve.score<after)
  assert.equal(f.rss.sieve.behaviors('one').length,2)
})
test('14-day metrics count distinct shown articles and actions after exposure; late exposure cannot erase a miss',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t)
  for(const id of ['hit','idle','miss','older']) f.put(id)
  await f.judge()
  const before=f.now-1000
  f.db.prepare('INSERT INTO rss_sieve_exposures VALUES(?,?)').run('hit',before)
  f.db.prepare('INSERT INTO rss_sieve_exposures VALUES(?,?)').run('idle',before)
  f.db.prepare('INSERT INTO rss_sieve_exposures VALUES(?,?)').run('older',f.now-15*86400000)
  for(const [id,itemId,action] of [['a','hit','open'],['b','hit','star'],['c','miss','fastcard'],['d','miss','star']] as const)
    f.rss.sieve.recordBehavior({id,itemId,action,at:f.now})
  const m=f.rss.learning.metrics(f.now)
  assert.deepEqual({screened:m.screened,hits:m.hits,hitRate:m.hitRate,missed:m.missed},{screened:2,hits:1,hitRate:.5,missed:1})
  f.rss.sieve.query({},f.now+1)
  assert.equal(f.rss.learning.metrics(f.now+1).missed,1)
  assert.equal(f.rss.learning.metrics(f.now-20*86400000).hitRate,null)
})

test('stopping calibration aborts the request and a late result never becomes a pending proposal',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t);evidence(f)
  let release!:(text:string)=>void,signal:AbortSignal|undefined
  const service=calibration(f,{complete:request=>{signal=request.signal;return new Promise(resolve=>{release=resolve})}})
  const work=service.wake(),stopped=service.stop()
  assert.equal(signal!.aborted,true)
  release(JSON.stringify({text:'迟到的建议',explanation:'不得发布'}));await stopped;await work
  assert.equal(f.rss.learning.calibration(f.now)!.status,'failed')
  assert.equal(f.rss.sieve.focus().text,'')
  await service.wake();assert.equal(f.rss.processing.status(f.now,true).callsToday,1)
})

test('a proposal wrapped in a ```json fence is still read; it is never retried, so the fence must not fail it',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t);evidence(f)
  const service=calibration(f,{complete:async()=>'```json\n'+JSON.stringify({text:'围栏里的关注',explanation:'模型加了代码块'})+'\n```'})
  await service.wake()
  const proposal=f.rss.learning.calibration(f.now)!
  assert.equal(proposal.status,'pending')
  assert.equal(proposal.text,'围栏里的关注')
})
