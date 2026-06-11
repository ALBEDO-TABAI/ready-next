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
    let observer: MutationObserver | null = null
    let resizeObserver: ResizeObserver | null = null
    let source: HTMLElement | null = null

    const renderClone = () => {
      frame = 0
      source = document.querySelector<HTMLElement>(sourceSelector)
      if (!source || !layer.isConnected) {
        layer.replaceChildren()
        unregisterProjectionHole(sourceSelector, projectionId)
        return
      }

      const layerRect = layer.getBoundingClientRect()
      const sourceRect = source.getBoundingClientRect()
      const clone = source.cloneNode(true) as HTMLElement
      clone.removeAttribute('id')
      clone.removeAttribute('data-liquid-scroll-root')
      clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'))
      clone.querySelectorAll('[data-liquid-scroll-root]').forEach((node) => node.removeAttribute('data-liquid-scroll-root'))
      clone.setAttribute('aria-hidden', 'true')
      clone.setAttribute('inert', '')
      addClassNames(clone, cloneClassName)
      clearMaskStyles(clone)
      Object.assign(clone.style, {
        position: 'absolute',
        left: `${sourceRect.left - layerRect.left}px`,
        top: `${sourceRect.top - layerRect.top}px`,
        width: `${sourceRect.width}px`,
        height: `${sourceRect.height}px`,
        margin: '0',
        pointerEvents: 'none',
      })
      layer.replaceChildren(clone)
      clone.scrollTop = source.scrollTop
      clone.scrollLeft = source.scrollLeft

      const holeX = Math.max(0, layerRect.left - sourceRect.left)
      const holeY = Math.max(0, layerRect.top - sourceRect.top)
      const holeWidth = Math.max(0, Math.min(layerRect.width, sourceRect.right - layerRect.left))
      const holeHeight = Math.max(0, Math.min(layerRect.height, sourceRect.bottom - layerRect.top))
      const radius = Math.min(sourceMaskRadius ?? 18, holeWidth / 2, holeHeight / 2)
      registerProjectionHole(sourceSelector, source, projectionId, {
        x: holeX,
        y: holeY,
        width: holeWidth,
        height: holeHeight,
        radius,
      }, sourceRect)
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(renderClone)
    }

    source = document.querySelector<HTMLElement>(sourceSelector)
    source?.addEventListener('scroll', schedule, { passive: true })
    if (source) {
      observer = new MutationObserver(schedule)
      observer.observe(source, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      })
    }
    resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    if (source) resizeObserver?.observe(source)
    resizeObserver?.observe(layer)
    window.addEventListener('resize', schedule)
    schedule()

    return () => {
      if (frame) cancelAnimationFrame(frame)
      source?.removeEventListener('scroll', schedule)
      observer?.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      unregisterProjectionHole(sourceSelector, projectionId)
    }
  }, [cloneClassName, projectionId, sourceMaskRadius, sourceSelector])

  return <div ref={layerRef} aria-hidden="true" className={className} />
}
