import { BrowserWindow, Notification } from 'electron'
import { getDatabase } from '../database'
import { completeRSSModel, validateRSSModelRequest } from './model-completion'
import { hasRSSProcessingModel, rssModelConfig } from './model-readiness'
import { RSSCalibrationService } from './sieve-calibration'
import { deliverRSSNotifications } from './sieve-notifications'

let timer:ReturnType<typeof setInterval>|null=null
let active:Promise<void>|null=null
let calibration:RSSCalibrationService|null=null
let getWindow:()=>BrowserWindow|null=()=>null
function changed():void {
  for(const window of BrowserWindow.getAllWindows()) if(!window.isDestroyed()) window.webContents.send('rss:organizationChanged')
}
function tick():Promise<void> {
  if(active) return active
  active=Promise.resolve().then(async()=>{
    if(!timer) return
    const rss=getDatabase().rss
    deliverRSSNotifications(rss,{
      available:()=>Notification.isSupported(),
      send:(item,onClick)=>{const notification=new Notification({title:item.title,body:item.sieve.reason});notification.on('click',onClick);notification.show()},
      open:itemId=>{
        rss.learning.requestOpen(itemId)
        const window=getWindow()
        if(!window || window.isDestroyed()) return
        if(window.isMinimized()) window.restore()
        window.show();window.focus();window.webContents.send('rss:sieveOpenPending')
      },
    })
    await calibration?.wake()
  }).catch(error=>console.error('[rss-sieve] background cycle failed',error)).finally(()=>{active=null})
  return active
}
export function startRSSSieve(window:()=>BrowserWindow|null):Promise<void> {
  getWindow=window
  if(!timer) {
    const rss=getDatabase().rss
    rss.learning.recover()
    calibration=new RSSCalibrationService({rss,hasModel:hasRSSProcessingModel,now:Date.now,notify:changed,prepare:request=>{
      const config=rssModelConfig();validateRSSModelRequest(config,request)
      return ()=>completeRSSModel(config,request)
    }})
    timer=setInterval(()=>{void tick()},60_000);timer.unref()
  }
  return tick()
}
export async function stopRSSSieve():Promise<void> {
  if(timer) clearInterval(timer)
  timer=null
  await calibration?.stop()
  await active
  calibration=null
}
