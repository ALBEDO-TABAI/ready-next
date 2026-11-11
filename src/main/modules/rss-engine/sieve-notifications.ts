import type { RSSStore } from '../database/rss-store'
import type { RSSSieveItem } from '../../../shared/rss-sieve'

export interface RSSNotificationPort { available():boolean; send(item:RSSSieveItem,onClick:()=>void):void; open(itemId:string):void }
export function deliverRSSNotifications(rss:RSSStore,port:RSSNotificationPort,now=Date.now()):number {
  if(!port.available()) return 0
  const {quietStart,quietEnd}=rss.learning.notificationSettings(),date=new Date(now)
  const minute=`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
  if(quietStart<quietEnd ? minute>=quietStart && minute<quietEnd : quietStart>quietEnd && (minute>=quietStart || minute<quietEnd)) return 0
  const urgent=new Set(rss.learning.topicNotifications().filter(topic=>topic.urgent).map(topic=>topic.topicId))
  if(!urgent.size) return 0
  const selection = rss.sieve.query({ threshold: 85 }, now, false, false)
  const candidates=[...selection.items,...selection.remaining].filter(item=>item.sieve.eligible && item.sieve.score>=85
    && item.classifications.some(c=>c.included && !c.stale && urgent.has(c.definitionId))).sort((a,b)=>b.sieve.score-a.sieve.score)
  let delivered=0
  for(const item of candidates) {
    // Reserve durably before touching the OS. An uncertain send is never repeated, including after restart.
    if(!rss.learning.claimNotification(item.id,now)) continue
    try { port.send(item,()=>{
      try { port.open(item.id) } catch(error) { console.error('[rss-notification] article could not be opened',error) }
    });delivered++ }
    catch(error) { console.error('[rss-notification] delivery uncertain; will not resend',error) }
  }
  return delivered
}
