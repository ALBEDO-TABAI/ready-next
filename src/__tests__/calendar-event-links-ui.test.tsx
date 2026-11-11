import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import Database from 'better-sqlite3'
import { registerHooks } from 'node:module'
import { mkdtempSync, realpathSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../main/modules/migrations'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { CalendarMeetingNotes } from '../main/modules/calendar-engine/meeting-notes'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { DocumentPageService } from '../main/modules/document-pages/service'
import type { CalendarCommand, CalendarDelta } from '../shared/calendar/commands'
import type { ObjectLinkQuery } from '../shared/object-links'
import type { MeetingNoteInput } from '../shared/calendar/event-links'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('M6-A panel adds/unlinks/undoes real edges, opens exact refs, saves one note through SaveToPicker and disables subscription writes', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar links panel')) return
  const db = new Database(':memory:');runMigrations(db)
  const vault = realpathSync(mkdtempSync(join(tmpdir(),'ready-m6-ui-')))
  const engine = new SearchEngine(db,{fts5Available:true});engine.getRepository().ensureWorkspace(vault)
  const registry = new ObjectRegistry(db)
  const parent=join(vault,'Parent.md');writeFileSync(parent,'# Parent\n');registry.register(parent)
  const index = async (path:string) => {assert.equal((await engine.indexDocument(vault,path)).ok,true)}
  const pages = new DocumentPageService(registry,{index})
  const drafts = new DocumentDraftService(db,{registry,index:(_root,path)=>index(path)})
  const calendar = new CalendarStore(()=>db), notes = new CalendarMeetingNotes(db,calendar,drafts)
  calendar.putCalendar({id:'local',accountId:'local',name:'Local',color:'#4488CC',visible:true})
  const start=Date.parse('2026-10-29T09:00:00Z'), second=start+86400000, key=`series|${second}`
  calendar.mutate({type:'create',event:{id:'series',uid:'series@test',calendarId:'local',title:'Meeting',allDay:false,start,end:start+3600000,
    rrule:'FREQ=DAILY;COUNT=3',timeZone:'UTC',status:'confirmed',transparency:'opaque',createdAt:1,updatedAt:1}}, {})
  const dom = new JSDOM('<div id="root"></div>',{url:'http://localhost'})
  Object.assign(dom.window,{matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})})
  const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,
    HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}}
  const previous=Object.fromEntries(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true})
  // Only the navigation destination is replaced (for the panel and its reference capsules); component, picker, service, files and SQLite are real.
  const navigation='data:text/javascript,'+encodeURIComponent('export const opened=[];export async function openReadyRef(ref){opened.push(ref)}')
  const hooks=registerHooks({resolve(specifier,context,next){
    if(specifier==='@shared/calendar')return next(new URL('../shared/calendar/index.ts',import.meta.url).href,context)
    if(specifier.startsWith('@shared/'))return next(new URL(`../shared/${specifier.slice(8)}.ts`,import.meta.url).href,context)
    return specifier.endsWith('/workbench/open-ready-ref')&&(context.parentURL?.includes('/EventLinks')||context.parentURL?.includes('/ref-capsule-actions'))
      ?{url:navigation,shortCircuit:true}:next(specifier,context)
  }})
  const reply=async<T,>(work:()=>T|Promise<T>)=>{try{return {success:true,data:await work()}}catch(error){return {success:false,error:String(error)}}}
  const relations=new ObjectLinkRepository(db)
  Object.assign(dom.window,{electronAPI:{
    calendar:{snapshot:()=>reply(()=>calendar.snapshot()),mutate:(c:CalendarCommand,v:Record<string,number>)=>reply(()=>calendar.mutate(c,v)),
      restore:(d:CalendarDelta,v:Record<string,number>)=>reply(()=>calendar.restore(d,v)),onChanged:()=>()=>{},
      createMeetingNote:(input:MeetingNoteInput)=>reply(()=>notes.create(vault,input)),pendingMeetingNote:(key:string)=>reply(()=>notes.pendingDestination(vault,key))},
    vault:{get:async()=>({status:'ready',root:vault})},
    documentPages:{tree:async()=>({ok:true,value:await pages.tree({path:vault,kind:'vault'})}),onChanged:()=>()=>{}},
    document:{getObjectIncomingLinks:(query:ObjectLinkQuery)=>reply(()=>relations.incoming(query.endpoint)),
      // The "+" picker uses the same search as @: a Ready web reference comes back from the index.
      searchIndex:async({query}:{query:string})=>({success:true,data:{items:/meeting/i.test(query)?[{path:'ready://web?url=https%3A%2F%2Fexample.com%2Fmeeting',name:'https://example.com/meeting',sourceType:'web'}]:[]}})},
  }})
  const {useWorkspace}=await import('../renderer/stores/useWorkspace');useWorkspace.setState({workspaceRoot:vault,pinnedFolders:[]})
  const {FloatHost}=await import('../renderer/components/ui/float/Float')
  const {createRoot}=await import('react-dom/client'), {EventLinks}=await import('../renderer/modules/calendar/workbench/components/EventLinks')
  const root=createRoot(dom.window.document.getElementById('root')!)
  t.after(async()=>{await act(async()=>root.unmount());hooks.deregister();dom.window.close();engine.cancelPendingWorkspaceResolves();db.close();rmSync(vault,{recursive:true,force:true})
    for(const [key,descriptor] of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}})
  const flush=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))})
  const click=async(label:string)=>{const button=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label)
    assert.ok(button,label);assert.equal(button.disabled,false,label);await act(async()=>button.click());await flush()}
  // Related objects are reference capsules (W6 §2.1), named by their type and title.
  const capsule=async(name:string|RegExp)=>{const link=[...dom.window.document.querySelectorAll<HTMLElement>('a[data-ready-ref-capsule]')].find(a=>typeof name==='string'?a.getAttribute('aria-label')===name:name.test(a.getAttribute('aria-label')||''))
    assert.ok(link,String(name));await act(async()=>link.click());await flush()}
  await act(async()=>root.render(<><EventLinks occKey={key} title="Meeting" readOnly={false}/><FloatHost/></>));await flush()
  // No address to paste: "+" opens the search, typing finds the reference, choosing it links it.
  await click('添加关联')
  const search=dom.window.document.querySelector<HTMLInputElement>('[aria-label="搜索关联"]')!
  assert.ok(search,'the picker opens with a search field')
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(search,'meeting');search.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
  for(let i=0;i<20&&!dom.window.document.querySelector('[role="option"]');i++)await flush()
  await act(async()=>dom.window.document.querySelector<HTMLButtonElement>('[role="option"]')!.click());await flush()
  assert.equal(calendar.snapshot().links![0].originalStart,second)
  await capsule('网页 example.com/meeting')
  const {opened}=await import(navigation);assert.deepEqual(opened,[{kind:'web',url:'https://example.com/meeting'}])
  await click('解除关联 example.com/meeting');assert.equal(calendar.snapshot().links!.length,0)
  await click('撤销上次关联修改');assert.equal(calendar.snapshot().links!.length,1)
  await click('会议笔记');assert.ok(dom.window.document.querySelector('[role="dialog"]'))
  await click('Parent')
  await click('确认')
  for(let i=0;i<30&&!calendar.snapshot().links!.some(link=>link.purpose==='meeting-note');i++)await flush()
  assert.equal(calendar.snapshot().links!.filter(link=>link.purpose==='meeting-note').length,1)
  assert.equal(readdirSync(join(vault,'Parent')).filter(name=>name.endsWith('.md')).length,1)
  assert.equal(readFileSync(parent,'utf8'),'# Parent\n')
  await flush();await capsule(/^页面 /);assert.equal(opened.at(-1).kind,'page')
  assert.ok(dom.window.document.body.textContent?.includes('反链'))
  assert.ok(relations.incoming({ref:{kind:'event',id:'series',occurrence:String(second)}}).length)
  await act(async()=>root.render(<><EventLinks occKey={key} title="Meeting" readOnly={true}/><FloatHost/></>))
  assert.equal(dom.window.document.querySelector('[aria-label="添加关联"]'),null)
  assert.equal([...dom.window.document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')?.startsWith('解除关联')),false)
})

export const __breaksInvariants=['isolated-panel-navigation-destination-replaced'] as const
