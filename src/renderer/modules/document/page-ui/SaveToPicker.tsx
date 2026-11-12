import { useMemo, useRef, useState } from 'react'
import type { DraftFinalizeInput } from '../../../../shared/document-drafts'
import type { PageNode, PageResult } from '../../../../shared/document-pages'
import { readStorage, writeStorage } from '../../../utils/storage'
import { errorMessage, flattenPages, joinPagePath, parentDirectory } from './page-state'
import { Button, Checkbox, Input } from '../../../components/ui'

export interface SaveToSelection extends DraftFinalizeInput { keepDocumentCard?: boolean }
export interface SaveToPickerProps {
  trees: PageNode[]
  initialTitle: string
  extension?: '.md' | '.canvas'
  initialParentPath?: string
  /** adopt: bring a mounted folder's file or folder into the library (W3 M4); only library locations. */
  mode?: 'save' | 'move' | 'restore' | 'adopt'
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
  const label = mode === 'move' ? '移动到…' : mode === 'restore' ? '恢复到…' : mode === 'adopt' ? '收进资料库…' : '保存到…'

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
  // The shared primitives on a quiet frame; inside a float (a dialog) the float is the frame (draft-save-dialog.css).
  return <section role="dialog" aria-modal="false" aria-label={label} className="ready-save-to">
    <strong className="ready-save-to__title">{label}</strong>
    <label className="ready-save-to__field">标题<Input aria-label="标题" value={title} disabled={busy || mode !== 'save'} onChange={event => { setTitle(event.target.value); setCandidates([]); setError(null) }} /></label>
    <Input aria-label="搜索位置" placeholder="搜索页面或文件夹" value={query} onChange={event => setQuery(event.target.value)} />
    <nav aria-label="当前位置" className="ready-save-to__crumbs">{crumbs.map(node => <button key={node.objectId} type="button" disabled={busy} onClick={() => setParent(parentDirectory(node))}>{node.title} / </button>)}{!selected && <span>{parent}</span>}</nav>
    <div role="tree" aria-label="保存位置" className="ready-save-to__tree">
      {nodes.filter(node => !query || `${node.title} ${node.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(node => {
        const depth = nodes.filter(ancestor => node.path.startsWith(`${parentDirectory(ancestor)}/`) || node.path.startsWith(`${parentDirectory(ancestor)}\\`)).length
        return <button key={node.objectId} type="button" role="treeitem" aria-selected={parent === parentDirectory(node)} disabled={busy}
          className="ready-save-to__node" style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => { setParent(parentDirectory(node)); setCandidates([]); setError(null) }}>{node.title}</button>
      })}
    </div>
    <p aria-label="最终路径" className="ready-save-to__path">预计路径：{preview || '请选择位置'}（文件名由保存服务确认）</p>
    {duplicate && <p role="status" className="ready-save-to__note">此位置已有同名文件，提交后可查看候选名称。</p>}
    {error && <p role="alert" className="ready-save-to__error">{error}</p>}
    {candidates.length > 0 && <div className="ready-save-to__candidates">重名候选：{candidates.map(name => <Button key={name} size="sm" disabled={mode !== 'save'} onClick={() => { setTitle(name); setCandidates([]); setError(null) }}>{name}</Button>)}{mode !== 'save' && <p>移动或恢复不改名，请另选位置。</p>}</div>}
    {sourceCanvas && <div className="ready-save-to__keep">来源画板：{sourceCanvas.title} <Checkbox checked={keepCard} disabled={busy} onChange={setKeepCard} label="保留文档卡" /></div>}
    <div className="ready-save-to__actions">{mode !== 'adopt' && <Button variant="ghost" disabled={busy} onClick={() => void chooseOther()}>其他位置…</Button>}<Button disabled={busy} onClick={onCancel}>取消</Button><Button variant="primary" disabled={busy || !parent} onClick={() => void confirm()}>{busy ? '正在处理…' : '确认'}</Button></div>
  </section>
}
