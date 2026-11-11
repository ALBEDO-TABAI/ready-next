import { useEffect, useState } from 'react'
import { loadObjectPreview } from '../../modules/workbench/object-ui/preview'
import { REF_CAPSULE_KINDS, resolveRefSource, type RefCapsuleKind, type RefSource } from './ref-capsule-kinds'

/**
 * The first words of a preview body as plain text: front matter, a heading that repeats the title, Markdown marks and
 * list or quote markers dropped; a [[wiki]] link reads as its alias or the page's own name.
 */
function excerpt(body: string, title: string) {
  const lines = body.replace(/^---[\s\S]*?\n---\s*/, '').split(/\r?\n/)
  const first = lines.findIndex(line => line.trim())
  const heading = first >= 0 && /^#{1,6}\s/.test(lines[first]) ? lines[first].replace(/^#{1,6}\s+/, '').trim() : null
  if (heading && [title.trim(), title.split('/').pop()?.trim()].includes(heading)) lines.splice(first, 1)
  return lines.map(line => line.replace(/^\s*(?:>\s?)*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s+)?/, '')).join(' ')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target.split('#')[0].split('/').pop() ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`~|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** The capsule's hover preview (W6 §2.1): its type, title and the first lines of the object. */
export function RefPreviewCard({ source, title, kind }: { source: RefSource; title: string; kind: RefCapsuleKind }) {
  const [state, setState] = useState<{ text: string } | null>(null)
  useEffect(() => {
    let live = true
    void resolveRefSource(source).then(loadObjectPreview).then(preview => {
      if (live) setState({ text: preview.state === 'ready' ? excerpt(preview.body, title) : preview.message })
    }, () => { if (live) setState({ text: '' }) })
    return () => { live = false }
  }, [source, title])
  const Icon = REF_CAPSULE_KINDS[kind].icon
  return <div className="rn-ref-preview__card">
    <div className="rn-ref-preview__kind"><Icon aria-hidden />{REF_CAPSULE_KINDS[kind].label}</div>
    <div className="rn-ref-preview__title">{title}</div>
    {state === null ? <div className="rn-ref-preview__body rn-ref-preview__loading" aria-hidden /> : state.text && <p className="rn-ref-preview__body">{state.text}</p>}
    <div className="rn-ref-preview__hint">空格 速览 · ⌘ 点击 新标签打开</div>
  </div>
}
