import { useEffect, useState } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas'
import { parseReadyUri, ReadyRefSchema, type ReadyRef } from '../../../../shared/ready-ref'
import { RefCapsule } from '../../ui/RefCapsule'

// D owns fetching and network policy. No Renderer fetch or HTML execution.
export interface LinkPreviewSource { read(url: string): Promise<{ title?: string; description?: string; site?: string }> }
/** Main's refusal, in words a person can act on (W4 §2.2 O16); other reasons pass through. */
const reason = (message: string) => /private network|内网/i.test(message) ? '这个地址是内网地址，没有抓取预览' : message.replace(/^Error:\s*/, '')

/** The link's reference: a Ready address, or a web page. Other schemes stay plain text. */
function linkReference(url: string): ReadyRef | null {
  const ready = parseReadyUri(url)
  if (ready.ok) return ready.ref
  const web = ReadyRefSchema.safeParse({ kind: 'web', url })
  return web.success ? web.data : null
}

export function LinkCard({ node, source }: { node: Extract<CanvasNode, { type: 'link' }>; source?: LinkPreviewSource }) {
  const [state, setState] = useState<{ preview?: { title?: string; description?: string }; error?: string }>({})
  useEffect(() => {
    let current = true
    setState({})
    if (!source) { setState({ error: '预览服务尚未接通' }); return }
    source.read(node.url).then(preview => { if (current) setState({ preview }) }, error => {
      if (current) setState({ error: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [node.url, source])
  const host = (() => { try { return new URL(node.url).host.replace(/^www\./, '') } catch { /* silent-catch: A malformed URL still shows as written. */ return node.url } })()
  const reference = linkReference(node.url)
  // The address is the card's reference capsule (W6 §2.1): it opens in Ready's browser even when no preview came back.
  return <article aria-label="链接卡" className="canvas-link-card">
    <strong>{state.preview?.title || host}</strong>{state.preview?.description && <p>{state.preview.description}</p>}
    {reference ? <span className="canvas-link-ref"><RefCapsule reference={reference} title={node.url.replace(/^https?:\/\//, '')} canvasUi /></span> : <small>{node.url}</small>}
    {state.error && <p className="canvas-link-note" role="note">{reason(state.error)}</p>}
    {!state.error && !state.preview && <p role="status">正在读取预览…</p>}
  </article>
}
