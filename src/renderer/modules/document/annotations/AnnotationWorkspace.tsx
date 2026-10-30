import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AnnotationCommand, AnnotationSnapshot } from '../../../../shared/document-comments'
import { createBlockCommand, type DocumentBlock, type DocumentBuffer } from '../../../../shared/document-blocks'
import { explicitBlockId, markBlock, parseSyncedBlock, relocateAnchor } from '../../../../shared/document-anchors'
import type { EditorBuffer } from '../block-editor/editor-buffer'
import { AnnotationMenuContext, type AnnotationMenus } from './menus'
import { useDocTabs } from '../../../stores/useDocTabs'
import { TemplatePicker } from '../templates/TemplatePicker'

type Selected = { block: DocumentBlock; snapshot: DocumentBuffer }
export function AnnotationWorkspace({ buffer, children }: { buffer: EditorBuffer; children: ReactNode }) {
  const content = useSyncExternalStore(buffer.subscribe, () => buffer.snapshot.content)
  const tabId = buffer.owner.kind === 'document' ? buffer.owner.tabId : undefined
  const path = useDocTabs(state => state.tabs.find(tab => tab.id === tabId)?.path)
  const title = useDocTabs(state => state.tabs.find(tab => tab.id === tabId)?.title ?? '')
  const [snapshot, setSnapshot] = useState<AnnotationSnapshot | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ threadId: string; messageId: string } | null>(null)
  const [visible, setVisible] = useState(false)
  const [template, setTemplate] = useState<{ insert: ((markdown: string) => void) | null } | null>(null)
  const [sync, setSync] = useState<{ insert: (markdown: string) => void } | null>(null), [reference, setReference] = useState('')
  const generation = useRef(0), root = useRef<HTMLDivElement>(null)
  const report = (cause: unknown) => setError(String(cause))
  useEffect(() => {
    let live = true
    const token = ++generation.current; setSnapshot(null); setSelected(null); setVisible(false); setError(''); setTemplate(null); setSync(null); setBusy(false); setEditing(null); setReference('')
    if (!path || !window.electronAPI?.documentAnnotations) return
    const read = () => window.electronAPI.documentAnnotations.comments({ type: 'read', path }).then(result => {
      if (!live || generation.current !== token) return
      if (!result.ok) throw new Error(result.message)
      setSnapshot(result.value)
    }).catch(cause => { if (live && generation.current === token) report(cause) })
    void read()
    const unsubscribe = window.electronAPI.documentPages?.onChanged?.(() => { void read() })
    return () => { live = false; unsubscribe?.() }
  }, [path])
  async function mutate(command: AnnotationCommand) {
    if (busy) return false
    const token = generation.current; setBusy(true); setError('')
    try {
      const result = await window.electronAPI.documentAnnotations.comments(command)
      if (!result.ok) throw new Error(result.message)
      if (token === generation.current) { setSnapshot(result.value); if (command.type !== 'read') { setSelected(null); setText('') } return true }
      return false
    } catch (cause) { if (token === generation.current) report(cause); return false } finally { if (token === generation.current) setBusy(false) }
  }
  async function add() {
    if (!path || !selected || !snapshot) return
    const token = generation.current
    try {
      buffer.flush()
      if (buffer.snapshot.content !== selected.snapshot.content) throw new Error('所选块已变化，请重新选择')
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selected.snapshot.content))
      const expectedVersion = [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('')
      if (token !== generation.current) return
      await mutate({ type: 'add', path, expectedRevision: snapshot.revision, expectedVersion, start: selected.block.start, end: selected.block.end, text })
    } catch (cause) { report(cause) }
  }
  const extensions: AnnotationMenus = {
    blockItems: (block, source) => !tabId ? [] : [
      { id: 'comment', label: '添加评论', run: () => {
        if (!path) { setError('请先保存页面，再添加评论'); return }
        setSelected({ block, snapshot: source }); setText(''); setVisible(true)
      } },
      { id: 'sync-source', label: '转为同步块引用', run: () => {
        try {
          if (!path) throw new Error('请先保存页面')
          if (/[[\]|#\r\n]/.test(path)) throw new Error('页面路径不能表示为块引用')
          const id = explicitBlockId(source.content, block) ?? 'block-' + crypto.randomUUID()
          const marked = markBlock(source.content, block, id)
          if (marked !== block.raw) buffer.apply(createBlockCommand(source, { type: 'replace', mode: 'source', block, markdown: marked }))
          setReference(`![[${path.replace(/\.md$/i, '')}#^${id}]]`)
          setVisible(true)
        } catch (cause) { report(cause) }
      } },
    ],
    slashItems: insert => !tabId ? [] : [
      { id: 'template', label: '插入模板', run: () => setTemplate({ insert }) },
      { id: 'synced', label: '插入同步块', run: () => { setReference(''); setSync({ insert }) } },
    ],
  }
  return <AnnotationMenuContext.Provider value={extensions}><div ref={root} style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
    <div style={{ minWidth: 0, flex: 1 }}>{children}
      {tabId && <div><button type="button" onClick={() => setVisible(!visible)}>评论</button><button type="button" onClick={() => setTemplate({ insert: null })}>从模板新建页面</button></div>}
      {error && <p role="alert">{error}</p>}
    </div>
    {visible && <aside aria-label="评论面板" style={{ width: 260, flexShrink: 0 }}>
      <button type="button" disabled={busy} onClick={() => { if (path) void mutate({ type: 'read', path }) }}>刷新评论</button>
      {selected && <form onSubmit={event => { event.preventDefault(); void add() }}><label>评论内容<textarea aria-label="评论内容" value={text} onChange={event => setText(event.target.value)} /></label><button disabled={busy || !snapshot || !text.trim()}>发表评论</button></form>}
      {reference && !sync && <div><p>源块已保留，请保存后在其他位置插入：</p><code>{reference}</code></div>}
      {snapshot?.threads.map(stored => { const thread = { ...stored, location: relocateAnchor(content, stored.anchor) }; return <article key={thread.id}>
        <button type="button" disabled={thread.location.state === 'lost'} onClick={() => {
          if (thread.location.state !== 'located') return
          const element = root.current?.querySelector<HTMLElement>(`[data-block-start="${thread.location.start}"]`)
          element?.scrollIntoView({ block: 'center' }); (element?.querySelector<HTMLElement>('[contenteditable]') ?? element?.querySelector<HTMLElement>('button'))?.focus()
        }}>{thread.location.state === 'lost' ? '原位置已变化' : '定位到块'}</button>
        <blockquote>{thread.quote}</blockquote>
        {thread.messages.map(message => <p key={message.id}>{message.text}<button type="button" disabled={busy} onClick={() => {
          setText(message.text)
          setEditing({ threadId: thread.id, messageId: message.id })
        }}>编辑</button></p>)}
        <button type="button" disabled={busy} onClick={() => { if (path) void mutate({ type: 'resolve', path, expectedRevision: snapshot.revision, threadId: thread.id, resolved: !thread.resolved }) }}>{thread.resolved ? '重新打开' : '解决'}</button>
        <button type="button" disabled={busy} onClick={() => { if (path) void mutate({ type: 'delete', path, expectedRevision: snapshot.revision, threadId: thread.id }) }}>删除评论</button>
      </article> })}
      {editing && <form onSubmit={event => { event.preventDefault(); if (path && snapshot) void mutate({ type: 'edit', path, expectedRevision: snapshot.revision, ...editing, text }).then(saved => { if (saved) setEditing(null) }) }}>
        <textarea aria-label="修改评论" value={text} onChange={event => setText(event.target.value)} /><button disabled={busy}>保存评论</button>
      </form>}
    </aside>}
    {template && <TemplatePicker path={path ?? null} title={title} insert={template.insert} close={() => setTemplate(null)} />}
    {sync && <form role="dialog" aria-label="插入同步块" onSubmit={event => {
      event.preventDefault()
      try { if (!parseSyncedBlock(reference)) throw new Error('请输入 ![[页面#^块编号]]'); sync.insert(reference); setSync(null) } catch (cause) { report(cause) }
    }}><input aria-label="同步块引用" value={reference} onChange={event => setReference(event.target.value)} /><button>插入</button><button type="button" onClick={() => setSync(null)}>取消</button></form>}
  </div></AnnotationMenuContext.Provider>
}
