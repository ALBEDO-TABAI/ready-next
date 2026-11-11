import { useCallback, useEffect, useRef, useState } from 'react'
import { splitOccurrenceKey, type CalendarMutationReceipt, type CalendarSnapshot } from '../../../../../shared/calendar/commands'
import { CalendarLinkTargetSchema, type CalendarEventLink } from '../../../../../shared/calendar/event-links'
import { toReadyUri, type ReadyRef } from '../../../../../shared/ready-ref'
import type { ObjectLink } from '../../../../../shared/object-links'
import type { PageNode } from '../../../../../shared/document-pages'
import { SaveToPicker, type SaveToSelection } from '../../../document/page-ui/SaveToPicker'
import { flattenPages } from '../../../document/page-ui/page-state'
import { openReadyRef } from '../../../workbench/open-ready-ref'
import { reload } from '../store'
import { Link2, NotebookPen, Plus, X } from 'lucide-react'
import { openLinkPicker } from './LinkPicker'

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
  const [picker,setPicker] = useState(false)
  const [error,setError] = useState<string | null>(null), [busy,setBusy] = useState(false)
  const [undo,setUndo] = useState<CalendarMutationReceipt | null>(null)
  const [pendingNote,setPendingNote] = useState<SaveToSelection | null>(null)
  const lock = useRef(false), generation = useRef(0)
  const [eventId,original] = splitOccurrenceKey(occKey)
  const links = (snapshot?.links || []).filter(link=>link.eventId===eventId && String(link.originalStart)===String(original))
  const note = links.find(link=>link.purpose==='meeting-note')
  const related = links.filter(link=>link.purpose!=='meeting-note')
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
  const add = (ref:ReadyRef) => run(async()=>{
    const target = CalendarLinkTargetSchema.parse(ref)
    await accept(await value(window.electronAPI.calendar.mutate({type:'link',key:occKey,target},expected())))
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
  // One 关联 row like the panel's other rows (W4 §4, O9): references as chips, "+" opens the same search as @.
  return <section className="ev-sec ev-links" aria-label="日程关联" onKeyDown={event=>event.stopPropagation()}>
    <div className="ev-r"><div className="ev-f ev-link-row">
      <Link2 size={18} />
      <div className="ev-chips">
        {related.map(link=><span key={link.id} className="ev-chip">
          <button type="button" disabled={busy} onClick={()=>void open(link.target)}>{label(link.target)}</button>
          {!readOnly && <button type="button" className="ev-chip-x" aria-label={`解除关联 ${label(link.target)}`} disabled={busy} onClick={()=>void remove(link)}><X size={12} /></button>}
        </span>)}
        {!related.length && <span className="dim">关联</span>}
      </div>
      {!readOnly && <button type="button" className="ibtn sm" aria-label="添加关联" title="添加关联" disabled={busy || !snapshot}
        onClick={event=>openLinkPicker(event.currentTarget.getBoundingClientRect(),ref=>void add(ref))}><Plus size={16} /></button>}
    </div></div>
    <div className="ev-r"><button type="button" className="ev-f" aria-label={note?'打开会议笔记':'会议笔记'} disabled={busy || !snapshot || (readOnly && !note)}
      onClick={()=>note ? void open(note.target) : setPicker(true)}><NotebookPen size={18} /><span className={note?'':'dim'}>{note ? label(note.target) : '会议笔记'}</span></button></div>
    {pendingNote && !readOnly && <div className="ev-r ind"><button type="button" className="btn sm" disabled={busy} onClick={()=>void run(async()=>{const result=await createNote(pendingNote);if(!result.ok)throw new Error(result.message)})}>继续保存会议笔记</button></div>}
    {picker && !pendingNote && !readOnly && <SaveToPicker trees={trees} initialTitle={`${title || '日程'} 会议笔记`} onConfirm={createNote} onCancel={()=>setPicker(false)}/>}
    {undo && !readOnly && <div className="ev-r ind"><button type="button" className="btn sm" disabled={busy} onClick={()=>void run(async()=>{
      const restored = await value(window.electronAPI.calendar.restore(undo.undo,undo.versions))
      setUndo(null);setSnapshot(restored.snapshot);await reload();await refresh()
    })}>撤销上次关联修改</button></div>}
    <details className="ev-backlinks"><summary>反链 {backlinks.length}{backlinks.length===1000?'+':''}</summary>
      {backlinks.map(link=><button type="button" key={link.id} disabled={busy} onClick={()=>void open('ref' in link.source ? link.source.ref : {kind:'file',id:link.source.objectId})}>
        {label('ref' in link.source ? link.source.ref : {kind:'file',id:link.source.objectId})}</button>)}
      {!backlinks.length && <p className="dim">还没有页面链接到这个日程</p>}
    </details>
    {error && <p role="alert" className="ev-links-error">{error}</p>}
  </section>
}
