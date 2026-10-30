import { memo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas/schema'
import { graphicSvg } from '../../../../shared/ready-canvas/graphics'
import { cardFrame } from '../../../modules/canvas/interaction/graphics'

interface Props {
  node: CanvasNode; visible: boolean; selected: boolean; editor?: ReactNode; content?: ReactNode
  element: (id: string, el: HTMLDivElement | null) => void
  resolveAsset?: (path: string) => string | undefined
  open: (node: CanvasNode) => void
}
function Preview({ node: n, resolveAsset }: Pick<Props, 'node' | 'resolveAsset'>) {
  const g = n.ready.graphic
  if (g) {
    return <img draggable={false} alt={g.type === 'rect' ? '矩形' : g.type === 'arrow' ? '自由箭头' : '手绘'} className="canvas-graphic" style={{ left: 0, top: 0, width: '100%', height: '100%' }} src={`data:image/svg+xml,${encodeURIComponent(graphicSvg(g, n.width, n.height))}`} />
  }
  if (n.type === 'text') return <div className="canvas-text">{n.text}</div>
  if (n.type === 'group') return <div className="canvas-group-label">{n.label || '分组'}</div>
  if (n.type === 'link') return <><strong>{n.ready.preview?.title || n.url}</strong><p>{n.ready.preview?.description}</p><small>{n.url}</small></>
  const src = resolveAsset?.(n.file)
  if (src && n.ready.kind === 'image') return <img draggable={false} loading="lazy" src={src} alt={n.ready.preview?.title || n.file} />
  if (src && n.ready.kind === 'video') return <video controls preload="none" src={src} />
  if (src && n.ready.kind === 'audio') return <audio controls preload="none" src={src} />
  return <><small>{({ image: '图片', audio: '音频', video: '视频', document: '文档', subcanvas: '子画板' })[n.ready.kind] || n.ready.kind}</small><strong>{n.ready.preview?.title || n.file}</strong><p>{n.ready.preview?.description}</p></>
}
export const CanvasCard = memo(function CanvasCard({ node, visible, selected, editor, content, element, resolveAsset, open }: Props) {
  const a = node.ready.appearance, frame = cardFrame(node)
  const style: CSSProperties = { left: frame.x, top: frame.y, width: frame.width, height: frame.height,
    transform: a?.rotation ? `rotate(${a.rotation}deg)` : undefined, borderRadius: a?.radius,
    background: a?.background, color: a?.color, fontSize: a?.fontScale ? `${a.fontScale * 24}px` : undefined,
    textAlign: a?.align, fontWeight: a?.weight ? ({ light: 300, regular: 400, medium: 500, bold: 700 })[a.weight] : undefined }
  return <div ref={el => element(node.id, el)} data-node-id={node.id} data-selected={selected} data-kind={node.ready.kind}
    data-lightweight={!visible && !editor} className="canvas-card" style={style} onDoubleClick={() => open(node)}>
    {(visible || editor) && <div data-node-detail className="canvas-card-content">{editor ?? content ?? <Preview node={node} resolveAsset={resolveAsset} />}</div>}
    {selected && visible && <button type="button" data-resize aria-label="调整卡片尺寸" className="canvas-resize" />}
  </div>
})
