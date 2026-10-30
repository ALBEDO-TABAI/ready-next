import { useCallback, useEffect, useRef, useState } from 'react'
import { splitOccurrenceKey, type CalendarMutationReceipt, type CalendarSnapshot } from '../../../../../shared/calendar/commands'
import { CalendarLinkTargetSchema, type CalendarEventLink } from '../../../../../shared/calendar/event-links'
import { parseReadyUri, toReadyUri, type ReadyRef } from '../../../../../shared/ready-ref'
import type { ObjectLink } from '../../../../../shared/object-links'
import type { PageNode } from '../../../../../shared/document-pages'
import { SaveToPicker, type SaveToSelection } from '../../../document/page-ui/SaveToPicker'
import { flattenPages } from '../../../document/page-ui/page-state'
import { openReadyRef } from '../../../workbench/open-ready-ref'
import { reload } from '../store'

const value = async <T,>(request:Promise<{success:boolean;data?:T;error?:string}>):Promise<T> => {
  const result = await request
  if (!result.success || result.data === undefined) throw new Error(result.error || '操作未完成')
  return result.data
}
const message = (error:unknown) => error instanceof Error ? error.message : String(error)
const kindLabel:Partial<Record<ReadyRef['kind'],string>> = {page:'页面',file:'文档',canvas:'画板',web:'网页','book-location':'书'}

export function EventLinks({occKey,title,readOnly}:{occKey:string;title:string;readOnly:boolean}) {
  const [snapshot,setSnapshot] = useState<CalendarSnapshot | null>(null)
  const [backlinks,setBacklinks] = useState<ObjectLink[]>([])
  const [trees,setTrees] = useState<PageNode[]>([])
  const [address,setAddress] = useState(''), [picker,setPicker] = useState(false)
  const [error,setError] = useState<string | null>(null), [busy,setBusy] = useState(false)
  const [undo,setUndo] = useState<CalendarMutationReceipt | null>(null)
  const [pendingNote,setPendingNote] = useState<SaveToSelection | null>(null)
  const lock = useRef(false), generation = useRef(0)
  const [eventId,original] = splitOccurrenceKey(occKey)
  const links = (snapshot?.links || []).filter(link=>link.eventId===eventId && String(link.originalStart)===String(original))
  const note = links.find(link=>link.purpose==='meeting-note')
  const nodes = flattenPages(trees)
  const label = (ref:ReadyRef) => ref.kind==='web' ? ref.url : ref.kind==='book-location' ? `书 ${ref.book}`
    : 'id' in ref ? nodes.find(node=>node.objectId===ref.id)?.title || `${kindLabel[ref.kind] || '对象'} ${ref.id}` : toReadyUri(ref)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    const api = window.electronAPI
    const [id,occurrence] = splitOccurrenceKey(occKey)
    const source:Extract<ReadyRef,{kind:'event'}> = {kind:'event',id,...(occurrence===undefined?{}:{occurrence})}
    const [next,incoming,vault] = await Promise.all([value(api.calendar.snapshot()), api.document.getObjectIncomingLinks({endpoint:{ref:source}}), api.vault.get()])
    if (!incoming.success) throw new Error(incoming.error)
    let pages:PageNode[] = []
    if (vault.status==='ready') {
      const result = await api.documentPages.tree({path:vault.root,kind:'vault'})
      if (!result.ok) throw new Error(result.message)
      pages = [result.value]
    }
    const pending = vault.status==='ready' ? await value(api.calendar.pendingMeetingNote(occKey)) : null
    if (request !== generation.current) return
    setSnapshot(next);setBacklinks(incoming.data);setTrees(pages);setPendingNote(pending)
  },[occKey])
  useEffect(()=>{
    let active = true
    const invalidate = () => {generation.current++}
    const load = () => { void refresh().catch(failure=>{if(active)setError(message(failure))}) }
    load()
    const off = window.electronAPI.calendar.onChanged(load)
    const offPages = window.electronAPI.documentPages.onChanged(load)
    return ()=>{active=false;invalidate();off();offPages()}
  },[refresh])
  const run = async (work:()=>Promise<void>) => {
    if (lock.current) return
    lock.current=true;setBusy(true);setError(null)
    try {await work()} catch(failure) {setError(message(failure))}
    finally {lock.current=false;setBusy(false)}
  }
  const expected = () => Object.fromEntries((snapshot?.events || []).map(event=>[event.id,event.revision || 1]))
  const accept = async (receipt:CalendarMutationReceipt) => {setUndo(receipt);setSnapshot(receipt.snapshot);await reload();await refresh()}
  const open = (ref:ReadyRef) => run(()=>openReadyRef(ref,'calendar'))
  const add = () => run(async()=>{
    const parsed = parseReadyUri(address)
    if (!parsed.ok) throw new Error('请粘贴有效的 Ready 引用地址')
    const target = CalendarLinkTargetSchema.parse(parsed.ref)
    await accept(await value(window.electronAPI.calendar.mutate({type:'link',key:occKey,target},expected())))
    setAddress('')
  })
  const remove = (link:CalendarEventLink) => run(async()=>{
    await accept(await value(window.electronAPI.calendar.mutate({type:'unlink',key:occKey,linkId:link.id},expected())))
  })
  const createNote = async (destination:SaveToSelection) => {
    try {
      const result = await value(window.electronAPI.calendar.createMeetingNote({key:occKey,expected:expected(),destination}))
      await accept(result.mutation)
      setPicker(false)
      // Saving succeeded even if the common navigation entry rejects an unsupported destination.
      try { await openReadyRef(result.ref,'calendar') } catch (failure) { setError(`笔记已保存；${message(failure)}`) }
      return {ok:true as const,value:result.ref}
    } catch (failure) {
      setError(message(failure))
      // Reload the durable intent even when the file was published but linking did not finish.
      await refresh().catch(refreshError=>setError(message(refreshError)))
      return {ok:false as const,code:'meeting_note_failed',message:message(failure)}
    }
  }
  return <section className="ev-sec" aria-label="日程关联" onKeyDown={event=>event.stopPropagation()}>
    <strong>关联资料</strong>
    {links.map(link=><div key={link.id}><button disabled={busy} onClick={()=>void open(link.target)}>{label(link.target)}</button>
      {!readOnly && <button aria-label={`解除关联 ${label(link.target)}`} disabled={busy} onClick={()=>void remove(link)}>解除</button>}</div>)}
    {!links.length && <p>暂无关联</p>}
    {!readOnly && <><select aria-label="选择关联资料" value="" disabled={busy} onChange={event=>setAddress(event.target.value)}>
      <option value="">选择页面、文档或画板</option>{nodes.filter(node=>['page','file','canvas'].includes(node.kind)).map(node=>
        <option key={node.objectId} value={toReadyUri({kind:node.kind==='page'?'page':node.kind==='canvas'?'canvas':'file',id:node.objectId})}>{node.title}</option>)}</select>
      <input aria-label="关联地址" placeholder="粘贴 Ready 引用地址" value={address} disabled={busy} onChange={event=>setAddress(event.target.value)}/>
      <button disabled={busy || !snapshot || !address} onClick={()=>void add()}>添加关联</button></>}
    <div><button disabled={busy || !snapshot || (readOnly && !note)} onClick={()=>note ? void open(note.target) : setPicker(true)}>{note?'打开会议笔记':'会议笔记'}</button></div>
    {pendingNote && !readOnly && <button disabled={busy} onClick={()=>void run(async()=>{const result=await createNote(pendingNote);if(!result.ok)throw new Error(result.message)})}>继续保存会议笔记</button>}
    {picker && !pendingNote && !readOnly && <SaveToPicker trees={trees} initialTitle={`${title || '日程'} 会议笔记`} onConfirm={createNote} onCancel={()=>setPicker(false)}/>}
    {undo && !readOnly && <button disabled={busy} onClick={()=>void run(async()=>{
      const restored = await value(window.electronAPI.calendar.restore(undo.undo,undo.versions))
      setUndo(null);setSnapshot(restored.snapshot);await reload();await refresh()
    })}>撤销上次关联修改</button>}
    <strong>反链</strong>
    {backlinks.map(link=><div key={link.id}><button disabled={busy} onClick={()=>void open('ref' in link.source ? link.source.ref : {kind:'file',id:link.source.objectId})}>
      {label('ref' in link.source ? link.source.ref : {kind:'file',id:link.source.objectId})}</button></div>)}
    {!backlinks.length && <p>暂无反链</p>}
    {backlinks.length===1000 && <p>仅显示前 1000 条反链</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
