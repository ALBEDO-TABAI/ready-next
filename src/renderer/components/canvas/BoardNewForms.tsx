import { useState } from 'react'
import { FileText, Link2 } from 'lucide-react'
import type { CanvasNode } from '../../../shared/ready-canvas/schema'
import type { PageNode } from '../../../shared/document-pages'
import { Button, Input, MenuList } from '../ui'
import { newCardFrame } from './new-card'

// The two 新建 entries that need a word from you (链接…, 文档卡…): small forms in a W1 float at the clicked point.
// Each closes only after its card is written (the board ignores right-clicks while a write is in flight).

type Host = { at: { x: number; y: number }; add(node: CanvasNode): Promise<void>; report(cause: unknown): void; close(): void }

function useWrite(report: (cause: unknown) => void, close: () => void) {
  const [busy, setBusy] = useState(false)
  return { busy, run: (work: () => Promise<void>) => { setBusy(true); void work().then(close, cause => { report(cause); setBusy(false) }) } }
}

export function LinkForm({ at, add, report, close }: Host) {
  const [url, setUrl] = useState(''), { busy, run } = useWrite(report, close)
  return <form onSubmit={event => {
    event.preventDefault()
    const href = url.trim()
    if (!/^https?:\/\/\S+$/i.test(href)) { report(new Error('请输入以 http:// 或 https:// 开头的网址')); return }
    run(() => add({ ...newCardFrame(at, 195), type: 'link', url: href, ready: { kind: 'link' } }))
  }}>
    <Input aria-label="链接网址" placeholder="https://" data-autofocus value={url} disabled={busy} onChange={event => setUrl(event.target.value)} />
    <div className="canvas-new-float__actions"><Button type="submit" size="sm" icon={<Link2 />} disabled={busy || !url.trim()}>添加链接卡</Button></div>
  </form>
}

/** Pick a page (type to narrow, Enter takes the first); it becomes a document card. */
export function DocumentPicker({ at, pages, root, add, report, close }: Host & { pages: PageNode[]; root: string }) {
  const [query, setQuery] = useState(''), { busy, run } = useWrite(report, close)
  const needle = query.trim().toLocaleLowerCase()
  const shown = pages.filter(page => !needle || page.title.toLocaleLowerCase().includes(needle)).slice(0, 8)
  const pick = (page: PageNode) => run(() => add({ ...newCardFrame(at, 180), type: 'file', file: page.path.slice(root.length + 1), ready: { kind: 'document', ref: { kind: 'page', id: page.objectId } } }))
  return <>
    <Input aria-label="查找页面" placeholder="查找页面" data-autofocus value={query} disabled={busy} onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && shown[0]) { event.preventDefault(); pick(shown[0]) } }} />
    {shown.length ? <MenuList label="页面" items={shown.map(page => ({ id: page.objectId, label: page.title, icon: <FileText />, disabled: busy, onSelect: () => pick(page) }))} onDone={() => {}} />
      : <p className="canvas-new-float__empty">没有匹配的页面</p>}
  </>
}
