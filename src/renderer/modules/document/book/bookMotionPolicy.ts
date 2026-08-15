import type {
  BookFlipController,
  BookFlipDirection,
} from './bookFlipController'

export interface BookLeafTakeoverPolicyInput {
  reducedMotion: boolean
  active: boolean
  theta: number
  direction: BookFlipDirection
  armedSide: 'left' | 'right' | null
  armedRigid: boolean
  coverClosed: boolean
}

export function resolveBookLeafTakeoverPolicy(input: BookLeafTakeoverPolicyInput) {
  const visible = !input.reducedMotion && input.active
  const engaged = visible && input.theta > 0.01
  return {
    visible,
    shadowsVisible: engaged,
    hiddenSide: engaged ? input.armedSide : null,
    hideCover: engaged && input.armedRigid,
    coverLifting: engaged && input.armedRigid && input.coverClosed && input.direction === 'forward',
  }
}

export function settleBookPointerRelease(
  reducedMotion: boolean,
  direction: BookFlipDirection,
  controller: BookFlipController | null,
  instantJump: (direction: BookFlipDirection) => void,
) {
  if (reducedMotion) {
    controller?.cancel()
    instantJump(direction)
    return
  }
  controller?.release()
}
