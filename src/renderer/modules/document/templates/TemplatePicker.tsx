import { useEffect, useRef, useState } from 'react'
import { SaveToPicker } from '../page-ui/SaveToPicker'
import { Button, Input, Select } from '../../../components/ui'
import { flattenPages, parentDirectory } from '../page-ui/page-state'
import type { PageNode } from '../../../../shared/document-pages'
export function TemplatePicker({ path, title: initialTitle, insert, close }: {
  path: string | null; title: string; insert: ((markdown: string) => void) | null; close(): void
}) {
  const [templates, setTemplates] = useState<string[]>([]), [selected, setSelected] = useState('')
  const [title, setTitle] = useState(initialTitle), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [trees, setTrees] = useState<PageNode[] | null>(null)
  const operation = useRef(crypto.randomUUID()), pending = useRef(false), [locked, setLocked] = useState(false)
  useEffect(() => {
    let live = true
    window.electronAPI.documentAnnotations.templates({ type: 'list' }).then(result => {
      if (!result.ok) throw new Error(result.message)
      if (result.value.kind !== 'list') throw new Error('模板列表返回无效')
      if (live) { setTemplates(result.value.templates); setSelected(result.value.templates[0] ?? '') }
    }).catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [])
  async function submit() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setLocked(true)
    try {
      if (!insert) {
        const vault = await window.electronAPI.vault.get()
        if (vault.status !== 'ready') throw new Error('请先配置资料库')
        const tree = await window.electronAPI.documentPages.tree({ kind: 'vault', path: vault.root })
        if (!tree.ok) throw new Error(tree.message)
        setTrees([tree.value]); return
      }
      if (!path) throw new Error('请先保存当前页面，以确定附件位置')
      const result = await window.electronAPI.documentAnnotations.templates({ type: 'expand', template: selected, title, targetPath: path, operationId: operation.current })
      if (!result.ok) throw new Error(result.message)
      if (result.value.kind !== 'expanded') throw new Error('模板操作返回无效')
      insert(result.value.content)
      close()
    } catch (cause) { setError(String(cause)) } finally { pending.current = false; setBusy(false) }
  }
  if (trees) return <SaveToPicker trees={trees} initialTitle={title} initialParentPath={path?.replace(/[/\\][^/\\]+$/, '')}
    onCancel={() => setTrees(null)} onConfirm={async selection => {
      const parent = selection.parentObjectId ? flattenPages(trees).find(node => node.objectId === selection.parentObjectId) : null
      const parentPath = parent ? parentDirectory(parent) : selection.parentPath
      if (!parentPath) throw new Error('请选择保存位置')
      const result = await window.electronAPI.documentAnnotations.templates({ type: 'create', template: selected, title: selection.title, parentPath, operationId: selection.operationId })
      if (!result.ok) return result
      if (result.value.kind !== 'created') throw new Error('模板操作返回无效')
      const { openReadyRef } = await import('../../workbench/open-ready-ref')
      await openReadyRef({ kind: 'page', id: result.value.receipt.objectId }, 'document')
      close(); return result
    }} />
  return <form role="dialog" aria-label={insert ? '插入模板' : '从模板新建页面'} className="ink-template-form" onSubmit={event => { event.preventDefault(); void submit() }}>
    <label>模板<Select aria-label="模板" disabled={locked} value={selected} onChange={event => setSelected(event.target.value)} options={templates.map(name => ({ value: name, label: name }))} /></label>
    <label>标题<Input aria-label="模板标题" disabled={locked} value={title} onChange={event => setTitle(event.target.value)} /></label>
    {error && <p role="alert" className="ink-panel-error">{error}</p>}
    {!templates.length && <p className="ink-template-note">请在资料库的“模板”文件夹放入 Markdown 模板。</p>}
    <div className="ink-template-actions"><Button disabled={busy} onClick={close}>关闭</Button><Button type="submit" variant="primary" disabled={busy || !selected}>{error ? '重试' : insert ? '插入模板内容' : '创建页面'}</Button></div>
  </form>
}
