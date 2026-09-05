/**
 * DocumentBookStage.tsx — 书本舞台。
 *
 * 组合：vignette 背景、深色封面框、前切口纸堆、静态对开页（PageFace）、
 * 落影层（applyShadows 经 ref 逐帧直写）、Leaf 宿主（后翻经 scaleX(-1) 镜像）、
 * 封面（合起态/翻页克隆源）、指针热区（预热/拖拽/点击 → 归一化坐标回调）。
 * 所有逐帧视觉更新都走 ref 直写，不经过 React 渲染。
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'
import type { PreviewBlock, PreviewEmbed } from '../note-preview-parser'
import type { DocumentWidgetData } from '../../../../shared/document-widget-parse'
import {
  resolveBookStagePerspective,
  resolveBookStacks,
  type BookPageGeometry,
} from '../../../modules/document/book/bookGeometry'
import {
  BOOK_TITLE_PAGE,
  spreadAt,
  type BookPageModel,
  type BookSpread,
} from '../../../modules/document/book/bookPagination'
import type { CurlFrame } from '../../../modules/document/book/bookCurlMath'
import {
  resolveDirectedPageX,
  type BookFlipDirection,
} from '../../../modules/document/book/bookFlipController'
import type { BookLeafHandle } from './DocumentBookLeaf'
import DocumentBookLeaf from './DocumentBookLeaf'
import DocumentBookPageFace from './DocumentBookPageFace'

export interface BookStageHandle {
  applyShadows: (frame: CurlFrame, direction: BookFlipDirection, visible: boolean) => void
  getCoverElement: () => HTMLElement | null
}

export interface StagePointerHandlers {
  onPrewarm: (direction: BookFlipDirection) => void
  onPress: (direction: BookFlipDirection, nx: number, ny: number) => boolean
  onDrag: (nx: number, ny: number) => void
  onRelease: (direction: BookFlipDirection) => void
  onCancel: () => void
  onTap: (direction: BookFlipDirection, nx: number, ny: number) => void
}

interface PageLocalPoint {
  side: 'left' | 'right'
  nx: number
  ny: number
}

export interface DocumentBookStageProps {
  geometry: BookPageGeometry
  model: BookPageModel
  blocks: PreviewBlock[]
  embedsById: Map<string, PreviewEmbed>
  widgetsById: Map<string, DocumentWidgetData>
  spread: BookSpread
  spreadCount: number
  coverClosed: boolean
  /** 封面叶片翻页中：隐藏静态封面（叶片克隆体在演） */
  hideStaticCover: boolean
  /** 翻页方向侧的上层静态页在叶片真正抬起后隐藏 */
  hiddenSide: 'left' | 'right' | null
  /** 封面叶片真正翻起：封面下预渲染首个对开 */
  coverLifting: boolean
  docTitle: string
  docSubtitle: string
  leafMirrored: boolean
  sliceCount: number
  reducedMotion: boolean
  handlers: StagePointerHandlers
  canFlip: (direction: BookFlipDirection) => boolean
  leafRef: React.Ref<BookLeafHandle>
  registerPageEl: (pageIndex: number, el: HTMLElement | null) => void
}

const TAP_MAX_DISTANCE_PX = 6
const TAP_MAX_DURATION_MS = 350

interface StageDragState {
  pointerId: number
  x: number
  y: number
  at: number
  direction: BookFlipDirection
  pressNx: number
  pressNy: number
  started: boolean
  rejected: boolean
}

const DocumentBookStage = forwardRef<BookStageHandle, DocumentBookStageProps>(function DocumentBookStage(
  props,
  ref,
) {
  const {
    geometry,
    model,
    blocks,
    embedsById,
    widgetsById,
    spread,
    spreadCount,
    coverClosed,
    hideStaticCover,
    hiddenSide,
    coverLifting,
    docTitle,
    docSubtitle,
    leafMirrored,
    sliceCount,
    reducedMotion,
    handlers,
    canFlip,
    leafRef,
    registerPageEl,
  } = props

  const bookRef = useRef<HTMLDivElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const bandLeftRef = useRef<HTMLDivElement>(null)
  const bandRightRef = useRef<HTMLDivElement>(null)
  const gutterLeftRef = useRef<HTMLDivElement>(null)
  const gutterRightRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<StageDragState | null>(null)
  const stackLeftRef = useRef<HTMLDivElement>(null)
  const stackRightRef = useRef<HTMLDivElement>(null)

  const { pageWidth: W, pageHeight: H, stackMaxPx } = geometry
  const stacks = resolveBookStacks(model.pageCount, spread.index, stackMaxPx)
  const stackStateRef = useRef({ pageCount: model.pageCount, spreadIndex: spread.index, stackMaxPx, coverClosed })
  stackStateRef.current = { pageCount: model.pageCount, spreadIndex: spread.index, stackMaxPx, coverClosed }

  // 离屏克隆源：Leaf 的正/背面内容取自静态页 inner 元素。
  // 合起封面时保活扉页；展开时保活「下一对开左页 / 前一对开右页」。
  const offstagePages: Array<{ pageIndex: number; side: 'left' | 'right' }> = []
  if (coverClosed) {
    offstagePages.push({ pageIndex: BOOK_TITLE_PAGE, side: 'left' })
  } else {
    if (spread.index + 1 < spreadCount) {
      const next = spreadAt(spread.index + 1, model.pageCount)
      if (next.left !== null) offstagePages.push({ pageIndex: next.left, side: 'left' })
    }
    if (spread.index >= 1) {
      const prev = spreadAt(spread.index - 1, model.pageCount)
      if (prev.right !== null) offstagePages.push({ pageIndex: prev.right, side: 'right' })
    }
  }

  const pointFromEvent = useCallback((event: React.PointerEvent): PageLocalPoint | null => {
    // 以书脊为原点的归一化坐标：书脊=0，右页为正、左页取距脊距离（=后翻镜像坐标）。
    // 只用书框 rect（恒挂载/不离屏），不依赖静态页或封面元素（封面翻页中会离屏）。
    const book = bookRef.current
    if (!book) return null
    const rect = book.getBoundingClientRect()
    const spineX = rect.left + rect.width / 2
    const px = event.clientX - spineX
    const ny = Math.min(Math.max((event.clientY - rect.top) / H, 0), 1)
    if (coverClosed || px >= 0) {
      return { side: 'right', nx: Math.min(Math.max(px, 0), W), ny }
    }
    return { side: 'left', nx: Math.min(Math.max(-px, 0), W), ny }
  }, [H, W, coverClosed])

  const isInCorner = useCallback((point: PageLocalPoint): boolean => {
    // 页角热区：页宽 28% × 页高 22%，只用于空闲预热相邻页。
    const hotW = W * 0.28
    const hotH = H * 0.22
    if (point.nx < W - hotW) return false
    const cornerY = point.ny < 0.5 ? 0 : 1
    return Math.abs(point.ny - cornerY) * H <= hotH
  }, [H, W])

  const directionForSide = useCallback((side: 'left' | 'right'): BookFlipDirection => (
    coverClosed || side === 'right' ? 'forward' : 'backward'
  ), [coverClosed])

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return
    const point = pointFromEvent(event)
    if (!point) return
    const direction = directionForSide(point.side)
    if (!canFlip(direction)) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 合成指针（探针/自动化）无活跃捕获目标；真实指针不会走到这里
    }
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
      direction,
      pressNx: point.nx,
      pressNy: point.ny,
      started: false,
      rejected: false,
    }
  }, [canFlip, directionForSide, pointFromEvent])

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (drag && drag.pointerId === event.pointerId) {
      if (drag.rejected) return
      const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
      if (!drag.started && distance <= TAP_MAX_DISTANCE_PX) {
        return
      }
      const book = bookRef.current
      if (book) {
        const rect = book.getBoundingClientRect()
        const spineX = rect.left + rect.width / 2
        const nx = resolveDirectedPageX(event.clientX, spineX, drag.direction)
        const ny = Math.min(Math.max((event.clientY - rect.top) / H, 0), 1)
        if (!drag.started) {
          drag.started = handlers.onPress(drag.direction, drag.pressNx, drag.pressNy)
          if (!drag.started) {
            drag.rejected = true
            return
          }
        }
        handlers.onDrag(nx, ny)
      }
      return
    }
    const point = pointFromEvent(event)
    if (!point) return
    const direction = directionForSide(point.side)
    if (isInCorner(point) && canFlip(direction)) handlers.onPrewarm(direction)
  }, [H, canFlip, directionForSide, handlers, isInCorner, pointFromEvent])

  const handlePointerUp = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y)
    const elapsed = performance.now() - drag.at
    if (!drag.started && distance <= TAP_MAX_DISTANCE_PX && elapsed <= TAP_MAX_DURATION_MS) {
      handlers.onTap(drag.direction, drag.pressNx, drag.pressNy)
    } else if (drag.started) {
      handlers.onRelease(drag.direction)
    }
  }, [handlers])

  const cancelActivePointer = useCallback((pointerId?: number) => {
    const drag = dragRef.current
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return
    dragRef.current = null
    if (drag.started) handlers.onCancel()
  }, [handlers])

  const handlePointerCancel = useCallback((event: React.PointerEvent) => {
    cancelActivePointer(event.pointerId)
  }, [cancelActivePointer])

  useEffect(() => {
    const handleWindowBlur = () => cancelActivePointer()
    window.addEventListener('blur', handleWindowBlur)
    return () => window.removeEventListener('blur', handleWindowBlur)
  }, [cancelActivePointer])

  const shadowHandle = useMemo<BookStageHandle>(() => ({
    applyShadows: (frame, direction, visible) => {
      const state = stackStateRef.current
      const movingIndex = state.spreadIndex + (visible && !state.coverClosed ? frame.progress * (direction === 'forward' ? 1 : -1) : 0)
      const thickness = resolveBookStacks(state.pageCount, movingIndex, state.stackMaxPx)
      if (stackLeftRef.current) stackLeftRef.current.style.transform = `scaleX(${thickness.left / state.stackMaxPx})`
      if (stackRightRef.current) stackRightRef.current.style.transform = `scaleX(${thickness.right / state.stackMaxPx})`
      const revealedSide = direction === 'forward' ? 'right' : 'left'
      const revealedBand = revealedSide === 'right' ? bandRightRef.current : bandLeftRef.current
      const oppositeBand = revealedSide === 'right' ? bandLeftRef.current : bandRightRef.current
      const revealedGutter = revealedSide === 'right' ? gutterRightRef.current : gutterLeftRef.current
      const oppositeGutter = revealedSide === 'right' ? gutterLeftRef.current : gutterRightRef.current
      const bands: Array<[HTMLDivElement | null, number, number, number]> = [
        [revealedBand, frame.revealedShadow.centerX, frame.revealedShadow.width, visible ? frame.revealedShadow.opacity : 0],
        [oppositeBand, frame.oppositeShadow.centerX, frame.oppositeShadow.width, visible ? frame.oppositeShadow.opacity : 0],
      ]
      for (const [el, centerX, width, opacity] of bands) {
        if (!el) continue
        el.style.opacity = opacity.toFixed(3)
        const offset = centerX - width / 2
        el.style.transform = `translateX(${el === bandLeftRef.current ? -offset : offset}px) scaleX(${Math.max(8, width) / 100})`
      }
      if (revealedGutter) {
        revealedGutter.style.opacity = (visible ? frame.revealedShadow.gutterShade : 0).toFixed(3)
      }
      if (oppositeGutter) oppositeGutter.style.opacity = '0'
    },
    getCoverElement: () => coverRef.current,
  }), [])
  useImperativeHandle(ref, () => shadowHandle, [shadowHandle])

  const renderFace = (side: 'left' | 'right', pageIndex: number | null) => {
    const page = pageIndex !== null && pageIndex >= 0 ? model.pages[pageIndex] ?? null : null
    return (
      <DocumentBookPageFace
        side={side}
        pageIndex={pageIndex}
        page={page}
        blocks={blocks}
        embedsById={embedsById}
        widgetsById={widgetsById}
        docTitle={docTitle}
        docSubtitle={docSubtitle}
        contentWidth={model.contentWidth}
        contentHeight={model.contentHeight}
        onInnerElement={registerPageEl}
      />
    )
  }

  const renderSide = (side: 'left' | 'right') => {
    const topPage = side === 'left' ? spread.left : spread.right
    // 物理真值的双层静态页：下层=被揭开页（右侧=下一对开右页，左侧=前一对开左页），
    // 上层=当前页。叶片真正抬起后隐藏上层（叶片克隆体同像素接管），下层自然显露——零重挂载。
    const underPage = side === 'left'
      ? (spread.index > 0 ? spreadAt(spread.index - 1, model.pageCount).left : null)
      : (spread.index + 1 < spreadCount ? spreadAt(spread.index + 1, model.pageCount).right : null)
    const topHidden = hiddenSide === side
    return (
      <div className={`document-book-stage__page document-book-stage__page--${side}`}>
        <div className="document-book-stage__page-under" aria-hidden inert>
          {renderFace(side, underPage)}
        </div>
        <div
          className="document-book-stage__page-top"
          style={topHidden ? { visibility: 'hidden' } : undefined}
          aria-hidden={topHidden || undefined}
          inert={topHidden || undefined}
        >
          {renderFace(side, topPage)}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`document-book-stage${reducedMotion ? ' is-reduced-motion' : ''}`}
      // 固定短透视会把向镜头拱起的大页片光学放宽，落定时再缩回。
      // 保持至少 12 倍单页宽，使不同窗口尺寸下都接近正投影，同时保留曲面深度。
      style={{ perspective: resolveBookStagePerspective(W) }}
    >
      <div
        className={`document-book-stage__book${coverClosed ? ' is-cover-closed' : ''}`}
        ref={bookRef}
        style={{
          width: W * 2,
          height: H,
          transform: coverClosed ? `translateX(${-W / 2}px)` : 'translateX(0px)',
          ['--book-pad-inner' as string]: `${geometry.paddingInner}px`,
          ['--book-pad-outer' as string]: `${geometry.paddingOuter}px`,
          ['--book-pad-top' as string]: `${geometry.paddingTop}px`,
          ['--book-pad-bottom' as string]: `${geometry.paddingBottom}px`,
          ['--book-stack-left' as string]: `${stacks.left}px`,
          ['--book-stack-right' as string]: `${stacks.right}px`,
        }}
      >
        <div className="document-book-stage__book-shadow" aria-hidden />
        <div className="document-book-stage__cover-frame" aria-hidden />
        <div
          className="document-book-stage__stack document-book-stage__stack--left"
          ref={stackLeftRef}
          style={{ width: stackMaxPx, transform: `scaleX(${stacks.left / stackMaxPx})` }}
          aria-hidden
        />
        <div
          className="document-book-stage__stack document-book-stage__stack--right"
          ref={stackRightRef}
          style={{ width: stackMaxPx, transform: `scaleX(${stacks.right / stackMaxPx})` }}
          aria-hidden
        />

        {!coverClosed || coverLifting ? (
          <>
            {renderSide('left')}
            {renderSide('right')}
            <div className="document-book-stage__page-shadows document-book-stage__page-shadows--left" aria-hidden>
              <div className="document-book-stage__shade-band document-book-stage__shade-band--left" ref={bandLeftRef} />
              <div className="document-book-stage__shade-gutter document-book-stage__shade-gutter--left" ref={gutterLeftRef} />
            </div>
            <div className="document-book-stage__page-shadows document-book-stage__page-shadows--right" aria-hidden>
              <div className="document-book-stage__shade-band document-book-stage__shade-band--right" ref={bandRightRef} />
              <div className="document-book-stage__shade-gutter document-book-stage__shade-gutter--right" ref={gutterRightRef} />
            </div>
          </>
        ) : null}

        <div className={`document-book-stage__leaf${leafMirrored ? ' is-mirrored' : ''}`} aria-hidden inert>
          <DocumentBookLeaf
            ref={leafRef}
            spec={{ slices: sliceCount, pageWidth: W, pageHeight: H }}
            mirrored={leafMirrored}
          />
        </div>
        <div
          className={`document-book-cover${coverClosed && !hideStaticCover ? ' is-closed' : ' is-offstage'}`}
          ref={coverRef}
        >
          <div className="document-book-cover__hinge" aria-hidden />
          <div className="document-book-cover__frame">
            <div className="document-book-cover__title">{docTitle}</div>
            <div className="document-book-cover__rule" aria-hidden />
          </div>
        </div>

        {(['left', 'right'] as const).map((side) => (
          <div
            className={`document-book-stage__hot document-book-stage__hot--${side}${coverClosed && side === 'right' ? ' is-cover' : ''}`}
            key={side}
            aria-hidden
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
          />
        ))}
      </div>

      {/* 离屏克隆源（Leaf 正/背面取内容处） */}
      {offstagePages.map((entry) => (
        <div
          className="document-book-offstage"
          aria-hidden
          inert
          key={entry.pageIndex}
          style={{ width: W, height: H }}
        >
          <DocumentBookPageFace
            side={entry.side}
            pageIndex={entry.pageIndex}
            page={entry.pageIndex >= 0 ? model.pages[entry.pageIndex] ?? null : null}
            blocks={blocks}
            embedsById={embedsById}
            widgetsById={widgetsById}
            docTitle={docTitle}
            docSubtitle={docSubtitle}
            contentWidth={model.contentWidth}
            contentHeight={model.contentHeight}
            onInnerElement={registerPageEl}
          />
        </div>
      ))}
    </div>
  )
})

export default memo(DocumentBookStage)
