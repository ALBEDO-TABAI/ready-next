import type { HTMLAttributes } from 'react'
import { toReadyUri, type ReadyRef } from '../../../shared/ready-ref'
import { activateRefCapsule, enterRefCapsule, leaveRefCapsule, openRef, openRefCapsuleMenu, quickLookRef, startRefCapsuleDrag } from './ref-capsule-actions'
import { REF_CAPSULE_KINDS, refCapsuleKind } from './ref-capsule-kinds'

export interface RefCapsuleProps extends Pick<HTMLAttributes<HTMLAnchorElement>, 'className' | 'id'> {
  reference: ReadyRef
  /** The object's title, without a file extension. */
  title: string
  /** What the reference alone cannot tell, e.g. 数据库 from a search result. */
  typeHint?: string
  /** Inside the board, where a pointer on a card otherwise starts a drag of the card. */
  canvasUi?: boolean
}

// Keyboard focus shows the preview as hovering does; a pointer focus does not.
const focusVisible = (element: Element) => { try { return element.matches(':focus-visible') } catch { return false } }

/**
 * A reference to a Ready object (W6 §2.1): its type icon and title, with the same operations everywhere — click opens,
 * ⌥-click or hover-then-Space quick-looks, ⌘-click opens in a new tab, dragging carries the reference, and the context
 * menu offers 打开 / 速览 / 复制引用 / 在文件视角中显示. Its accessible name is the type and the title.
 */
export function RefCapsule({ reference, title, typeHint, canvasUi, className, id }: RefCapsuleProps) {
  const kind = refCapsuleKind(reference, typeHint)
  const name = `${REF_CAPSULE_KINDS[kind].label} ${title}`
  return <a id={id} href={toReadyUri(reference)} className={className ? `rn-ref ${className}` : 'rn-ref'} data-ref-kind={kind} data-ready-ref-capsule=""
    data-canvas-ui={canvasUi || undefined} aria-label={name} draggable
    onClick={event => activateRefCapsule(event, reference)}
    onAuxClick={event => { if (event.button === 1) { event.preventDefault(); openRef(reference, { newTab: true }) } }}
    onContextMenu={event => openRefCapsuleMenu(event, reference, title, kind)}
    onDragStart={event => startRefCapsuleDrag(event, reference, title)}
    onMouseEnter={event => enterRefCapsule(event.currentTarget, reference, title, kind)}
    onMouseLeave={event => leaveRefCapsule(event.currentTarget)}
    onFocus={event => { if (focusVisible(event.currentTarget)) enterRefCapsule(event.currentTarget, reference, title, kind) }}
    onBlur={event => leaveRefCapsule(event.currentTarget)}
    onKeyDown={event => {
      if (event.key !== ' ' || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
      event.preventDefault(); event.stopPropagation()
      quickLookRef(reference)
    }}>{title}</a>
}
