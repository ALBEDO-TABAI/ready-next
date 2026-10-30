import { useRef, useState } from 'react'
import { mixedCanvas } from '../../../../__tests__/fixtures/canvas-surface/mixed'
import { applyCanvasOperations } from '../../../../shared/ready-canvas/operations'
import { graphicSvg } from '../../../../shared/ready-canvas/graphics'
import { fragmentHash } from '../../../../shared/document-blocks/positions'
import { CanvasSurface } from './CanvasSurface'
import type { FrameWork, CanvasSurfaceProps } from './types'
import '../../../design/next/tokens.css'
import './surface.css'

/** Isolated synthetic buffer only: no Main, disk, Ready userData or network calls. */
export default function CanvasLab() {
  const [count, setCount] = useState(12), [canvas, setCanvas] = useState(() => mixedCanvas()), [commits, setCommits] = useState(0)
  const [revision, setRevision] = useState(0), [child, setChild] = useState(false)
  const parent = useRef(canvas), assets = useRef(new Map<string, string>()), stats = useRef({ frames: 0, maxCandidates: 0, maxVisited: 0, maxDomWrites: 0 })
  const renderEditor: CanvasSurfaceProps['renderTextEditor'] = ({ node, commit, close }) => node.type === 'text' ? <form onSubmit={e => {
    e.preventDefault()
    const text = new FormData(e.currentTarget).get('text')
    if (typeof text === 'string') void commit([{ type: 'textRanges', id: node.id, expectedTextVersion: fragmentHash(node.text), ranges: [{ start: 0, end: node.text.length, expectedText: node.text, replacement: text }] }]).then(ok => { if (ok) close() })
  }}><textarea name="text" defaultValue={node.text} aria-label="实验文字编辑" /><button type="submit">应用文字</button></form> : null
  const measure = (w: FrameWork) => {
    const s = stats.current; s.frames++; s.maxCandidates = Math.max(s.maxCandidates, w.candidates); s.maxVisited = Math.max(s.maxVisited, w.visited); s.maxDomWrites = Math.max(s.maxDomWrites, w.domWrites)
    // Counters update outside React during drag, so the lab does not defeat the fast path.
    const output = metrics.current
    if (output) output.textContent = `${s.frames} 帧 · 候选最多 ${s.maxCandidates} · 检查 ${s.maxVisited} · 画面写入 ${s.maxDomWrites}`
  }
  const metrics = useRef<HTMLOutputElement>(null)
  return <div className="rn-canvas canvas-lab">
    <CanvasSurface key={revision} canvas={canvas} renderTextEditor={renderEditor} onFrameWork={measure}
      onOperations={(ops, context) => { setCanvas(applyCanvasOperations(context.before, ops).canvas); setCommits(n => n + 1) }}
      prepareGraphic={async draft => { const path = `Lab.assets/${draft.id}-${crypto.randomUUID()}.svg`; assets.current.set(path, `data:image/svg+xml,${encodeURIComponent(graphicSvg(draft.graphic, draft.width, draft.height))}`); return path }}
      resolveAsset={path => assets.current.get(path) ?? (path.endsWith('image.svg') ? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="#252525"/><circle cx="100" cy="80" r="45" fill="#ff5a1f"/></svg>')}` : undefined)}
      breadcrumbs={child ? [{ id: 'canvas-lab', title: '实验画板' }] : []}
      onNavigateSubcanvas={() => { parent.current = canvas; setCanvas({ ready: { id: 'child', schemaVersion: 1, title: '子画板' }, nodes: [], edges: [] }); setChild(true) }}
      onNavigateAncestor={() => { setCanvas(parent.current); setChild(false) }} />
    <div className="canvas-lab-controls" data-canvas-ui>
      <label>合成夹具 <select value={count} onChange={e => { const n = Number(e.target.value); setCount(n); setCanvas(mixedCanvas(n)); setCommits(0); setChild(false); setRevision(v => v + 1); stats.current = { frames: 0, maxCandidates: 0, maxVisited: 0, maxDomWrites: 0 } }}><option value={12}>12 张</option><option value={1000}>1000 张</option></select></label>
      <span> · 提交 {commits} 次 · </span><output ref={metrics}>等待操作</output>
      <small> · 仅内存；文档、音视频为合成占位</small>
    </div>
  </div>
}
