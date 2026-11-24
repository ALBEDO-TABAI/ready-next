import type { ReactNode } from 'react'

/**
 * A button label that changes with its state (保存 → 正在保存…) without changing the button's width (motion language
 * M2: nothing beside it is pushed): the widest of `reserve` holds the room, unseen, under the label shown.
 */
export function StableLabel({ reserve, children }: { reserve: readonly string[]; children: ReactNode }) {
  const widest = reserve.reduce((a, b) => (b.length > a.length ? b : a), '')
  return <span className="rn-stable-label" data-reserve={widest}><span>{children}</span></span>
}
