import { useEffect, useState, type RefObject } from 'react'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import { selectedReadingRange } from '../../modules/rss/reading-selection'
import RSSReferenceButton from './RSSReferenceButton'

export default function RSSSelectionReferences({ bodyRef, article, active }: { bodyRef: RefObject<HTMLDivElement | null>; article: RSSArticleExcerpt['article']; active: boolean }) {
  const [ranges, setRanges] = useState<ReturnType<typeof selectedReadingRange>>({ selection: null, paragraph: null })
  useEffect(() => {
    setRanges({ selection: null, paragraph: null })
    const body = bodyRef.current
    if (!body || !active) return
    const update = () => setRanges(selectedReadingRange(body, body.ownerDocument.defaultView?.getSelection() || null))
    body.ownerDocument.addEventListener('selectionchange', update)
    body.addEventListener('mouseup', update); body.addEventListener('keyup', update)
    return () => { body.ownerDocument.removeEventListener('selectionchange', update); body.removeEventListener('mouseup', update); body.removeEventListener('keyup', update) }
  }, [bodyRef, article.id, article.revision, active])
  return <>
    {(['selection', 'paragraph'] as const).map((kind) => <RSSReferenceButton key={kind} preserveSelection name={`${article.title} · ${kind === 'selection' ? '选区' : '段落'}`}
      label={kind === 'selection' ? '引用所选文字' : '引用本段'} reference={ranges[kind] ? { kind: 'excerpt', read: { format: 'reading-v1', itemId: article.id,
        expectedRevision: article.revision, range: ranges[kind]!, offset: 0, length: 12000 } } : null} />)}
  </>
}
