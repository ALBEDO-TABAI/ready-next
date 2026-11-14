import { useEffect, useRef, useState } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas'
import { parseReadyUri, ReadyRefSchema, type ReadyRef } from '../../../../shared/ready-ref'
import { RefCapsule } from '../../ui/RefCapsule'

// D owns fetching and network policy. No Renderer fetch or HTML execution.
/** `image` is a path in the board's attachments (Main copied the page's cover there). */
export interface LinkPreviewData { title?: string; description?: string; site?: string; image?: string; fetchedAt?: string }
export interface LinkPreviewSource { read(url: string): Promise<LinkPreviewData> }
/** Main's refusal, in words a person can act on (W4 §2.2 O16); other reasons pass through. */
const reason = (message: string) => /private network|内网/i.test(message) ? '这个地址是内网地址，没有抓取预览' : message.replace(/^Error:\s*/, '')

/** The link's reference: a Ready address, or a web page. Other schemes stay plain text. */
function linkReference(url: string): ReadyRef | null {
  const ready = parseReadyUri(url)
  if (ready.ok) return ready.ref
  const web = ReadyRefSchema.safeParse({ kind: 'web', url })
  return web.success ? web.data : null
}

export function LinkCard({ node, source, resolveAsset, onPreview }: {
  node: Extract<CanvasNode, { type: 'link' }>; source?: LinkPreviewSource
  resolveAsset?: (path: string) => string | undefined
  /** A preview read for a card that keeps none yet: the host may store it on the card. */
  onPreview?: (node: Extract<CanvasNode, { type: 'link' }>, preview: LinkPreviewData) => void
}) {
  // A preview kept on the card is the cache: nothing is fetched again until 刷新预览.
  const kept = node.ready.preview?.fetchedAt ? node.ready.preview : undefined
  const [state, setState] = useState<{ preview?: LinkPreviewData; error?: string }>({})
  const [brokenCover, setBrokenCover] = useState<string>()
  const notify = useRef(onPreview)
  notify.current = onPreview
  const id = node.id
  useEffect(() => {
    if (kept) return
    let current = true
    setState({})
    if (!source) { setState({ error: '预览服务尚未接通' }); return }
    source.read(node.url).then(preview => { if (current) { setState({ preview }); notify.current?.(node, preview) } }, error => {
      if (current) setState({ error: error instanceof Error ? error.message : String(error) })
    })
    return () => { current = false }
  }, [id, node.url, source, kept === undefined]) // eslint-disable-line react-hooks/exhaustive-deps -- a moved or restyled card keeps its preview
  const preview = kept ?? state.preview
  const host = (() => { try { return new URL(node.url).host.replace(/^www\./, '') } catch { /* silent-catch: A malformed URL still shows as written. */ return node.url } })()
  const reference = linkReference(node.url)
  const cover = preview?.image && preview.image !== brokenCover ? resolveAsset?.(preview.image) : undefined
  // The address is the card's reference capsule (W6 §2.1): it opens in Ready's browser even when no preview came back.
  return <article aria-label="链接卡" className="canvas-link-card" data-cover={cover ? '' : undefined}>
    {cover && <img className="canvas-link-cover" draggable={false} loading="lazy" decoding="async" alt="" src={cover} onError={() => setBrokenCover(preview!.image)} />}
    <div className="canvas-link-body">
      <strong>{preview?.title || host}</strong>{preview?.description && <p>{preview.description}</p>}
      {reference ? <span className="canvas-link-ref"><RefCapsule reference={reference} title={node.url.replace(/^https?:\/\//, '')} canvasUi /></span> : <small>{node.url}</small>}
      {!kept && state.error && <p className="canvas-link-note" role="note">{reason(state.error)}</p>}
      {!kept && !state.error && !state.preview && <p role="status">正在读取预览…</p>}
    </div>
  </article>
}
