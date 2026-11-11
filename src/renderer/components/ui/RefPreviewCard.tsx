import { useEffect, useState } from 'react'
import { loadObjectPreview } from '../../modules/workbench/object-ui/preview'
import { REF_CAPSULE_KINDS, resolveRefSource, type RefCapsuleKind, type RefSource } from './ref-capsule-kinds'

/** Plain text of a preview body: Markdown marks, links and front matter dropped, whitespace folded. */
function excerpt(body: string) {
  return body.replace(/^---[\s\S]*?\n---\s*/, '').replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** The capsule's hover preview (W6 §2.1): its type, title and the first lines of the object. */
export function RefPreviewCard({ source, title, kind }: { source: RefSource; title: string; kind: RefCapsuleKind }) {
  const [state, setState] = useState<{ text: string } | null>(null)
  useEffect(() => {
    let live = true
    void resolveRefSource(source).then(loadObjectPreview).then(preview => {
      if (live) setState({ text: preview.state === 'ready' ? excerpt(preview.body) : preview.message })
    }, () => { if (live) setState({ text: '' }) })
    return () => { live = false }
  }, [source])
  const Icon = REF_CAPSULE_KINDS[kind].icon
  return <div className="rn-ref-preview__card">
    <div className="rn-ref-preview__kind"><Icon aria-hidden />{REF_CAPSULE_KINDS[kind].label}</div>
    <div className="rn-ref-preview__title">{title}</div>
    {state === null ? <div className="rn-ref-preview__body rn-ref-preview__loading" aria-hidden /> : state.text && <p className="rn-ref-preview__body">{state.text}</p>}
    <div className="rn-ref-preview__hint">空格 速览 · ⌘ 点击 新标签打开</div>
  </div>
}
