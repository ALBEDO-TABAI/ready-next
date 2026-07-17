import type { ReadyBoardState } from '../../../shared/ready-board'

export interface PendingBoardTextEdit {
  id: string
  value: string
}

export function applyPendingBoardTextEdit(
  state: ReadyBoardState,
  edit: PendingBoardTextEdit | null,
): ReadyBoardState {
  if (!edit) return state
  let changed = false
  const nodes = state.nodes.map((node) => {
    if (node.id !== edit.id || (node.type !== 'text' && node.type !== 'note')) return node
    if (node.text === edit.value) return node
    changed = true
    return { ...node, text: edit.value }
  })
  return changed ? { ...state, nodes } : state
}
