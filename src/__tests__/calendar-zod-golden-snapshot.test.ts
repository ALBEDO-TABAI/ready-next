import assert from 'node:assert/strict'
import test from 'node:test'
import { getCalendarAnthropicTools,getCalendarOpenAITools } from '../main/modules/tools/calendar-tools'

const names=['calendar_list_window','calendar_create_event','calendar_update_event','calendar_delete_event','calendar_capture_session']
const details=['startTz','endTz','startDate','endDate','url','conferenceUrl','color','status','transparency','visibility','attendees']
const targets=['scope','occurrenceStart','expectedRevision']
const fields:Record<string,string[]>={
  calendar_list_window:['calendarId','start','end'],
  calendar_create_event:[...details,'title','startTime','endTime','calendarId','description','location','allDay','reminders','recurrenceRule'],
  calendar_update_event:[...details,...targets,'id','title','startTime','endTime','description','location','allDay','reminders','recurrenceRule'],
  calendar_delete_event:[...targets,'id'],calendar_capture_session:[],
}
test('calendar provider schemas expose exactly the complete local-calendar field surface',()=>{
  const tools=getCalendarAnthropicTools() as any[]
  assert.deepEqual(tools.map(t=>t.name),names)
  for(const tool of tools){assert.match(tool.description,/不是飞书日历/);assert.deepEqual(Object.keys(tool.input_schema.properties).sort(),fields[tool.name].sort());assert.equal(tool.input_schema.additionalProperties,false)}
  const create=tools[1].input_schema
  assert.deepEqual(create.required,['title'])
  assert.deepEqual(create.properties.reminders.items.required,['offsetMinutes','method'])
  assert.deepEqual(create.properties.reminders.items.properties.method.enum,['notification','sound'])
  assert.deepEqual(create.properties.attendees.items.properties.rsvp.enum,['accepted','declined','tentative','needsAction'])
  assert.ok(create.properties.conferenceUrl.anyOf.some((s:any)=>s.type==='null'))
  assert.deepEqual(tools[2].input_schema.properties.scope.enum,['this','following','all'])
})
test('OpenAI and Anthropic receive the same complete structured schema',()=>{
  const anthropic=getCalendarAnthropicTools() as any[],openai=getCalendarOpenAITools() as any[]
  assert.equal(openai.length,5)
  openai.forEach((tool,i)=>{assert.equal(tool.type,'function');assert.equal(tool.function.name,anthropic[i].name);assert.deepEqual(tool.function.parameters,anthropic[i].input_schema)})
})
