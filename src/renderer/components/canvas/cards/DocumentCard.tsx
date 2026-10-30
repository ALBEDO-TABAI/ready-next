import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { CanvasNode } from '../../../../shared/ready-canvas'
import type { ReadyRef } from '../../../../shared/ready-ref'
import type { CanvasDocumentPreview } from '../../../../shared/document-drafts'
import { openReadyRef } from '../../../modules/workbench/open-ready-ref'

export type DocumentPreview = CanvasDocumentPreview
export interface DocumentPreviewSource {
  read(node: CanvasNode): Promise<DocumentPreview>
  subscribe(changed: () => void): () => void
}
export function DocumentCard({ node, source, open = openReadyRef }: {
  node: CanvasNode; source: DocumentPreviewSource; open?: (ref: ReadyRef) => Promise<void>
}) {
  const [revision, refresh] = useState(0)
  const [state, setState] = useState<{ preview: DocumentPreview | null; error: string }>({ preview: null, error: '' })
  const ref = state.preview?.ref ?? node.ready.ref
  useEffect(() => source.subscribe(() => refresh(n => n + 1)), [source])
  useEffect(() => {
    let current = true
    setState({ preview: null, error: '' })
    source.read(node).then(preview => { if (current) setState({ preview, error: '' }) }, error => {
      if (current) setState({ preview: null, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [node, source, revision])
  return <article aria-label="文档卡" onDoubleClick={e => e.stopPropagation()}>
    <strong>{state.preview?.title || node.ready.preview?.title || '文档'}</strong>
    {state.error ? <p role="alert">预览失败：{state.error}</p> : state.preview ? <>
      <ReactMarkdown skipHtml allowedElements={['p', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'br']} unwrapDisallowed>{state.preview.markdown}</ReactMarkdown>
      {state.preview.truncated && <small>仅显示部分内容</small>}
    </> : <p role="status">正在读取原文…</p>}
    <button data-canvas-ui disabled={!ref} onClick={() => { if (ref) void open(ref).catch(error => setState(s => ({ ...s, error: String(error) }))) }}>打开</button>
  </article>
}
