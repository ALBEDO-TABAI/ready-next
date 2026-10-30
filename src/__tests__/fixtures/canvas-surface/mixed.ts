import type { ReadyCanvas, CanvasNode } from '../../../shared/ready-canvas/schema'

/** Synthetic, deterministic; no user files, network assets or database. */
export function mixedCanvas(count = 12): ReadyCanvas {
  const nodes: CanvasNode[] = Array.from({ length: count }, (_, i) => {
    const base = { id: `n${i}`, x: (i % 25) * 260, y: Math.floor(i / 25) * 220, width: 200, height: 160 }
    switch (i % 8) {
      case 1: return { ...base, type: 'link', url: 'https://example.com', ready: { kind: 'link', preview: { title: '参考链接' } } }
      case 2: return { ...base, type: 'file', file: 'Lab.assets/image.svg', ready: { kind: 'image' } }
      case 3: return { ...base, type: 'file', file: 'Lab.assets/audio.wav', ready: { kind: 'audio' } }
      case 4: return { ...base, type: 'file', file: 'Lab.assets/video.mp4', ready: { kind: 'video' } }
      case 5: return { ...base, type: 'file', file: 'Page.md', ready: { kind: 'document', preview: { title: '文档预览' } } }
      case 6: return { ...base, type: 'file', file: 'Lab/Child.canvas', ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: 'child' } } }
      case 7: return { ...base, type: 'file', file: 'Lab.assets/rect.svg', ready: { kind: 'graphic', graphic: { type: 'rect', fill: 'transparent', stroke: '#ff5a1f', strokeWidth: 2 } } }
      default: return { ...base, type: 'text', text: `灵感 ${i}\n双击编辑文字`, ready: { kind: 'text' } }
    }
  })
  return { ready: { id: 'canvas-lab', schemaVersion: 1, title: '交互实验画板' }, nodes, edges: count > 1 ? [{ id: 'edge0', fromNode: 'n0', toNode: 'n1', toEnd: 'arrow' }] : [] }
}
