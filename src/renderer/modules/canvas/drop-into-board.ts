import type { CanvasNode } from '../../../shared/ready-canvas/schema'
import type { GestureScene } from './interaction/gestures'

// Dragging cards onto a sub-board card moves them into that sub-board (M4 §9.1). The drag pipeline asks this for
// the card under the pointer on every frame and hands the drop over at pointer-up; everything else stays here.

const movable = (node: CanvasNode) => node.ready.kind !== 'subcanvas' && node.ready.kind !== 'draft'

export function subBoardDrop(onDrop: (nodeIds: string[], target: CanvasNode) => void) {
  let marked: HTMLElement | null = null, nodes = new Map<string, CanvasNode>()
  return {
    /** The sub-board card that would take the dragged cards (marked while it would); `at` null clears the mark. */
    dropTarget(scene: GestureScene, moving: readonly CanvasNode[], at: { x: number; y: number } | null): string | null {
      marked?.removeAttribute('data-drop-target'); marked = null
      if (!at || !moving.some(movable)) return null
      const dragged = new Set(moving.map(node => node.id))
      const target = scene.index.query({ x: at.x, y: at.y, width: 0, height: 0 }).filter(node => node.ready.kind === 'subcanvas' && !dragged.has(node.id)).at(-1)
      if (!target) return null
      nodes = scene.byId
      marked = scene.elements.get(target.id) ?? null
      marked?.setAttribute('data-drop-target', 'true')
      return target.id
    },
    dropInto(nodeIds: string[], targetId: string): void {
      const target = nodes.get(targetId), ids = nodeIds.filter(id => { const node = nodes.get(id); return !!node && movable(node) })
      if (target && ids.length) onDrop(ids, target)
    },
  }
}
