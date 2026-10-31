import { useEffect, useState, type RefObject } from 'react'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import { selectedReadingRange } from '../../modules/rss/reading-selection'
import RSSReferenceButton from './RSSReferenceButton'

export default function RSSSelectionReferences({ bodyRef, article, active, className, onDone }: { bodyRef: RefObject<HTMLDivElement | null>; article: RSSArticleExcerpt['article']; active: boolean; className?: string; onDone?(): void }) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [ranges, setRanges] = useState<ReturnType<typeof selectedReadingRange>>({ selection: null, paragraph: null })
  useEffect(() => {
    setRanges({ selection: null, paragraph: null })
    const body = bodyRef.current
    if (!body || !active) return
    const update = () => setRanges(selectedReadingRange(body, body.ownerDocument.defaultView?.getSelection() || null))
    // These entries mount when the reference menu opens, after the reader already made a selection.
    update()
    body.ownerDocument.addEventListener('selectionchange', update)
    body.addEventListener('mouseup', update); body.addEventListener('keyup', update)
    return () => { body.ownerDocument.removeEventListener('selectionchange', update); body.removeEventListener('mouseup', update); body.removeEventListener('keyup', update) }
  }, [bodyRef, article.id, article.revision, active])
  const saveSelection = async () => {
    if (!ranges.selection || saving) return
    setSaving(true); setMessage('')
    try {
      const result = await window.electronAPI.sourceAnnotations.rss({ format: 'reading-v1', itemId: article.id,
        expectedRevision: article.revision, range: ranges.selection, offset: 0, length: 24000 })
      if (!result.success) throw new Error(result.error)
      setMessage(result.data.persistence === 'saved' ? '已划线到来源页' : '已加入来源页，请保存笔记')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  return <>
    <button className={className} disabled={!ranges.selection || saving} onMouseDown={event => event.preventDefault()} onClick={() => { void saveSelection() }}>划线到来源页</button>
    {message && <span role="status">{message}</span>}
    {(['selection', 'paragraph'] as const).map((kind) => <RSSReferenceButton key={kind} preserveSelection className={className} onDone={onDone} name={`${article.title} · ${kind === 'selection' ? '选区' : '段落'}`}
      label={kind === 'selection' ? '引用所选文字' : '引用本段'} reference={ranges[kind] ? { kind: 'excerpt', read: { format: 'reading-v1', itemId: article.id,
        expectedRevision: article.revision, range: ranges[kind]!, offset: 0, length: 12000 } } : null} />)}
  </>
}
