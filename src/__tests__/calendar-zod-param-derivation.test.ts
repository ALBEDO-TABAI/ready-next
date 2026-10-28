import assert from 'node:assert/strict'
import test from 'node:test'
import { executeCalendarTool } from '../main/modules/tools/calendar-tools'

test('all-day tool arguments reach the product bridge with dates and metadata intact',async()=>{
  const input={title:'Day',allDay:true,startDate:'2026-10-28',endDate:'2026-10-29',conferenceUrl:'https://example.test/room',attendees:[{email:'a@example.test',rsvp:'accepted'}]}
  const calls:unknown[]=[]
  const result=JSON.parse(await executeCalendarTool('calendar_create_event',input,{requestModuleToolAction:async(action,args)=>{calls.push({action,args});return {ok:true,eventId:'saved'}}}))
  assert.equal(result.ok,true);assert.deepEqual(calls,[{action:'calendar.createEvent',args:input}])
})
test('recurrence scope, revision and explicit clears survive tool validation',async()=>{
  const input={id:'event#123',scope:'this',expectedRevision:3,description:null,conferenceUrl:null}
  const calls:unknown[]=[]
  await executeCalendarTool('calendar_update_event',input,{requestModuleToolAction:async(action,args)=>{calls.push({action,args});return {ok:true}}})
  assert.deepEqual(calls,[{action:'calendar.updateEvent',args:input}])
})
test('incomplete create requests are rejected without calling the bridge',async()=>{
  let calls=0
  const result=await executeCalendarTool('calendar_create_event',{title:'Incomplete'},{requestModuleToolAction:async()=>{calls++;return{ok:true}}})
  assert.match(result,/^Error:/);assert.equal(calls,0)
})
