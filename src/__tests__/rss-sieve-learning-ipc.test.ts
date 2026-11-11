import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain } from 'electron'
import { sieveLearningGroup } from '../main/modules/rss-engine/ipc/sieve-learning-group'
import { rssB10Fixture } from './utils/rss-b10-fixture'

test('learning IPC registers, validates, reads back writes and disposes every channel',async t=>{
  if (skipIfSqliteUnavailable(t, 'B10 requires native SQLite')) return
  const f=rssB10Fixture(t),handlers=new Map<string,(_event:unknown,input?:unknown)=>unknown>()
  let changes=0
  const ipc={handle:(name:string,handler:(_event:unknown,input?:unknown)=>unknown)=>handlers.set(name,handler),removeHandler:(name:string)=>handlers.delete(name)}
  const handle=sieveLearningGroup.register(ipc as unknown as IpcMain,{store:()=>f.rss,notify:()=>changes++})
  const call=(name:string,input?:unknown)=>handlers.get(`rss:${name}`)!(null,input)
  assert.deepEqual(call('sieveCalibration'),{success:true,data:null})
  assert.deepEqual(call('sieveNotificationSettings'),{success:true,data:{quietStart:'22:00',quietEnd:'08:00'}})
  assert.deepEqual(call('sieveSaveNotificationSettings',{quietStart:'23:00',quietEnd:'07:30'}),{success:true,data:{quietStart:'23:00',quietEnd:'07:30'}})
  assert.equal((call('sieveSaveNotificationSettings',{quietStart:'99:00',quietEnd:'07:00'}) as {success:boolean}).success,false)
  const topic=f.rss.organization.save({name:'主题',description:'标准'})
  assert.deepEqual(call('sieveTopicNotifications'),{success:true,data:[{topicId:topic.id,urgent:false}]})
  assert.deepEqual(call('sieveSaveTopicNotification',{topicId:topic.id,urgent:true}),{success:true,data:{topicId:topic.id,urgent:true}})
  assert.equal((call('sieveSaveTopicNotification',{topicId:'curated',urgent:true}) as {success:boolean}).success,false)
  assert.equal((call('importOpml',{xml:'broken'}) as {success:boolean}).success,false)
  assert.deepEqual(call('importOpml',{xml:'<opml><body/></opml>'}),{success:true,data:{added:0,existing:0,sourceIds:[]}})
  assert.deepEqual(call('sieveSettings'), { success: true, data: { explore: true } })
  assert.deepEqual(call('sieveSaveSettings', { explore: false }), { success: true, data: { explore: false } })
  assert.deepEqual(call('sieveSettings'), { success: true, data: { explore: false } })
  for (const input of [{}, { explore: 'false' }, { explore: true, extra: 1 }]) {
    assert.equal((call('sieveSaveSettings', input) as { success: boolean }).success, false)
  }
  assert.equal(changes, 4)
  assert.equal(handlers.size, 13)
  handle.dispose();assert.equal(handlers.size,0)
})
