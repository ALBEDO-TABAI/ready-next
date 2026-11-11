import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'
import type { RSSSieveStore } from './rss-sieve-store'
import type { RSSProcessingStore } from './rss-processing-store'
import { SettingsStore } from './settings-store'
import { RSSCalibrationDecisionSchema, RSSNotificationSettingsSchema, RSSTopicNotificationSchema,
  type RSSCalibration, type RSSCalibrationDecision, type RSSSieveMetrics, type RSSNotificationSettings } from '../../../shared/rss-sieve'

export function rssCalibrationWeek(now: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() - (date.getDay() + 6) % 7)
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
const NOTIFICATION_SETTINGS = 'rss:sieve-notifications'
export class RSSSieveLearningStore {
  constructor(private readonly connection: () => DatabaseConnection|null, private readonly sieve: RSSSieveStore, private readonly processing: RSSProcessingStore) {}
  private get db() { const db=this.connection(); assertDatabaseConnectionReady(db,'RSS learning'); return db }
  private transaction<T>(action:()=>T):T {
    this.db.exec('SAVEPOINT rss_learning')
    try { const result=action();this.db.exec('RELEASE rss_learning');return result }
    catch(error) { this.db.exec('ROLLBACK TO rss_learning; RELEASE rss_learning');throw error }
  }
  calibration(now=Date.now()): RSSCalibration|null {
    const row=this.db.prepare('SELECT week,base_version AS baseVersion,status,text,explanation FROM rss_calibrations WHERE week=?').get<Omit<RSSCalibration,'stale'>>(rssCalibrationWeek(now))
    return row ? {...row,stale:row.baseVersion!==this.sieve.focus().version} : null
  }
  queue(now:number): RSSCalibration|null {
    this.db.prepare("INSERT OR IGNORE INTO rss_calibrations(week,base_version,status) VALUES(?,?,'queued')").run(rssCalibrationWeek(now),this.sieve.focus().version)
    return this.calibration(now)
  }
  recover():void { this.db.prepare("UPDATE rss_calibrations SET status='unknown',error='请求中断，不会自动重试' WHERE status='running'").run() }
  claim(now:number,hasModel:boolean):boolean {
    return this.transaction(()=>{
      const status=this.processing.status(now,hasModel)
      if(status.blocked) return false
      return !!this.db.prepare("UPDATE rss_calibrations SET status='running',base_version=?,started_at=? WHERE week=? AND status='queued' RETURNING week")
        .get(this.sieve.focus().version,now,rssCalibrationWeek(now))
    })
  }
  finish(week:string,result:{text:string;explanation:string}|null,now:number,error?:string):void {
    this.db.prepare("UPDATE rss_calibrations SET status=?,text=?,explanation=?,finished_at=?,error=? WHERE week=? AND status='running'")
      .run(result?'pending':'failed',result?.text??null,result?.explanation??null,now,error??null,week)
  }
  accept(input:RSSCalibrationDecision) {
    const value=RSSCalibrationDecisionSchema.parse(input)
    return this.transaction(()=>{
      const proposal=this.calibration()
      if(!proposal || proposal.week!==value.week || proposal.status!=='pending') throw new Error('校准提案已失效，请重新读取')
      if(proposal.baseVersion!==value.expectedVersion || proposal.stale) throw new Error('我的关注已变化，请重新读取后手动修改')
      const focus=this.sieve.saveFocus({text:value.text??proposal.text!,expectedVersion:value.expectedVersion})
      this.db.prepare("UPDATE rss_calibrations SET status='accepted' WHERE week=?").run(value.week)
      return focus
    })
  }
  dismiss(input:{week:string}):RSSCalibration {
    const {week}=z.object({week:z.string()}).strict().parse(input)
    const current=this.calibration()
    if(!current || current.week!==week || current.status!=='pending') throw new Error('校准提案已失效，请重新读取')
    this.db.prepare("UPDATE rss_calibrations SET status='dismissed' WHERE week=?").run(week)
    return this.calibration()!
  }
  evidence(now:number) {
    return this.db.prepare(`SELECT i.id,i.title,s.name AS source,
      (SELECT json_group_array(DISTINCT json_object('action',b.action,'reason',b.reason,'topicId',b.topic_id)) FROM rss_behaviors b
        WHERE b.item_id=i.id AND b.occurred_at BETWEEN ? AND ?) AS actions,
      EXISTS(SELECT 1 FROM rss_sieve_exposures e WHERE e.item_id=i.id AND e.shown_at BETWEEN ? AND ?) AS screened
      FROM rss_items i JOIN rss_sources s ON s.id=i.source_id WHERE
        EXISTS(SELECT 1 FROM rss_behaviors b WHERE b.item_id=i.id AND b.occurred_at BETWEEN ? AND ?)
        OR EXISTS(SELECT 1 FROM rss_sieve_exposures e WHERE e.item_id=i.id AND e.shown_at BETWEEN ? AND ?)
      ORDER BY i.first_seen_at DESC,i.id LIMIT 100`).all<{id:string;title:string;source:string;actions:string;screened:number}>(...Array.from({length:4},()=>[now-7*86400000,now]).flat())
      .map(row=>({...row,title:row.title.slice(0,300),source:row.source.slice(0,100),actions:JSON.parse(row.actions)}))
  }
  metrics(now=Date.now()):RSSSieveMetrics {
    const from=now-14*86400000
    const screened=this.db.prepare('SELECT COUNT(*) AS n FROM rss_sieve_exposures WHERE shown_at BETWEEN ? AND ?').get<{n:number}>(from,now)!.n
    const hits=this.db.prepare(`SELECT COUNT(*) AS n FROM rss_sieve_exposures e WHERE e.shown_at BETWEEN ? AND ? AND EXISTS
      (SELECT 1 FROM rss_behaviors b WHERE b.item_id=e.item_id AND b.occurred_at BETWEEN e.shown_at AND ?
        AND b.action IN ('open','star','note','fastcard','document'))`).get<{n:number}>(from,now,now)!.n
    const missed=this.db.prepare(`SELECT COUNT(DISTINCT b.item_id) AS n FROM rss_behaviors b WHERE b.occurred_at BETWEEN ? AND ?
      AND b.action IN ('star','note','fastcard','document') AND NOT EXISTS
      (SELECT 1 FROM rss_sieve_exposures e WHERE e.item_id=b.item_id AND e.shown_at<=b.occurred_at)`).get<{n:number}>(from,now)!.n
    return {from,until:now,screened,hits,hitRate:screened?hits/screened:null,missed}
  }
  requestOpen(itemId:string):void {
    if(!this.db.prepare('SELECT id FROM rss_items WHERE id=?').get(itemId)) throw new Error('文章已不存在')
    new SettingsStore(this.connection).setSetting('rss:sieve-pending-open',JSON.stringify({id:randomUUID(),itemId}))
  }
  pendingOpen():{id:string;itemId:string}|null {
    const raw=new SettingsStore(this.connection).getSetting('rss:sieve-pending-open')
    return raw?z.object({id:z.string(),itemId:z.string()}).parse(JSON.parse(raw)):null
  }
  ackOpen(id:string):void {
    if(this.pendingOpen()?.id===id) new SettingsStore(this.connection).setSetting('rss:sieve-pending-open','')
  }
  notificationSettings():RSSNotificationSettings {
    const raw=new SettingsStore(this.connection).getSetting(NOTIFICATION_SETTINGS)
    return raw?RSSNotificationSettingsSchema.parse(JSON.parse(raw)):{quietStart:'22:00',quietEnd:'08:00'}
  }
  saveNotificationSettings(input:RSSNotificationSettings) {
    const settings=RSSNotificationSettingsSchema.parse(input)
    new SettingsStore(this.connection).setSetting(NOTIFICATION_SETTINGS,JSON.stringify(settings));return settings
  }
  topicNotifications():{topicId:string;urgent:boolean}[] {
    return this.db.prepare(`SELECT d.id AS topicId,COALESCE(n.urgent,0) AS urgent FROM rss_definitions d
      LEFT JOIN rss_topic_notifications n ON n.topic_id=d.id WHERE d.kind='topic' ORDER BY d.position,d.id`)
      .all<{topicId:string;urgent:number}>().map(row=>({...row,urgent:row.urgent===1}))
  }
  saveTopicNotification(input:{topicId:string;urgent:boolean}) {
    const value=RSSTopicNotificationSchema.parse(input)
    if(!this.db.prepare("SELECT id FROM rss_definitions WHERE id=? AND kind='topic'").get(value.topicId)) throw new Error('主题不存在')
    this.db.prepare('INSERT INTO rss_topic_notifications VALUES(?,?) ON CONFLICT(topic_id) DO UPDATE SET urgent=excluded.urgent').run(value.topicId,Number(value.urgent))
    return value
  }
  claimNotification(itemId:string,now:number):boolean {
    return this.transaction(()=>{
      const start=new Date(now);start.setHours(0,0,0,0)
      if(this.db.prepare('SELECT COUNT(*) AS n FROM rss_notification_deliveries WHERE delivered_at>=? AND delivered_at<=?').get<{n:number}>(start.getTime(),now)!.n>=3) return false
      return this.sieve.recordDelivery(itemId,now)
    })
  }
}
