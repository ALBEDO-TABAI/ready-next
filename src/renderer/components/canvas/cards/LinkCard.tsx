import { useEffect, useState } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas'

// D owns fetching and network policy. No Renderer fetch or HTML execution.
export interface LinkPreviewSource { read(url: string): Promise<{ title?: string; description?: string; site?: string }> }
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
  return <article aria-label="链接卡">
    <strong>{state.preview?.title || node.url}</strong><p>{state.preview?.description}</p><small>{node.url}</small>
    {state.error && <p role="alert">预览失败：{state.error}</p>}
    {!state.error && !state.preview && <p role="status">正在读取预览…</p>}
  </article>
}
