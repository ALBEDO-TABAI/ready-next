import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Folder, FolderOpen, Search, X } from 'lucide-react'
import { useAgent } from '../../stores/useAgent'
import { useWorkspace } from '../../stores/useWorkspace'
import { parseWorkspaceDragPayloads } from '../layout/fileTreeDragPayload'
import { getChatMenuHorizontalFrame, subscribeChatMenuLayout } from './chatMenuLayout'
import { FloatPanel } from '../ui/float/FloatPanel'
import { chatMenuItemStyle, chatMenuSurfaceStyle } from './chatMenuStyles'

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path

export function ProjectSelector() {
  const scope = useAgent((state) => state.currentScope)
  const scopes = useAgent((state) => state.scopes)
  const workspaceRoot = useWorkspace((state) => state.workspaceRoot)
  const pinnedFolders = useWorkspace((state) => state.pinnedFolders)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [frame, setFrame] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const path = typeof scope?.meta.projectDirectory === 'string' ? scope.meta.projectDirectory : null
  const paths = [...new Set([
    path, workspaceRoot, ...pinnedFolders,
    ...scopes.filter((item) => item.sourceKind === 'local').map((item) => item.meta.projectDirectory),
  ].filter((value): value is string => typeof value === 'string' && Boolean(value)))]
    .filter((value) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))

  useEffect(() => {
    setOpen(false); setError(''); setSearch(''); setDragOver(false)
  }, [scope?.id])

  useEffect(() => {
    if (!open || !anchor.current) return
    const update = () => {
      if (!anchor.current) return
      const rect = anchor.current.getBoundingClientRect()
      setFrame({
        ...getChatMenuHorizontalFrame(anchor.current, 300, rect.left),
        bottom: window.innerHeight - rect.top + 6,
        maxHeight: Math.max(80, rect.top - 18),
      })
    }
    update()
    const unsubscribe = subscribeChatMenuLayout(anchor.current, update)
    const outside = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); anchor.current?.querySelector<HTMLButtonElement>('[data-project-trigger]')?.focus() }
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => { unsubscribe(); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  if (!scope || scope.sourceKind !== 'local') return null
  const identity = { id: scope.id, epoch: scope.messageVisibilityEpoch }
  const stillCurrent = () => {
    const current = useAgent.getState().currentScope
    return current?.id === identity.id && current.messageVisibilityEpoch === identity.epoch
  }
  const save = async (selectedPath: string | null) => {
    if (!stillCurrent()) return
    const result = await window.electronAPI.agent.setProjectDirectory(identity.id, selectedPath, identity.epoch)
    if (!result.success || !result.data) throw new Error(result.error || '项目选择未保存，请重试')
    const updated = result.data
    if (updated.id !== identity.id || updated.messageVisibilityEpoch !== identity.epoch) throw new Error('聊天已发生变化，请重试')
    useAgent.setState((state) => {
      if (state.retiredScopeIds[identity.id]) return state
      return {
        scopes: state.scopes.map((item) => item.id === identity.id && item.messageVisibilityEpoch === identity.epoch
          ? { ...item, meta: { ...item.meta, projectDirectory: updated.meta.projectDirectory } } : item),
        ...(state.currentScope?.id === identity.id && state.currentScope.messageVisibilityEpoch === identity.epoch
          ? { currentScope: { ...state.currentScope, meta: { ...state.currentScope.meta, projectDirectory: updated.meta.projectDirectory } } } : {}),
      }
    })
    if (stillCurrent()) { setOpen(false); setSearch('') }
  }
  const perform = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (reason) {
      if (stillCurrent()) setError(reason instanceof Error ? reason.message : '无法选择项目文件夹')
    } finally { setBusy(false) }
  }
  const drop = (event: React.DragEvent) => {
    event.preventDefault(); event.stopPropagation(); setDragOver(false)
    const internal = parseWorkspaceDragPayloads(event.dataTransfer)
    const files = Array.from(event.dataTransfer.files)
    void perform(async () => {
      if (internal.length) {
        if (internal.length !== 1 || !internal[0].isDirectory) throw new Error('请拖入一个文件夹')
        await save(internal[0].path)
      } else {
        if (files.length !== 1) throw new Error('请拖入一个文件夹')
        await save(window.electronAPI.getFilePathFromDrop(files[0]))
      }
    })
  }
  return <div ref={anchor} className={`ready-chat-project${dragOver ? ' is-drag-over' : ''}`}
    data-chat-project-selector="true" aria-busy={busy}
    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDragOver(true) }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false) }}
    onDrop={drop}>
    <div className="ready-chat-project-pill">
      {/* The pill floats over the message list on the float material; liquid glass is the composer's alone (W1 DL4a). */}
      <span className="ready-chat-project-surface rn-float" aria-hidden="true"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: 'inherit', boxShadow: 'inset 0 0 0 1px var(--rn-hair)' }} />
      {path && <button className="ready-chat-project-clear" aria-label="取消项目选择" title="不在项目中工作"
        disabled={busy} onClick={() => void perform(() => save(null))}><Folder className="project-folder-icon" size={16} /><X className="project-clear-icon" size={16} /></button>}
      <button data-project-trigger="true" className="ready-chat-project-trigger" disabled={busy}
        title={path || '选择默认项目文件夹，也可以拖入文件夹'} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => { setOpen(!open); setError('') }}>
        {!path && <Folder size={16} />}<span>{path ? folderName(path) : '选择项目'}</span>
      </button>
    </div>
    {error && <div role="alert" className="ready-chat-project-error">{error}</div>}
    {open && frame && createPortal(<FloatPanel ref={menu} role="dialog" aria-label="选择项目" style={{
      ...chatMenuSurfaceStyle, position: 'fixed', zIndex: 540, ...frame,
    }} contentStyle={{ padding: 8, maxHeight: frame.maxHeight, overflowY: 'auto', overflowX: 'hidden' }}>
      <label className="ready-chat-project-search"><Search size={15} /><input autoFocus aria-label="搜索项目"
        placeholder="搜索项目" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      {paths.map((candidate) => <button key={candidate} disabled={busy} title={candidate}
        className="ready-floating-menu-item" style={{ ...chatMenuItemStyle, display: 'flex', alignItems: 'center', width: '100%', gap: 8, textAlign: 'left' }} onClick={() => void perform(() => save(candidate))}>
        <Folder size={16} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1, textAlign: 'left' }}>{folderName(candidate)}</span>
        {path === candidate && <Check size={16} style={{ flexShrink: 0 }} />}
      </button>)}
      {paths.length === 0 && <div style={{ padding: 10, color: 'var(--text-gray)', fontSize: 12 }}>没有匹配的项目文件夹</div>}
      <div style={{ borderTop: '1px solid var(--border-default)', marginTop: 6, paddingTop: 6 }}>
        <button disabled={busy} className="ready-floating-menu-item" style={{ ...chatMenuItemStyle, display: 'flex', alignItems: 'center', width: '100%', gap: 8, textAlign: 'left' }} onClick={() => void perform(async () => {
          const result = await window.electronAPI.document.openFolder({ title: '选择项目文件夹' })
          if (result.success && result.path) await save(result.path)
          else if (result.error && result.error !== 'cancelled') throw new Error(result.error)
        })}><FolderOpen size={16} />选择其他文件夹…</button>
        {path && <button disabled={busy} className="ready-floating-menu-item" style={{ ...chatMenuItemStyle, display: 'flex', alignItems: 'center', width: '100%', gap: 8, textAlign: 'left' }} onClick={() => void perform(() => save(null))}><X size={16} />不在项目中工作</button>}
      </div>
    </FloatPanel>, document.body)}
  </div>
}
