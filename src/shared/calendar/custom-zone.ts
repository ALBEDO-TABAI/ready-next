import ICAL from 'ical.js'

const zones = new Map<string, { definition:string; name:string; zone:InstanceType<typeof ICAL.Timezone> }>()
const definitions = new Map<string,string>()
/** Each imported VTIMEZONE keeps its own rules, even when feeds reuse the same TZID. */
export function registerCalendarZone(definition:string):string {
  const known=definitions.get(definition);if(known)return known
  if(definition.length>100000)throw new Error('时区定义过大')
  const component=new ICAL.Component(ICAL.parse(definition))
  if(component.name!=='vtimezone')throw new Error('时区定义无效')
  const name=String(component.getFirstPropertyValue('tzid')||'')
  if(!name||!component.getAllSubcomponents().length)throw new Error('时区定义不完整')
  let hash=2166136261
  for(let i=0;i<definition.length;i++)hash=Math.imul(hash^definition.charCodeAt(i),16777619)>>>0
  const key=`ready-tz:${hash.toString(16)}`
  if(zones.has(key)&&zones.get(key)!.definition!==definition)throw new Error('时区标识冲突')
  zones.set(key,{definition,name,zone:new ICAL.Timezone({component,tzid:name})});definitions.set(definition,key)
  return key
}
export const customCalendarZone=(id:string)=>zones.get(id)
export function customWall(ms:number,id:string){
  const value=zones.get(id);if(!value)return null
  const t=ICAL.Time.fromJSDate(new Date(ms),true).convertToZone(value.zone)
  return {y:t.year,m:t.month,d:t.day,h:t.hour,mi:t.minute,s:t.second}
}
export function customInstant(w:{y:number;m:number;d:number;h?:number;mi?:number;s?:number},id:string):number|null{
  const value=zones.get(id);if(!value)return null
  return new ICAL.Time({year:w.y,month:w.m,day:w.d,hour:w.h||0,minute:w.mi||0,second:w.s||0,isDate:false},value.zone).toUnixTime()*1000
}
