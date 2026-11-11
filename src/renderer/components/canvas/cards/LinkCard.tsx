import { useEffect, useState } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas'

// D owns fetching and network policy. No Renderer fetch or HTML execution.
export interface LinkPreviewSource { read(url: string): Promise<{ title?: string; description?: string; site?: string }> }
/** Main's refusal, in words a person can act on (W4 §2.2 O16); other reasons pass through. */
const reason = (message: string) => /private network|内网/i.test(message) ? '这个地址是内网地址，没有抓取预览' : message.replace(/^Error:\s*/, '')

export function LinkCard({ node, source, open }: { node: Extract<CanvasNode, { type: 'link' }>; source?: LinkPreviewSource; open?: () => void }) {
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
  return <article aria-label="链接卡" className="canvas-link-card">
    <strong>{state.preview?.title || host}</strong>{state.preview?.description && <p>{state.preview.description}</p>}<small>{node.url}</small>
    {state.error && <p className="canvas-link-note" role="note">{reason(state.error)}</p>}
    {state.error && open && <button type="button" className="canvas-link-open" data-canvas-ui onClick={event => { event.stopPropagation(); open() }}>在浏览器中打开</button>}
    {!state.error && !state.preview && <p role="status">正在读取预览…</p>}
  </article>
}
