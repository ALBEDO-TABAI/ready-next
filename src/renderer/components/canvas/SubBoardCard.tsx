import { Frame } from 'lucide-react'
import type { CanvasNode } from '../../../shared/ready-canvas/schema'
import type { SubBoardSummary } from '../../../main/modules/board-engine/sub-boards'
import './sub-board.css'

// A sub-board on its parent board (M4 §9.4): a quiet glass tile that says what is inside — the sub-board's name,
// how many cards it holds and a few of its pictures. Double-click or Enter opens it; cards dropped on it move in.

export function SubBoardCard({ node, summary, resolveAsset }: {
  node: CanvasNode; summary: SubBoardSummary | undefined; resolveAsset(path: string): string | undefined
}) {
  const name = node.type === 'file' ? node.file.split('/').pop()!.replace(/\.canvas$/i, '') : '子画板'
  const images = summary?.images.flatMap(path => { const src = resolveAsset(path); return src ? [src] : [] }) ?? []
  const away = summary ? !summary.available : !!node.ready.trash
  const count = away ? (node.ready.trash ? '随卡片在回收站' : '在资料库回收站') : !summary ? '' : summary.count ? `${summary.count} 张卡片` : '空'
  return <div className="canvas-subboard" data-away={away || undefined} data-thumbs={images.length || undefined}
    onPointerMove={event => {
      // The soft light follows the pointer (Stillroom's folder card).
      const rect = event.currentTarget.getBoundingClientRect()
      event.currentTarget.style.setProperty('--gx', `${((event.clientX - rect.left) / rect.width) * 100}%`)
      event.currentTarget.style.setProperty('--gy', `${((event.clientY - rect.top) / rect.height) * 100}%`)
    }}>
    {images.length > 0 && <div className="canvas-subboard__thumbs" data-count={images.length} aria-hidden>
      {images.map(src => <img key={src} draggable={false} loading="lazy" alt="" src={src} />)}
    </div>}
    <div className="canvas-subboard__label">
      <span className="canvas-subboard__title">{summary?.title || name}</span>
      <span className="canvas-subboard__count"><Frame aria-hidden />{count || '子画板'}</span>
    </div>
  </div>
}
