import Database from 'better-sqlite3'
import type { TestContext } from 'node:test'
import { runMigrations } from '../../main/modules/migrations'
import type { DatabaseConnection } from '../../main/modules/database/connection'
import { RSSStore } from '../../main/modules/database/rss-store'
import { RSSProcessingService } from '../../main/modules/rss-engine/processing-service'
import type { RSSJudgmentInput } from '../../main/modules/rss-engine/processing-judgment'

export function rssB10Fixture(t:TestContext,path=':memory:') {
  const db:DatabaseConnection=new Database(path);runMigrations(db);t.after(()=>db.close())
  const rss=new RSSStore(()=>db),now=Date.now()
  const source=rss.addRSSSource({name:'来源',url:'https://example.test/feed'})
  rss.setRSSSourceDraftSeeded(source,true)
  const put=(id:string,published=now)=>{
    rss.upsertRSSItems([{id,source_id:source,guid:id,title:id,link:`https://example.test/${id}`,summary:'摘要',published_at:published/1000}])
    const claim=rss.content.beginLoad(id)!
    rss.content.finishLoad(claim,{status:'ready',markdown:'保存正文以及证据。'.repeat(100),sourceUrl:`https://example.test/${id}`})
  }
  const output=(input:RSSJudgmentInput,score=100)=>JSON.stringify({relevance:{score,because:'standard',reason:'符合标准',workRef:null},
    decisions:input.definitions.map(d=>({definitionId:d.id,included:true,reason:'符合',evidence:input.source.title})),
    ...(input.eventContext && !input.eventContext.manual && !input.eventContext.reused ? {event:{kind:'insufficient',eventId:null,factId:null,quote:null,sourceRole:'unknown',reason:'不足'}}:{})})
  const judge=(inspect?:(input:RSSJudgmentInput)=>void)=>new RSSProcessingService({store:rss.processing,getArticle:id=>rss.content.getArticle(id),hasModel:()=>true,now:()=>now,notify:()=>{},focus:()=>rss.sieve.focus().text,prepare:input=>async()=>{inspect?.(input);return output(input)}}).wake()
  return {db,rss,now,source,put,judge,output}
}
