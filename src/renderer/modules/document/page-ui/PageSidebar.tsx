import { ImportWizard } from '../import/ImportWizard'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { DocumentPagesAPI, PageNode, PageOperation, PageResult, PageRoot, PageTrashEntry } from '../../../../shared/document-pages'
import { createPageTreeStore, errorMessage, flattenPages, parentDirectory } from './page-state'
import { PageIcon } from './PageIcon'
import { SaveToPicker, type SaveToSelection } from './SaveToPicker'

type Dialog = { kind: 'create' | 'rename' | 'move'; node: PageNode; root: string } | { kind: 'restore' | 'delete'; item: PageTrashEntry; root: string }
export interface PageSidebarProps {
  roots: PageRoot[]
  api?: DocumentPagesAPI
  onOpen(node: PageNode): void | Promise<void>
  onShowFiles(node: PageNode): void | Promise<void>
  beforeTrash(node: PageNode): Promise<void>
}

export function PageSidebar({ roots, api = window.electronAPI.documentPages, onOpen, onShowFiles, beforeTrash }: PageSidebarProps) {
  const store = useMemo(() => createPageTreeStore(api), [api])
  const { trees, states, loading, error: loadError } = useStore(store)
  const rootsKey = JSON.stringify(roots)
  const rootsRef = useRef(roots); rootsRef.current = roots
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [trash, setTrash] = useState<{ root: string; item: PageTrashEntry }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const lock = useRef(false)
  const dragged = useRef<{ node: PageNode; parent: PageNode; root: string } | null>(null)
  const refresh = () => store.getState().load(rootsRef.current)
  useEffect(() => {
    setDialog(null); setTrash(null)
    void store.getState().load(rootsRef.current)
    let timer: ReturnType<typeof setTimeout> | undefined
    let treeChanged = false
    const unsubscribe = api.onChanged(event => {
      treeChanged ||= !('operationId' in event) || !['visit', 'favorite'].includes(event.operationId)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (treeChanged) { treeChanged = false; void store.getState().load(rootsRef.current) }
        else void store.getState().loadStates().catch(failure => setError(errorMessage(failure)))
      }, 80)
    })
    return () => { unsubscribe(); clearTimeout(timer); store.getState().invalidate() }
  }, [api, store, rootsKey])

  const run = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { await action() } catch (failure) { setError(errorMessage(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const checked = <T,>(result: PageResult<T>): T => { if (!result.ok) throw new Error(result.message); return result.value }
  const loadTrash = async () => {
    const entries = await Promise.all(rootsRef.current.map(async root => checked(await api.trash(root.path)).map(item => ({ root: root.path, item }))))
    setTrash(entries.flat())
  }
  const operate = async (input: PageOperation) => {
    const result = await api.operate(input)
    if (result.ok) { await refresh(); if (trash) await loadTrash() }
    return result
  }
  const open = (node: PageNode) => run(async () => { await onOpen(node); checked(await api.visit(node.objectId)); await store.getState().loadStates() })
  const favorite = (node: PageNode) => states.some(state => state.objectId === node.objectId && state.favorite)
  const restore = (item: PageTrashEntry, root: string) => run(async () => {
    const result = await operate({ type: 'restore', objectId: item.objectId, root, operationId: crypto.randomUUID() })
    if (!result.ok && (result.code === 'name_collision' || /parent_conflict/.test(result.message))) {
      setDialog({ kind: 'restore', item, root }); setError('原位置不可用，请另选恢复位置。'); return
    }
    checked(result)
  })
  const drop = (target: PageNode, parent: PageNode, root: string, before: boolean) => run(async () => {
    const source = dragged.current; dragged.current = null
    if (!source || source.node.objectId === target.objectId) return
    if (source.root !== root) throw new Error('页面只能在同一个根目录内移动。')
    if (before) {
      if (source.parent.objectId !== parent.objectId) throw new Error('排序只支持同级页面；移入另一页请拖到页面标题上。')
      const ids = parent.children.filter(node => node.objectId !== source.node.objectId).map(node => node.objectId)
      ids.splice(ids.indexOf(target.objectId), 0, source.node.objectId)
      checked(await api.order(parent.objectId, ids)); await refresh()
    } else {
      if (!['page', 'folder', 'vault'].includes(target.kind) || target.ambiguity) throw new Error('此项目不能接收子页面。')
      if (flattenPages([source.node]).some(node => node.objectId === target.objectId)) throw new Error('不能移入自己的子页面。')
      checked(await operate({ type: 'move', root, operationId: crypto.randomUUID(), objectId: source.node.objectId, parentObjectId: target.objectId }))
    }
  })
  const renderNodes = (parent: PageNode, root: string) => <ul role="group" className="pl-3">
    {parent.children.map(node => <li key={node.objectId} role="treeitem" aria-expanded={node.hasChildren ? expanded.has(node.objectId) : undefined} data-page-id={node.objectId}>
      <div aria-label={`排在 ${node.title} 之前`} className="h-1" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); void drop(node, parent, root, true) }} />
      <div className="group flex items-center gap-1 rounded py-1 hover:bg-[var(--files-panel-state-hover-bg)]" draggable={!busy && node.kind === 'page' && !node.ambiguity}
        onDragStart={event => { event.stopPropagation(); dragged.current = { node, parent, root }; event.dataTransfer.setData('text/plain', node.objectId) }}
        onDragEnd={() => { dragged.current = null }} onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); void drop(node, parent, root, false) }}>
        {node.hasChildren && <button aria-label={`展开 ${node.title}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(node.objectId)) next.delete(node.objectId); else next.add(node.objectId); return next })}>{expanded.has(node.objectId) ? '▾' : '▸'}</button>}
        <PageIcon value={node.icon} folder={node.kind === 'folder'} />
        <button className="min-w-0 flex-1 truncate text-left" title={node.path} onClick={() => {
          if (node.kind === 'folder' || node.kind === 'vault') setExpanded(previous => new Set(previous).add(node.objectId))
          else void open(node)
        }}>{node.title}</button>
        {node.kind === 'page' && <details className="relative" aria-label={`${node.title} 操作`}><summary aria-label={`${node.title} 操作`} className="cursor-pointer px-1">⋯</summary>
          <div className="flex flex-col items-start text-xs gap-2 p-2">
            <button disabled={!!node.ambiguity} onClick={() => setDialog({ kind: 'create', node, root })}>新建子页面</button>
            <button disabled={!!node.ambiguity} onClick={() => setDialog({ kind: 'rename', node, root })}>改名</button>
            <button disabled={!!node.ambiguity} onClick={() => setDialog({ kind: 'move', node, root })}>移动到…</button>
            <button disabled={!!node.ambiguity} onClick={() => void run(async () => { await beforeTrash(node); checked(await operate({ type: 'trash', objectId: node.objectId, root, operationId: crypto.randomUUID() })) })}>移到回收站</button>
            <button onClick={() => void run(async () => { checked(await api.favorite(node.objectId, !favorite(node))); await store.getState().loadStates() })}>{favorite(node) ? '取消收藏' : '收藏'}</button>
          </div>
        </details>}
      </div>
      {node.ambiguity && <div role="note" className="text-xs pl-4">{node.ambiguity} <button onClick={() => void run(async () => { await onShowFiles(node) })}>在文件视角中查看</button></div>}
      {expanded.has(node.objectId) && renderNodes(node, root)}
    </li>)}
  </ul>
  const all = flattenPages(trees)
  const shortcuts = (label: string, ids: string[]) => <section aria-label={label} className="mb-3"><h3 className="text-xs opacity-60">{label}</h3>{ids.map(id => all.find(node => node.objectId === id)).filter((node): node is PageNode => !!node).map(node => <button key={node.objectId} className="flex w-full gap-2 text-left py-1" onClick={() => void open(node)}><PageIcon value={node.icon} />{node.title}</button>)}</section>
  const confirmLocation = async (selection: SaveToSelection) => {
    if (!dialog || dialog.kind === 'rename' || dialog.kind === 'delete') throw new Error('位置选择已失效')
    const target = selection.parentObjectId ? { parentObjectId: selection.parentObjectId } : { parentPath: selection.parentPath }
    return operate(dialog.kind === 'create'
      ? { type: 'create', root: dialog.root, operationId: selection.operationId, title: selection.title, ...target }
      : { type: dialog.kind, root: dialog.root, operationId: selection.operationId, objectId: 'item' in dialog ? dialog.item.objectId : dialog.node.objectId, ...target })
  }
  return <div aria-label="页面侧栏" className="flex-1 min-h-0 overflow-auto px-3 py-2 text-[13px]" style={{ color: 'var(--text-primary)' }}>
    <details aria-label="页面更多"><summary>更多</summary><button onClick={() => setImportOpen(true)}>导入 Notion / Inkwell</button></details>
    {importOpen && <ImportWizard onClose={() => { setImportOpen(false); void refresh() }} />}
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {loading && <p role="status">正在读取页面…</p>}
    <fieldset disabled={busy || !!dialog}>
      {shortcuts('收藏', states.filter(state => state.favorite).map(state => state.objectId))}
      {shortcuts('最近', states.filter(state => state.lastVisitedAt !== null).sort((a, b) => b.lastVisitedAt! - a.lastVisitedAt!).slice(0, 10).map(state => state.objectId))}
      {trees.map(tree => <section key={tree.objectId} aria-label={tree.title}><div className="flex justify-between"><strong>{tree.title}</strong><button onClick={() => setDialog({ kind: 'create', node: tree, root: tree.path })}>新建页面</button></div><div role="tree" aria-label={`${tree.title} 页面树`}>{renderNodes(tree, tree.path)}</div></section>)}
      <button className="mt-3" onClick={() => void run(async () => { if (trash) setTrash(null); else await loadTrash() })}>回收站</button>
      {trash && <section aria-label="回收站内容">{trash.length === 0 && <p>回收站为空</p>}{trash.map(({ root, item }) => <div key={item.objectId} className="py-2"><span>{item.title}</span><button onClick={() => void restore(item, root)}>恢复</button><button onClick={() => setDialog({ kind: 'delete', item, root })}>永久删除</button></div>)}</section>}
    </fieldset>
    {dialog && ['create', 'move', 'restore'].includes(dialog.kind) && <SaveToPicker key={`${dialog.kind}:${dialog.kind === 'restore' ? dialog.item.objectId : 'node' in dialog ? dialog.node.objectId : ''}`}
      trees={trees.filter(tree => tree.path === dialog.root)} mode={dialog.kind === 'create' ? 'save' : dialog.kind === 'restore' ? 'restore' : 'move'}
      initialTitle={dialog.kind === 'create' ? '新页面' : dialog.kind === 'restore' ? dialog.item.originalPath.split(/[\\/]/).pop()!.replace(/\.md$/i, '') : 'node' in dialog ? dialog.node.name.replace(/\.md$/i, '') : ''}
      initialParentPath={dialog.kind === 'create' ? parentDirectory(dialog.node) : undefined}
      excludeObjectId={dialog.kind === 'move' ? dialog.node.objectId : undefined}
      onConfirm={confirmLocation} onCancel={() => setDialog(null)} />}
    {dialog?.kind === 'rename' && <RenamePage node={dialog.node} onCancel={() => setDialog(null)} onConfirm={async (title, operationId) => {
      const result = await operate({ type: 'rename', root: dialog.root, objectId: dialog.node.objectId, title, operationId })
      return result
    }} />}
    {dialog?.kind === 'delete' && <section role="dialog" aria-label="永久删除"><p>永久删除「{dialog.item.title}」及子页面？此操作无法恢复。</p><button disabled={busy} onClick={() => setDialog(null)}>取消</button><button disabled={busy} onClick={() => void run(async () => {
      checked(await operate({ type: 'delete', root: dialog.root, objectId: dialog.item.objectId, operationId: crypto.randomUUID() })); setDialog(null)
    })}>确认永久删除</button></section>}
  </div>
}

function RenamePage({ node, onConfirm, onCancel }: { node: PageNode; onConfirm(title: string, operationId: string): Promise<PageResult<unknown>>; onCancel(): void }) {
  const [title, setTitle] = useState(node.title)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const intent = useRef({ title, id: crypto.randomUUID() })
  const lock = useRef(false)
  return <form role="dialog" aria-label="改名" onSubmit={event => {
    event.preventDefault()
    if (lock.current) return
    lock.current = true; setBusy(true)
    if (intent.current.title !== title) intent.current = { title, id: crypto.randomUUID() }
    void onConfirm(title, intent.current.id).then(result => { if (result.ok) onCancel(); else setError(result.message) })
      .catch(failure => setError(errorMessage(failure))).finally(() => { lock.current = false; setBusy(false) })
  }}><label>页面名称<input aria-label="页面名称" value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<button disabled={busy} type="button" onClick={onCancel}>取消</button><button disabled={busy} type="submit">确认改名</button></form>
}
