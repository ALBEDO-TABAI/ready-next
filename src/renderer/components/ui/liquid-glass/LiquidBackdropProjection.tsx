import { useId, useLayoutEffect, useRef } from 'react'

interface LiquidBackdropProjectionProps {
  className: string
  sourceSelector?: string
  cloneClassName?: string
  sourceMaskRadius?: number
}

interface ProjectionHole {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

interface SourceMaskState {
  source: HTMLElement | null
  snapshot: Array<[string, string]> | null
  holes: Map<string, ProjectionHole>
}

const DEFAULT_CHAT_SOURCE_SELECTOR = '[data-liquid-scroll-root="chat-messages"]'
const maskProperties = [
  'mask-image',
  'mask-size',
  'mask-repeat',
  'mask-position',
  'mask-mode',
  '-webkit-mask-image',
  '-webkit-mask-size',
  '-webkit-mask-repeat',
  '-webkit-mask-position',
]
const sourceMaskStates = new Map<string, SourceMaskState>()

function getMaskState(selector: string): SourceMaskState {
  const current = sourceMaskStates.get(selector)
  if (current) return current
  const next: SourceMaskState = { source: null, snapshot: null, holes: new Map() }
  sourceMaskStates.set(selector, next)
  return next
}

function clearMaskStyles(element: HTMLElement) {
  maskProperties.forEach((property) => element.style.removeProperty(property))
}

function restoreSourceMask(state: SourceMaskState) {
  const { source, snapshot } = state
  if (!source || !snapshot) return
  maskProperties.forEach((property) => source.style.removeProperty(property))
  snapshot.forEach(([property, value]) => {
    if (value) source.style.setProperty(property, value)
  })
  state.source = null
  state.snapshot = null
}

function ensureSourceMaskState(selector: string, source: HTMLElement): SourceMaskState {
  const state = getMaskState(selector)
  if (state.source !== source) {
    restoreSourceMask(state)
    state.source = source
    state.snapshot = maskProperties.map((property) => [property, source.style.getPropertyValue(property)])
  }
  return state
}

function applyCombinedSourceMask(state: SourceMaskState, sourceRect: DOMRect) {
  const source = state.source
  if (!source || !state.snapshot) return

  if (state.holes.size === 0) {
    restoreSourceMask(state)
    return
  }

  const holes = Array.from(state.holes.values())
    .filter((hole) => hole.width > 1 && hole.height > 1)
    .map((hole) => (
      `<rect x="${hole.x}" y="${hole.y}" width="${hole.width}" height="${hole.height}" rx="${hole.radius}" ry="${hole.radius}" fill="black"/>`
    ))
    .join('')

  if (!holes) {
    clearMaskStyles(source)
    return
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceRect.width}" height="${sourceRect.height}" viewBox="0 0 ${sourceRect.width} ${sourceRect.height}"><rect width="100%" height="100%" fill="white"/>${holes}</svg>`
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  source.style.setProperty('mask-image', mask)
  source.style.setProperty('mask-size', `${sourceRect.width}px ${sourceRect.height}px`)
  source.style.setProperty('mask-repeat', 'no-repeat')
  source.style.setProperty('mask-position', '0 0')
  source.style.setProperty('mask-mode', 'luminance')
  source.style.setProperty('-webkit-mask-image', mask)
  source.style.setProperty('-webkit-mask-size', `${sourceRect.width}px ${sourceRect.height}px`)
  source.style.setProperty('-webkit-mask-repeat', 'no-repeat')
  source.style.setProperty('-webkit-mask-position', '0 0')
}

function registerProjectionHole(selector: string, source: HTMLElement, id: string, hole: ProjectionHole, sourceRect: DOMRect) {
  const state = ensureSourceMaskState(selector, source)
  state.holes.set(id, hole)
  applyCombinedSourceMask(state, sourceRect)
}

function unregisterProjectionHole(selector: string, id: string) {
  const state = sourceMaskStates.get(selector)
  if (!state) return
  state.holes.delete(id)
  if (!state.source) return
  applyCombinedSourceMask(state, state.source.getBoundingClientRect())
}

function addClassNames(element: HTMLElement, className?: string) {
  if (!className) return
  className.split(/\s+/).filter(Boolean).forEach((name) => element.classList.add(name))
}

function sourceContentStyle(source: HTMLElement): string {
  // The mask belongs to the projection, not to the message content. Observing
  // it as a content change makes sibling lenses invalidate each other's clone.
  return Array.from(source.style)
    .filter((property) => !maskProperties.includes(property))
    .map((property) => `${property}:${source.style.getPropertyValue(property)}!${source.style.getPropertyPriority(property)}`)
    .join(';')
}

export function LiquidBackdropProjection({
  className,
  sourceSelector = DEFAULT_CHAT_SOURCE_SELECTOR,
  cloneClassName = 'ready-liquid-composer__projection-clone',
  sourceMaskRadius,
}: LiquidBackdropProjectionProps) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const rawId = useId()
  const projectionId = `liquid-projection-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer) return

    let frame = 0
    let source: HTMLElement | null = null
    let clone: HTMLElement | null = null
    let contentDirty = true
    let geometryDirty = true
    let contentStyle = ''

    const syncScroll = () => {
      if (!source || !clone) return
      // Scroll events run before paint. An extra rAF here makes the glass lag
      // behind compositor scrolling, and rebuilding DOM forces layout again.
      clone.scrollTop = source.scrollTop
      clone.scrollLeft = source.scrollLeft
    }

    const renderProjection = () => {
      frame = 0
      const nextSource = document.querySelector<HTMLElement>(sourceSelector)
      if (nextSource !== source) {
        source?.removeEventListener('scroll', syncScroll)
        if (source) resizeObserver?.unobserve(source)
        observer.disconnect()
        unregisterProjectionHole(sourceSelector, projectionId)
        source = nextSource
        contentDirty = geometryDirty = true
        if (source) {
          source.addEventListener('scroll', syncScroll, { passive: true })
          observer.observe(source, { attributes: true, characterData: true, childList: true, subtree: true })
          resizeObserver?.observe(source)
          parentObserver.disconnect()
          if (source.parentElement) parentObserver.observe(source.parentElement, { childList: true })
        }
      }
      if (!source || !layer.isConnected) {
        layer.replaceChildren()
        clone = null
        unregisterProjectionHole(sourceSelector, projectionId)
        return
      }

      if (contentDirty || !clone) {
        clone = source.cloneNode(true) as HTMLElement
        clone.removeAttribute('id')
        clone.removeAttribute('data-liquid-scroll-root')
        clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'))
        clone.querySelectorAll('[data-liquid-scroll-root]').forEach((node) => node.removeAttribute('data-liquid-scroll-root'))
        clone.setAttribute('aria-hidden', 'true')
        clone.setAttribute('inert', '')
        addClassNames(clone, cloneClassName)
        clearMaskStyles(clone)
        layer.replaceChildren(clone)
        contentStyle = sourceContentStyle(source)
        contentDirty = false
        geometryDirty = true
      }

      if (geometryDirty) {
        const layerRect = layer.getBoundingClientRect()
        const sourceRect = source.getBoundingClientRect()
        Object.assign(clone.style, {
          position: 'absolute',
          left: `${sourceRect.left - layerRect.left}px`,
          top: `${sourceRect.top - layerRect.top}px`,
          width: `${sourceRect.width}px`,
          height: `${sourceRect.height}px`,
          margin: '0',
          pointerEvents: 'none',
        })
        const holeX = Math.max(0, layerRect.left - sourceRect.left)
        const holeY = Math.max(0, layerRect.top - sourceRect.top)
        const holeWidth = Math.max(0, Math.min(layerRect.right, sourceRect.right) - Math.max(layerRect.left, sourceRect.left))
        const holeHeight = Math.max(0, Math.min(layerRect.bottom, sourceRect.bottom) - Math.max(layerRect.top, sourceRect.top))
        const radius = Math.min(sourceMaskRadius ?? 18, holeWidth / 2, holeHeight / 2)
        registerProjectionHole(sourceSelector, source, projectionId, {
          x: holeX, y: holeY, width: holeWidth, height: holeHeight, radius,
        }, sourceRect)
        geometryDirty = false
      }
      syncScroll()
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(renderProjection)
    }
    const scheduleGeometry = () => {
      geometryDirty = true
      schedule()
    }
    const observer = new window.MutationObserver((mutations) => {
      const contentMutations = mutations.filter((mutation) => mutation.target !== source
        || mutation.type !== 'attributes' || mutation.attributeName !== 'style'
        || (source && sourceContentStyle(source) !== contentStyle))
      if (contentMutations.length === 0) return
      // Token streaming changes text nodes in place. Their child-index path is
      // stable until a structural mutation, which rebuilds the snapshot below.
      if (clone && !contentDirty && contentMutations.every((mutation) => mutation.type === 'characterData')) {
        for (const { target } of contentMutations) {
          const path: number[] = []
          let original: Node | null = target
          while (original && original !== source) {
            const parent: ParentNode | null = original.parentNode
            if (!parent) break
            path.push(Array.prototype.indexOf.call(parent.childNodes, original))
            original = parent
          }
          let mirrored: Node | undefined = clone
          for (const index of path.reverse()) mirrored = mirrored?.childNodes[index]
          if (original !== source || !mirrored || mirrored.nodeType !== target.nodeType) {
            contentDirty = true
            break
          }
          mirrored.textContent = target.textContent
        }
        if (!contentDirty) return
      }
      contentDirty = true
      schedule()
    })
    const parentObserver = new window.MutationObserver(scheduleGeometry)
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleGeometry) : null
    resizeObserver?.observe(layer)
    // A taller notice above the composer moves the tabs without resizing them.
    const overlay = layer.closest('.ready-chat-composer-overlay')
    if (overlay) resizeObserver?.observe(overlay)
    window.addEventListener('resize', scheduleGeometry)
    schedule()

    return () => {
      if (frame) cancelAnimationFrame(frame)
      source?.removeEventListener('scroll', syncScroll)
      observer.disconnect()
      parentObserver.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleGeometry)
      unregisterProjectionHole(sourceSelector, projectionId)
    }
  }, [cloneClassName, projectionId, sourceMaskRadius, sourceSelector])

  return <div ref={layerRef} aria-hidden="true" className={className} />
}
