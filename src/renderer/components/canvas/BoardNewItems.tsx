import { useState } from 'react'
import { FileText, Frame, Link2 } from 'lucide-react'
import type { CanvasNode } from '../../../shared/ready-canvas/schema'
import type { PageNode } from '../../../shared/document-pages'
import { MenuItem } from './surface/CanvasChrome'

// The board's own 新建 entries on the right-click menu (W4 §2.2): a link, a document card, a sub-board. Text and
// note cards and paste come from the surface itself.

const frame = (at: { x: number; y: number }, height: number) => ({ id: crypto.randomUUID(), x: Math.round(at.x - 130), y: Math.round(at.y - 40), width: 260, height })

export function BoardNewItems({ at, close, pages, root, boardPath, add, report }: {
  at: { x: number; y: number }; close(): void; pages: PageNode[]; root: string; boardPath: string
  add(node: CanvasNode): Promise<void>; report(cause: unknown): void
}) {
  const [mode, setMode] = useState<'menu' | 'link' | 'document'>('menu')
  const [url, setUrl] = useState(''), [query, setQuery] = useState(''), [busy, setBusy] = useState(false)
  const run = (work: () => Promise<void>) => { setBusy(true); void work().then(close, cause => { report(cause); setBusy(false) }) }
  if (mode === 'link') return <form className="canvas-menu-form" onSubmit={event => {
    event.preventDefault()
    const href = url.trim()
    if (!/^https?:\/\/\S+$/i.test(href)) { report(new Error('请输入以 http:// 或 https:// 开头的网址')); return }
    run(() => add({ ...frame(at, 195), type: 'link', url: href, ready: { kind: 'link' } }))
  }}>
    <input className="rn-field" aria-label="链接网址" placeholder="https://" autoFocus value={url} disabled={busy} onChange={event => setUrl(event.target.value)} />
    <button type="submit" className="canvas-menu-item" disabled={busy || !url.trim()}><Link2 aria-hidden /><span>添加链接卡</span></button>
  </form>
  if (mode === 'document') {
    const needle = query.trim().toLocaleLowerCase()
    const shown = pages.filter(page => !needle || page.title.toLocaleLowerCase().includes(needle)).slice(0, 8)
    return <div className="canvas-menu-form">
      <input className="rn-field" aria-label="查找页面" placeholder="查找页面" autoFocus value={query} onChange={event => setQuery(event.target.value)} />
      {shown.map(page => <MenuItem key={page.objectId} label={page.title} icon={FileText} disabled={busy}
        onSelect={() => run(() => add({ ...frame(at, 180), type: 'file', file: page.path.slice(root.length + 1), ready: { kind: 'document', ref: { kind: 'page', id: page.objectId } } }))} />)}
      {!shown.length && <p className="canvas-menu-empty">没有匹配的页面</p>}
    </div>
  }
  return <>
    <MenuItem label="链接…" icon={Link2} onSelect={() => setMode('link')} />
    <MenuItem label="文档卡…" icon={FileText} disabled={!pages.length} onSelect={() => setMode('document')} />
    <MenuItem label="子画板" icon={Frame} disabled={busy} onSelect={() => run(async () => {
      const api = window.electronAPI, folder = boardPath.replace(/\\/g, '/').replace(/\.canvas$/i, '')
      let name = '子画板'
      for (let n = 2; (await api.document.stat(`${root}/${folder}/${name}.canvas`))?.success; n++) name = `子画板 ${n}`
      const made = await api.document.mkdir(`${root}/${folder}`)
      if (!made.success) throw new Error(made.error || '无法建立画板文件夹')
      const created = await api.canvas.create({ path: `${folder}/${name}.canvas`, operationId: crypto.randomUUID() })
      if (!created.ok) throw new Error(created.error)
      await api.canvas.release(created.value.handleId)
      await add({ ...frame(at, 195), type: 'file', file: created.value.path, ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: created.value.objectId } } })
    })} />
  </>
}
