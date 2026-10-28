import { importIcs } from '../../../shared/calendar/ics'
import type { CalEvent } from '../../../shared/calendar/model'

export interface SyncResult { sourceId:string; ok:boolean; eventsCreated:number; eventsUpdated:number; eventsRemoved:number; error:string|null }
export interface SyncSummary { ok:number; failed:number; totalEvents:number }
export interface SyncSchedulerHandle { cancel():void }
interface Source {id:string;sync_url:string|null;sync_interval:number}
export interface SyncSchedulerDeps {
  getSources():Source[]
  fetchIcs(url:string,signal:AbortSignal):Promise<string>
  replaceEvents(sourceId:string,events:CalEvent[]):{created:number;updated:number;removed:number}
  onSourceSynced?:(result:SyncResult)=>void
  now():number
  scheduleAt(epochSec:number,fn:()=>void):SyncSchedulerHandle
}
export interface SyncScheduler {syncOne(id:string):Promise<SyncResult>;syncAll():Promise<SyncSummary>;startPeriodic():void;stop():void}
export function createSyncScheduler(deps:SyncSchedulerDeps):SyncScheduler {
  const timers=new Map<string,SyncSchedulerHandle>(),active=new Map<string,Promise<SyncResult>>(),controllers=new Set<AbortController>()
  let stopped=false
  const failed=(id:string,error:string):SyncResult=>({sourceId:id,ok:false,eventsCreated:0,eventsUpdated:0,eventsRemoved:0,error})
  function syncOne(id:string):Promise<SyncResult>{
    if(stopped)return Promise.resolve(failed(id,'sync-scheduler stopped'))
    const running=active.get(id);if(running)return running
    const controller=new AbortController();controllers.add(controller)
    const run=(async()=>{
      let result:SyncResult
      try{
        const source=deps.getSources().find(s=>s.id===id)
        if(!source?.sync_url)throw new Error('source not found or has no sync_url')
        const body=await deps.fetchIcs(source.sync_url,controller.signal)
        if(stopped||!deps.getSources().some(s=>s.id===id&&s.sync_url===source.sync_url))throw new Error('订阅已停止或变化')
        const parsed=importIcs(body,id,'UTC')
        if(parsed.warnings.length)throw new Error(`订阅内容不完整，保留原日程：${parsed.warnings.join('；')}`)
        const counts=deps.replaceEvents(id,parsed.events)
        result={sourceId:id,ok:true,eventsCreated:counts.created,eventsUpdated:counts.updated,eventsRemoved:counts.removed,error:null}
      }catch(error){result=failed(id,error instanceof Error?error.message:String(error))}
      if(!stopped){try{deps.onSourceSynced?.(result)}catch(error){console.error('[calendar] sync result consumer failed',error)}}
      return result
    })().finally(()=>{active.delete(id);controllers.delete(controller)})
    active.set(id,run);return run
  }
  function arm(source:Source){
    if(stopped||!source.sync_url)return
    timers.get(source.id)?.cancel()
    timers.set(source.id,deps.scheduleAt(deps.now()+Math.max(5,source.sync_interval||60)*60,()=>{
      timers.delete(source.id)
      void syncOne(source.id).finally(()=>{const current=deps.getSources().find(s=>s.id===source.id);if(current)arm(current)})
    }))
  }
  return {
    syncOne,
    async syncAll(){const results=await Promise.all(deps.getSources().filter(s=>s.sync_url).map(s=>syncOne(s.id)));return {ok:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,totalEvents:results.reduce((n,r)=>n+r.eventsCreated+r.eventsUpdated,0)}},
    startPeriodic(){if(stopped)return;for(const timer of timers.values())timer.cancel();timers.clear();deps.getSources().forEach(arm)},
    stop(){stopped=true;for(const timer of timers.values())timer.cancel();timers.clear();for(const controller of controllers)controller.abort()},
  }
}
