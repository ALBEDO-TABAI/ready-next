import type {
  ReadyBoardAsset,
  ReadyBoardImageNode,
  ReadyBoardState,
} from '../../../shared/ready-board'

export function appendExternalBoardImage(
  state: ReadyBoardState,
  asset: ReadyBoardAsset,
  nodeId: string,
  externalReceiptId?: string,
): ReadyBoardState {
  if (
    externalReceiptId
    && state.nodes.some((node) => node.type === 'image' && node.externalReceiptId === externalReceiptId)
  ) {
    return state
  }
  const node: ReadyBoardImageNode = {
    id: nodeId,
    type: 'image',
    src: asset.src,
    title: asset.title || asset.name,
    x: 0,
    y: 0,
    width: 360,
    height: 240,
    ...(externalReceiptId ? { externalReceiptId } : {}),
  }
  return { ...state, nodes: [...state.nodes, node] }
}
