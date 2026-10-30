import { useMemo, useRef, useState } from 'react'
import type { DraftFinalizeInput } from '../../../../shared/document-drafts'
import type { PageNode, PageResult } from '../../../../shared/document-pages'
import { readStorage, writeStorage } from '../../../utils/storage'
import { errorMessage, flattenPages, joinPagePath, parentDirectory } from './page-state'

export interface SaveToSelection extends DraftFinalizeInput { keepDocumentCard?: boolean }
export interface SaveToPickerProps {
  trees: PageNode[]
  initialTitle: string
  extension?: '.md' | '.canvas'
  initialParentPath?: string
  mode?: 'save' | 'move' | 'restore'
  excludeObjectId?: string
  sourceCanvas?: { title: string; path: string }
  onConfirm(selection: SaveToSelection): Promise<PageResult<unknown>>
  onCancel(): void
}
const LAST_LOCATION = 'ready-page-last-location'

export function SaveToPicker({ trees, initialTitle, initialParentPath, extension = '.md', mode = 'save', excludeObjectId, sourceCanvas, onConfirm, onCancel }: SaveToPickerProps) {
  const nodes = useMemo(() => {
    const walk = (items: PageNode[]): PageNode[] => items.flatMap(node => node.objectId === excludeObjectId ? [] : [node, ...walk(node.children)])
    return walk(trees).filter(node => ['page', 'folder', 'vault'].includes(node.kind) && !node.ambiguity)
  }, [trees, excludeObjectId])
  const [title, setTitle] = useState(initialTitle)
  const [query, setQuery] = useState('')
  const [parent, setParent] = useState(() => {
    const canvasDirectory = sourceCanvas?.path.replace(/\.canvas$/i, '')
    const remembered = readStorage(LAST_LOCATION)
    return canvasDirectory || initialParentPath || (nodes.some(node => parentDirectory(node) === remembered) ? remembered : null) || nodes[0]?.path || ''
  })
  const [keepCard, setKeepCard] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const submitting = useRef(false)
  const intent = useRef<{ key: string; operationId: string } | null>(null)
  const selected = nodes.find(node => parentDirectory(node) === parent)
  const filename = `${title || '未命名'}${extension}`
  const preview = parent ? joinPagePath(parent, filename) : ''
  const duplicate = flattenPages(trees).some(node => node.objectId !== excludeObjectId && node.path.toLocaleLowerCase() === preview.toLocaleLowerCase())
  const crumbs = nodes.filter(node => parent === parentDirectory(node) || parent.startsWith(`${parentDirectory(node)}/`) || parent.startsWith(`${parentDirectory(node)}\\`))
  const label = mode === 'move' ? '移动到…' : mode === 'restore' ? '恢复到…' : '保存到…'

  const confirm = async () => {
    if (submitting.current || !parent) return
    submitting.current = true; setBusy(true); setError(null)
    const key = JSON.stringify([parent, title, keepCard])
    if (intent.current?.key !== key) intent.current = { key, operationId: crypto.randomUUID() }
    try {
      const result = await onConfirm({ title, operationId: intent.current.operationId,
        ...(selected ? { parentObjectId: selected.objectId } : { parentPath: parent }),
        ...(sourceCanvas ? { keepDocumentCard: keepCard } : {}),
      })
      if (!result.ok) { setError(result.message); setCandidates(result.candidateNames || []); return }
      writeStorage(LAST_LOCATION, parent)
      onCancel()
    } catch (failure) { setError(errorMessage(failure)) }
    finally { submitting.current = false; setBusy(false) }
  }
  const chooseOther = async () => {
    setError(null)
    try {
      const result = await window.electronAPI.document.openFolder({ validateAsWorkspace: true })
      if (result.success && result.path) { setParent(result.path); setCandidates([]) }
      else if (result.error !== 'cancelled') setError(result.error || '未返回位置')
    } catch (failure) { setError(errorMessage(failure)) }
  }
  return <section role="dialog" aria-modal="false" aria-label={label} className="p-3 space-y-3 border rounded" style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)', background: 'var(--bg-primary)' }}>
    <strong>{label}</strong>
    <label className="block">标题<input className="ready-input-slot w-full" aria-label="标题" value={title} disabled={busy || mode !== 'save'} onChange={event => { setTitle(event.target.value); setCandidates([]); setError(null) }} /></label>
    <input className="ready-input-slot w-full" aria-label="搜索位置" placeholder="搜索页面或文件夹" value={query} onChange={event => setQuery(event.target.value)} />
    <nav aria-label="当前位置" className="text-xs break-all">{crumbs.map(node => <button key={node.objectId} disabled={busy} onClick={() => setParent(parentDirectory(node))}>{node.title} / </button>)}{!selected && <span>{parent}</span>}</nav>
    <div role="tree" aria-label="保存位置" className="max-h-60 overflow-auto">
      {nodes.filter(node => !query || `${node.title} ${node.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(node => {
        const depth = nodes.filter(ancestor => node.path.startsWith(`${parentDirectory(ancestor)}/`) || node.path.startsWith(`${parentDirectory(ancestor)}\\`)).length
        return <button key={node.objectId} type="button" role="treeitem" aria-selected={parent === parentDirectory(node)} disabled={busy}
          className="block w-full text-left rounded py-1 hover:bg-[var(--files-panel-state-hover-bg)]" style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => { setParent(parentDirectory(node)); setCandidates([]); setError(null) }}>{node.title}</button>
      })}
    </div>
    <p aria-label="最终路径" className="text-xs break-all">预计路径：{preview || '请选择位置'}（文件名由保存服务确认）</p>
    {duplicate && <p role="status">此位置已有同名文件，提交后可查看候选名称。</p>}
    {error && <p role="alert">{error}</p>}
    {candidates.length > 0 && <div>重名候选：{candidates.map(name => <button key={name} disabled={mode !== 'save'} onClick={() => { setTitle(name); setCandidates([]); setError(null) }}>{name}</button>)}{mode !== 'save' && <p>移动或恢复不改名，请另选位置。</p>}</div>}
    {sourceCanvas && <label className="block">来源画板：{sourceCanvas.title} <input type="checkbox" checked={keepCard} disabled={busy} onChange={event => setKeepCard(event.target.checked)} />保留文档卡</label>}
    <div className="flex gap-3"><button disabled={busy} onClick={() => void chooseOther()}>其他位置…</button><button disabled={busy} onClick={onCancel}>取消</button><button disabled={busy || !parent} onClick={() => void confirm()}>{busy ? '正在处理…' : '确认'}</button></div>
  </section>
}
