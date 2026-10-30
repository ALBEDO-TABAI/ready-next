import { useState } from 'react'
import { createPortal } from 'react-dom'
import { DOCUMENT_PALETTE, isDocumentColor, type InlineMarks, type InlineReference } from '../../../../shared/document-blocks'
import { parseReadyUri, toReadyUri } from '../../../../shared/ready-ref'
import type { MenuAnchor } from './CommandMenu'

export const INLINE_BUTTONS = [['bold', '粗体'], ['italic', '斜体'], ['strike', '删除线'], ['code', '行内代码'], ['underline', '下划线']] as const
export function InlineToolbar({ anchor, marks, apply, close, open, report }: {
  anchor: MenuAnchor; marks: InlineMarks; apply(patch: InlineMarks): void; close(): void
  open(reference: InlineReference): Promise<void>; report(error: unknown): void
}) {
  const [link, setLink] = useState<string | null>(null)
  const initial = marks.reference?.kind === 'wiki' ? `[[${marks.reference.target}]]` : marks.reference?.kind === 'ready' ? toReadyUri(marks.reference.ref) : marks.reference?.href ?? ''
  const saveLink = () => {
    if (link === null) return
    try {
      const href = link.trim()
      const wiki = /^\[\[([^[\]|\r\n]+)\]\]$/.exec(href)
      const ready = parseReadyUri(href)
      if (href && !wiki && !ready.ok && !/^https?:\/\/\S+$/i.test(href)) throw new Error('请输入 https 链接、ReadyRef 或 [[页面]]')
      apply({ reference: !href ? undefined : wiki ? { kind: 'wiki', target: wiki[1] } : ready.ok ? { kind: 'ready', ref: ready.ref } : { kind: 'link', href } })
      setLink(null)
    } catch (error) { report(error) }
  }
  return createPortal(<div role="toolbar" aria-label="文字格式" data-block-popup data-ready-native-overlay="" className="ready-block-popover ready-block-toolbar"
    style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 380)), top: Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - 160)) }}
    onMouseDown={event => { if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') event.preventDefault() }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.tagName === 'INPUT') { event.preventDefault(); saveLink() }
      if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') { event.preventDefault(); event.target.click() }
    }}>
    {INLINE_BUTTONS.map(([key, label]) => <button key={key} type="button" aria-pressed={Boolean(marks[key])} onClick={() => apply({ [key]: marks[key] ? undefined : true })}>{label}</button>)}
    {(['color', 'background'] as const).map(key => <select key={key} aria-label={key === 'color' ? '文字颜色' : '背景颜色'} value={marks[key] ?? 'default'}
      onChange={event => { const value = event.target.value; if (isDocumentColor(value)) apply({ [key]: value === 'default' ? undefined : value }) }}>
      {Object.entries(DOCUMENT_PALETTE).map(([value, label]) => <option value={value} key={value}>{key === 'color' ? '文字' : '背景'}：{label}</option>)}
    </select>)}
    <button type="button" onClick={() => setLink(initial)}>链接</button>
    {link !== null && <><input autoFocus aria-label="链接地址" value={link} onChange={event => setLink(event.target.value)} />
      <button type="button" onClick={saveLink}>应用链接</button>
      <button type="button" onClick={() => { apply({ reference: undefined }); setLink(null) }}>移除链接</button>
      {marks.reference && <button type="button" onClick={() => { void open(marks.reference!).catch(report) }}>打开链接</button>}</>}
  </div>, document.body)
}
