import { create } from 'zustand'
export const useCanvasNavigation = create<{ target: { objectId: string; nodeId?: string; requestId: string } | null }>(() => ({ target: null }))
export function requestCanvasNode(objectId: string, nodeId?: string): void {
  useCanvasNavigation.setState({ target: { objectId, nodeId, requestId: crypto.randomUUID() } })
}
