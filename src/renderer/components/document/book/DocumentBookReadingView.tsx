/**
 * DocumentBookReadingView.tsx — 阅读模式根视图。
 *
 * 职责：内容解析（buildStructuredNotePreview）→ 隐藏测量器分页 → 页模型；
 * 翻页控制器编排（拖拽/脚本翻页同一轨道）；封面开合；位置持久化；
 * 字号偏好重排（锚点保持）；Esc/键盘；胶囊条显隐。
 * 逐帧翻页视觉全部经 ref 直写（Leaf.apply / Stage.applyShadows），不经 React。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import type { DocTab } from '../../../stores/useDocTabs'
import { buildStructuredNotePreview } from '../note-preview-parser'
import type { PreviewEmbed } from '../note-preview-parser'
import type { DocumentWidgetData } from '../../../../shared/document-widget-parse'
import { buildCurlFrame } from '../../../modules/document/book/bookCurlMath'
import {
  createBookFlipController,
  resolveBookKeyboardAction,
  type BookFlipController,
  type BookFlipDirection,
  type BookFlipFrameState,
  type BookFlipSettleResult,
} from '../../../modules/document/book/bookFlipController'
import {
  BOOK_TITLE_PAGE,
  buildBookPageModel,
  measureBookBlocks,
  resolveFlipSheet,
  spreadAt,
  spreadCountForPages,
  spreadForPage,
  type BookPageModel,
} from '../../../modules/document/book/bookPagination'
import { resolveBookGeometry } from '../../../modules/document/book/bookGeometry'
import { BookImageContext, prepareBookImages, type BookImageSize } from '../../../modules/document/book/bookImageLayout'
import {
  loadBookReadingPreferences,
  saveBookReadingPreferences,
  type BookReadingPreferences,
} from '../../../modules/document/book/bookReadingPreferences'
import {
  resolveBookPageForPosition,
  saveBookReadingPosition,
  sourceLineForCharOffset,
} from '../../../modules/document/book/bookReadingPosition'
import {
  resolveBookLeafTakeoverPolicy,
  settleBookPointerRelease,
} from '../../../modules/document/book/bookMotionPolicy'
import DocumentBookStage, { type BookStageHandle, type StagePointerHandlers } from './DocumentBookStage'
import DocumentBookControls from './DocumentBookControls'
import DocumentBookBlock from './DocumentBookBlock'
import type { BookLeafHandle } from './DocumentBookLeaf'
import { loadDocumentReadingPosition, type DocumentScrollAnchorSnapshot } from '../../../modules/document/documentScrollAnchor'

const CONTROLS_IDLE_HIDE_MS = 2600

interface ArmedLeafIdentity {
  model: BookPageModel
  key: string
}

export interface DocumentBookReadingViewProps {
  tab: DocTab
  isSceneVisible: boolean
  onExit: () => void
  initialPosition?: DocumentScrollAnchorSnapshot | null
  onPositionChange?: (key: string, position: DocumentScrollAnchorSnapshot) => void
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const useBookReducedMotion = () => {
  const [reduced, setReduced] = useState(() => (
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  ))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return reduced
}

export default function DocumentBookReadingView({
  tab,
  isSceneVisible,
  onExit,
  initialPosition,
  onPositionChange,
}: DocumentBookReadingViewProps) {
  const reducedMotion = useBookReducedMotion()
  const [prefs, setPrefs] = useState<BookReadingPreferences>(() => loadBookReadingPreferences())
  const [model, setModel] = useState<BookPageModel | null>(null)
  const [spreadIndex, setSpreadIndex] = useState(0)
  const [coverClosed, setCoverClosed] = useState(true)
  const [leafDirection, setLeafDirection] = useState<BookFlipDirection>('forward')
  const [coverLeafActive, setCoverLeafActive] = useState(false)
  /** 翻页真正抬起后，由活动叶片接管的静态页侧 */
  const [hiddenSide, setHiddenSide] = useState<'left' | 'right' | null>(null)
  /** 封面叶片真正翻起：封面下预渲染首个对开 */
  const [coverLifting, setCoverLifting] = useState(false)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [measurerActive, setMeasurerActive] = useState(true)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [typesetOpen, setTypesetOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const measurerRef = useRef<HTMLDivElement>(null)
  const leafRef = useRef<BookLeafHandle>(null)
  const stageRef = useRef<BookStageHandle>(null)
  const pageElsRef = useRef(new Map<number, HTMLElement>())
  const controllerRef = useRef<BookFlipController | null>(null)
  const armedRigidRef = useRef(false)
  const armedSideRef = useRef<'left' | 'right' | null>(null)
  const armedLeafIdentityRef = useRef<ArmedLeafIdentity | null>(null)
  const hiddenSideRef = useRef<'left' | 'right' | null>(null)
  const hideCoverRef = useRef(false)
  const coverLiftingRef = useRef(false)
  const restoredRef = useRef(false)
  const [entryPosition] = useState(() => initialPosition === undefined ? loadDocumentReadingPosition(tab.path || tab.id) : initialPosition)
  const positionRef = useRef(entryPosition)
  const positionSpreadRef = useRef<number | null>(null)
  const controlsIdleRef = useRef(0)
  const controlsPinnedRef = useRef(false)
  const idleArmCancelRef = useRef<(() => void) | null>(null)

  const registerPageElement = useCallback((pageIndex: number, element: HTMLElement | null) => {
    if (element) pageElsRef.current.set(pageIndex, element)
    else pageElsRef.current.delete(pageIndex)
  }, [])

  const content = tab.content
  const positionKey = tab.path || tab.id

  const preview = useMemo(() => buildStructuredNotePreview(content, tab.path), [content, tab.path])
  const blocks = preview.blocks
  const [imageAssets, setImageAssets] = useState<{
    blocks: typeof blocks
    sizes: Map<string, BookImageSize>
  } | null>(null)
  const embedsById = useMemo(
    () => new Map<string, PreviewEmbed>(preview.embeds.map((embed) => [embed.id, embed])),
    [preview.embeds],
  )
  const widgetsById = useMemo(
    () => new Map<string, DocumentWidgetData>(preview.widgets.map((widget) => [widget.id || '', widget])),
    [preview.widgets],
  )

  const geometry = useMemo(
    () => resolveBookGeometry(stageSize.width, stageSize.height, prefs.margin),
    [prefs.margin, stageSize],
  )
  const imageContext = useMemo(() => ({
    contentWidth: geometry.contentWidth,
    contentHeight: geometry.contentHeight,
    fontSize: prefs.fontSize,
    notePath: tab.path,
    sizes: imageAssets?.blocks === blocks ? imageAssets.sizes : new Map<string, BookImageSize>(),
  }), [blocks, geometry.contentWidth, geometry.contentHeight, imageAssets, prefs.fontSize, tab.path])
  const renderPixelRatio = typeof window === 'undefined'
    ? 1
    : Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const sliceCount = Math.min(18, Math.max(16, Math.ceil((geometry.pageWidth * renderPixelRatio) / 32)))
  const pageCount = model?.pageCount ?? 0
  const spreadCount = spreadCountForPages(pageCount)
  const safeSpreadIndex = clamp(spreadIndex, 0, Math.max(0, spreadCount - 1))
  const spread = spreadAt(safeSpreadIndex, pageCount)

  // 控制器回调读最新运行态，避免闭包过期
  const runtimeRef = useRef({
    model, spreadIndex: safeSpreadIndex, coverClosed, geometry, sliceCount, content,
    key: positionKey, reducedMotion, blocks, isSceneVisible,
  })
  runtimeRef.current = {
    model, spreadIndex: safeSpreadIndex, coverClosed, geometry, sliceCount, content,
    key: positionKey, reducedMotion, blocks, isSceneVisible,
  }

  const savePosition = useCallback(() => {
    const rt = runtimeRef.current
    if (!rt.model || !restoredRef.current || rt.coverClosed) return
    // 进入后未翻页时保留原段落，避免反复切换向页首漂移。
    if (positionSpreadRef.current === rt.spreadIndex) return
    const current = spreadAt(rt.spreadIndex, rt.model.pageCount)
    const currentPage = current.left !== null && current.left >= 0 ? current.left : current.right ?? 0
    const entry = rt.model.pages[currentPage]?.entries[0]
    const start = entry ? rt.blocks[entry.blockIdx]?.source?.start : undefined
    const blockPages = entry ? rt.model.pages.filter(page => page.entries.some(item => item.blockIdx === entry.blockIdx)) : []
    const snapshot = saveBookReadingPosition({
      key: rt.key,
      content: rt.content,
      pageIndex: currentPage,
      pageCount: rt.model.pageCount,
      anchorLine: typeof start === 'number' ? sourceLineForCharOffset(rt.content, start) : null,
      sourceProgress: entry && blockPages.length ? entry.columnIndex / blockPages.length : 0,
    })
    if (snapshot) {
      positionRef.current = snapshot
      positionSpreadRef.current = rt.spreadIndex
      onPositionChange?.(rt.key, snapshot)
    }
  }, [onPositionChange])

  const armFor = useCallback((direction: BookFlipDirection): boolean => {
    const rt = runtimeRef.current
    if (!rt.model || rt.reducedMotion || !rt.isSceneVisible) return false
    const leaf = leafRef.current
    if (!leaf) return false
    let identityKey = ''
    let frontSource: HTMLElement | null = null
    let backSource: HTMLElement | null = null
    let rigid = false
    let armedSide: 'left' | 'right' | null = null
    if (rt.coverClosed && direction === 'forward') {
      const cover = stageRef.current?.getCoverElement()
      const title = pageElsRef.current.get(BOOK_TITLE_PAGE)
      if (!cover || !title) return false
      identityKey = `cover-open:${rt.key}`
      frontSource = cover
      backSource = title
      rigid = true
    } else if (!rt.coverClosed && rt.spreadIndex === 0 && direction === 'backward') {
      const cover = stageRef.current?.getCoverElement()
      const title = pageElsRef.current.get(BOOK_TITLE_PAGE)
      if (!cover || !title) return false
      identityKey = `cover-close:${rt.key}`
      frontSource = title
      backSource = cover
      rigid = true
      armedSide = 'left'
    } else {
      const sheet = resolveFlipSheet(rt.spreadIndex, rt.model.pageCount, direction)
      if (!sheet || sheet.front === null) return false
      identityKey = `page:${rt.spreadIndex}:${direction}:${sheet.front}:${sheet.back ?? 'blank'}`
      frontSource = pageElsRef.current.get(sheet.front) ?? null
      backSource = sheet.back !== null ? pageElsRef.current.get(sheet.back) ?? null : null
      if (!frontSource) return false
      armedSide = direction === 'forward' ? 'right' : 'left'
    }
    const armed = armedLeafIdentityRef.current
    if (!armed || armed.model !== rt.model || armed.key !== identityKey) {
      leaf.arm({ frontSource, backSource, rigid })
      armedLeafIdentityRef.current = { model: rt.model, key: identityKey }
    }
    armedRigidRef.current = rigid
    armedSideRef.current = armedSide
    setLeafDirection(direction)
    return true
  }, [])

  const scheduleIdleArm = useCallback(() => {
    idleArmCancelRef.current?.()
    const run = () => {
      idleArmCancelRef.current = null
      if (!controllerRef.current?.isAnimating()) armFor('forward')
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run)
      idleArmCancelRef.current = () => window.cancelIdleCallback(id)
    } else {
      const id = window.setTimeout(run, 32)
      idleArmCancelRef.current = () => window.clearTimeout(id)
    }
  }, [armFor])

  const handleControllerFrame = useCallback((state: BookFlipFrameState) => {
    const rt = runtimeRef.current
    const frame = buildCurlFrame(
      { slices: rt.sliceCount, pageWidth: rt.geometry.pageWidth, pageHeight: rt.geometry.pageHeight },
      { theta: state.theta, skew: state.skew, velocity: state.velocity },
    )
    const takeover = resolveBookLeafTakeoverPolicy({
      reducedMotion: rt.reducedMotion,
      active: state.active,
      theta: state.theta,
      direction: state.direction,
      armedSide: armedSideRef.current,
      armedRigid: armedRigidRef.current,
      coverClosed: rt.coverClosed,
    })
    // 静态封面只在「封面叶片真正翻起」时隐藏；armed 或 Θ≈0 不隐藏
    // （指针坐标以书框 rect 计算，但起翻瞬间仍需要静态封面与叶片克隆无缝重叠）
    const nextHiddenSide = takeover.hiddenSide
    if (hiddenSideRef.current !== nextHiddenSide) {
      hiddenSideRef.current = nextHiddenSide
      setHiddenSide(nextHiddenSide)
    }
    const hideCover = takeover.hideCover
    if (hideCoverRef.current !== hideCover) {
      hideCoverRef.current = hideCover
      setCoverLeafActive(hideCover)
    }
    const lifting = takeover.coverLifting
    if (coverLiftingRef.current !== lifting) {
      coverLiftingRef.current = lifting
      setCoverLifting(lifting)
    }
    leafRef.current?.apply({ frame, theta: state.theta, visible: takeover.visible })
    stageRef.current?.applyShadows(frame, state.direction, takeover.shadowsVisible)
  }, [])

  const handleControllerSettle = useCallback((result: BookFlipSettleResult) => {
    const rt = runtimeRef.current
    // 控制器会在本回调返回后隐藏活动叶片；这里必须先同步换好静态页，避免旧页闪回一帧。
    flushSync(() => {
      armedRigidRef.current = false
      armedSideRef.current = null
      armedLeafIdentityRef.current = null
      hiddenSideRef.current = null
      hideCoverRef.current = false
      coverLiftingRef.current = false
      setCoverLeafActive(false)
      setCoverLifting(false)
      setHiddenSide(null)
      if (result.committed) {
        if (rt.coverClosed && result.direction === 'forward') {
          setCoverClosed(false)
        } else if (!rt.coverClosed && rt.spreadIndex === 0 && result.direction === 'backward') {
          setCoverClosed(true)
        } else {
          setSpreadIndex((current) => clamp(
            current + (result.direction === 'forward' ? 1 : -1),
            0,
            Math.max(0, spreadCountForPages(rt.model?.pageCount ?? 0) - 1),
          ))
        }
      }
    })
    scheduleIdleArm()
  }, [scheduleIdleArm])

  if (!controllerRef.current) {
    controllerRef.current = createBookFlipController({
      now: () => performance.now(),
      raf: (cb) => requestAnimationFrame(() => cb()),
      cancelRaf: (id) => cancelAnimationFrame(id),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      pageWidth: () => runtimeRef.current.geometry.pageWidth,
      pageHeight: () => runtimeRef.current.geometry.pageHeight,
      onFrame: handleControllerFrame,
      onSettle: handleControllerSettle,
    })
  }

  const canFlip = useCallback((direction: BookFlipDirection): boolean => {
    const rt = runtimeRef.current
    if (!rt.model) return false
    if (rt.coverClosed) return direction === 'forward'
    if (direction === 'backward' && rt.spreadIndex === 0) return true
    const sheet = resolveFlipSheet(rt.spreadIndex, rt.model.pageCount, direction)
    return !!sheet && sheet.front !== null
  }, [])

  const instantJump = useCallback((direction: BookFlipDirection) => {
    const rt = runtimeRef.current
    if (!rt.model) return
    if (rt.coverClosed && direction === 'forward') {
      setCoverClosed(false)
      return
    }
    if (!rt.coverClosed && rt.spreadIndex === 0 && direction === 'backward') {
      setCoverClosed(true)
      return
    }
    setSpreadIndex((current) => clamp(
      current + (direction === 'forward' ? 1 : -1),
      0,
      Math.max(0, spreadCountForPages(rt.model?.pageCount ?? 0) - 1),
    ))
  }, [])

  const handlers = useMemo<StagePointerHandlers>(() => ({
    // 悬停页角时只在不可见状态预武装对应方向；不抬页、不露切片，
    // 但首次后翻也不再把 cloneNode/排版成本压到 pointerdown 上。
    onPrewarm: (direction) => { if (!controllerRef.current?.isAnimating()) armFor(direction) },
    onPress: (direction, nx, ny) => {
      if (runtimeRef.current.reducedMotion) return true
      const state = controllerRef.current?.getState()
      if (state?.phase === 'settling' && state.direction !== direction) return false
      if (!armFor(direction)) return false
      controllerRef.current?.press(direction, nx, ny)
      return true
    },
    onDrag: (nx, ny) => controllerRef.current?.move(nx, ny),
    onRelease: (direction) => {
      const isReduced = runtimeRef.current.reducedMotion
      if (isReduced) {
        armedRigidRef.current = false
        armedSideRef.current = null
        armedLeafIdentityRef.current = null
      }
      settleBookPointerRelease(isReduced, direction, controllerRef.current, instantJump)
    },
    onCancel: () => controllerRef.current?.cancel(),
    onTap: (direction, nx, ny) => {
      if (runtimeRef.current.reducedMotion) {
        instantJump(direction)
        return
      }
      const state = controllerRef.current?.getState()
      if (state?.phase === 'settling') return
      if (state?.phase !== 'dragging') {
        if (!armFor(direction)) return
        controllerRef.current?.press(direction, nx, ny)
      }
      controllerRef.current?.flipTo(direction)
    },
  }), [armFor, instantJump])

  // 只在首测或布局真值变化时挂载完整测量树；翻页期间常驻它会让数千个
  // 离屏节点参与每一帧的样式与布局计算。
  useLayoutEffect(() => {
    if (!isSceneVisible || stageSize.width === 0) return
    // 排版/窗口尺寸变化先取消半页；旧曲面不能套用新纸宽或新正文。
    if (controllerRef.current?.isAnimating()) controllerRef.current.cancel()
    idleArmCancelRef.current?.()
    idleArmCancelRef.current = null
    armedLeafIdentityRef.current = null
    leafRef.current?.clear()
    setMeasurerActive(true)
  }, [
    blocks,
    geometry.contentWidth,
    geometry.contentHeight,
    prefs.fontSize,
    prefs.lineHeight,
    isSceneVisible,
    positionKey,
    stageSize.width,
  ])

  // --- 测量与分页 ---
  useLayoutEffect(() => {
    if (!measurerActive || !isSceneVisible || stageSize.width === 0) return undefined
    const flow = measurerRef.current
    if (!flow) return undefined
    // 离屏图片不能 lazy；取得尺寸后先让测量与显示共用的图片组件提交，再读分栏。
    if (imageAssets?.blocks !== blocks) {
      const controller = new AbortController()
      void prepareBookImages(flow, controller.signal).then(sizes => {
        if (sizes && !controller.signal.aborted) setImageAssets({ blocks, sizes })
      })
      return () => controller.abort()
    }
    // 同步测量：测量器已完成布局，getClientRects 只读一次；
    // 超大文档让到下一帧，避免阻塞输入。
    const runMeasure = () => {
      const flow = measurerRef.current
      if (!flow) return
      const measures = measureBookBlocks(flow)
      const nextModel = buildBookPageModel(measures, geometry.contentWidth, geometry.contentHeight)
      setModel(nextModel)
      setMeasurerActive(false)
      const nextSpread = spreadForPage(resolveBookPageForPosition(positionRef.current, content, blocks, nextModel))
      if (!restoredRef.current) {
        restoredRef.current = true
        setCoverClosed(true)
      }
      positionSpreadRef.current = nextSpread
      setSpreadIndex(nextSpread)
      scheduleIdleArm()
    }
    if (blocks.length > 1500) {
      const raf = requestAnimationFrame(runMeasure)
      return () => cancelAnimationFrame(raf)
    }
    runMeasure()
    return undefined
  }, [
    blocks,
    imageAssets,
    geometry.contentWidth,
    geometry.contentHeight,
    prefs.fontSize,
    prefs.lineHeight,
    isSceneVisible,
    measurerActive,
    content,
    scheduleIdleArm,
    stageSize.width,
  ])

  // --- 舞台尺寸 ---
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    // RO 首帧回调是异步的且可能被场景过渡吞掉；先同步取一次，再以 RO 跟踪
    const syncSize = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setStageSize((prev) => (
        Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
          ? prev
          : { width: rect.width, height: rect.height }
      ))
    }
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 静态页在本次提交的 layout effect 中注册为克隆源；父 effect 再安排空闲预武装，
  // 确保首个真实按下不承担 cloneNode 与排版成本。
  useEffect(() => {
    if (!model || !isSceneVisible) return
    scheduleIdleArm()
  }, [coverClosed, isSceneVisible, model, reducedMotion, safeSpreadIndex, scheduleIdleArm])

  // 运行中开启「减少动态效果」时，先撤销正在接管的活动页。
  // cancel 会发出 idle 帧；帧处理不再早退，因此叶片、隐藏页和动态阴影同时归零。
  useEffect(() => {
    if (!reducedMotion) return
    armedRigidRef.current = false
    armedSideRef.current = null
    armedLeafIdentityRef.current = null
    controllerRef.current?.cancel()
  }, [reducedMotion])

  // --- 场景隐藏：中断翻页 ---
  useEffect(() => {
    if (!isSceneVisible) {
      idleArmCancelRef.current?.()
      idleArmCancelRef.current = null
      controllerRef.current?.cancel()
      leafRef.current?.clear()
      armedLeafIdentityRef.current = null
    }
  }, [isSceneVisible])

  // --- 位置保存 ---
  useLayoutEffect(() => {
    savePosition()
  }, [coverClosed, savePosition, safeSpreadIndex])
  useLayoutEffect(() => () => {
    idleArmCancelRef.current?.()
    savePosition()
    controllerRef.current?.dispose()
    controllerRef.current = null
  }, [savePosition])

  // --- 键盘 ---
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'Escape' && target?.closest?.('input, textarea, [contenteditable="true"]')) return
      const rt = runtimeRef.current
      const action = resolveBookKeyboardAction(event.key, event.shiftKey)
      if (!action) return
      if (action === 'escape') {
        event.preventDefault()
        if (typesetOpen) {
          setTypesetOpen(false)
          return
        }
        if (controllerRef.current?.getState().phase !== 'idle') {
          controllerRef.current?.cancel()
          return
        }
        savePosition()
        onExit()
        return
      }
      if (!rt.model) return
      if (action === 'forward') {
        event.preventDefault()
        handlers.onTap('forward', rt.geometry.pageWidth, 0.5)
      } else if (action === 'backward') {
        event.preventDefault()
        handlers.onTap('backward', rt.geometry.pageWidth, 0.5)
      } else if (action === 'first') {
        event.preventDefault()
        controllerRef.current?.cancel()
        setCoverClosed(false)
        setSpreadIndex(0)
      } else if (action === 'last') {
        event.preventDefault()
        controllerRef.current?.cancel()
        setCoverClosed(false)
        setSpreadIndex(Math.max(0, spreadCountForPages(rt.model.pageCount) - 1))
      }
      rootRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handlers, onExit, savePosition, typesetOpen])

  // --- 胶囊条显隐 ---
  const pokeControls = useCallback(() => {
    setControlsVisible(true)
    window.clearTimeout(controlsIdleRef.current)
    controlsIdleRef.current = window.setTimeout(() => {
      if (!controlsPinnedRef.current) setControlsVisible(false)
    }, CONTROLS_IDLE_HIDE_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(controlsIdleRef.current), [])

  const jumpToSpread = useCallback((target: number) => {
    const rt = runtimeRef.current
    if (!rt.model) return
    const clamped = clamp(target, 0, Math.max(0, spreadCountForPages(rt.model.pageCount) - 1))
    if (clamped === rt.spreadIndex) return
    if (Math.abs(clamped - rt.spreadIndex) === 1 && !rt.coverClosed) {
      handlers.onTap(clamped > rt.spreadIndex ? 'forward' : 'backward', rt.geometry.pageWidth, 0.5)
      return
    }
    controllerRef.current?.cancel()
    setCoverClosed(false)
    setSpreadIndex(clamped)
  }, [handlers])

  const handlePrefsChange = useCallback((next: BookReadingPreferences) => {
    setPrefs(next)
    saveBookReadingPreferences(next)
  }, [])

  const pageLabel = useMemo(() => {
    const formatPage = (page: number | null) => {
      if (page === null) return '—'
      if (page === BOOK_TITLE_PAGE) return '扉页'
      return String(page + 1)
    }
    return `${formatPage(spread.left)}–${formatPage(spread.right)}`
  }, [spread.left, spread.right])

  const ready = model !== null && stageSize.width > 0 && imageAssets?.blocks === blocks

  return (
    <BookImageContext.Provider value={imageContext}>
    <div
      ref={rootRef}
      className="document-book-reading"
      tabIndex={0}
      role="region"
      aria-label="书本阅读模式"
      style={{
        ['--book-font-size' as string]: `${prefs.fontSize}px`,
        ['--book-line-height' as string]: String(prefs.lineHeight),
        ['--book-content-height' as string]: `${geometry.contentHeight}px`,
        ['--book-stage-bg' as string]: prefs.background ?? undefined,
      }}
      onPointerMove={pokeControls}
    >
      {ready ? (
        <>
          <DocumentBookStage
            ref={stageRef}
            geometry={geometry}
            model={model}
            blocks={blocks}
            embedsById={embedsById}
            widgetsById={widgetsById}
            spread={spread}
            spreadCount={spreadCount}
            coverClosed={coverClosed}
            hideStaticCover={coverLeafActive}
            hiddenSide={hiddenSide}
            coverLifting={coverLifting}
            docTitle={tab.title}
            docSubtitle={tab.path || ''}
            leafMirrored={leafDirection === 'backward'}
            sliceCount={sliceCount}
            reducedMotion={reducedMotion}
            handlers={handlers}
            canFlip={canFlip}
            leafRef={leafRef}
            registerPageEl={registerPageElement}
          />
          <DocumentBookControls
            visible={controlsVisible}
            spreadIndex={safeSpreadIndex}
            spreadCount={spreadCount}
            pageLabel={pageLabel}
            pageCount={pageCount}
            prefs={prefs}
            typesetOpen={typesetOpen}
            canFlip={canFlip}
            onFlip={(direction) => handlers.onTap(direction, runtimeRef.current.geometry.pageWidth, 0.5)}
            onJump={jumpToSpread}
            onPrefsChange={handlePrefsChange}
            onTypesetOpenChange={setTypesetOpen}
            onPinChange={(pinned) => {
              controlsPinnedRef.current = pinned
              if (pinned) setControlsVisible(true)
            }}
          />
        </>
      ) : (
        <div className="document-book-reading__loading">
          <div className="document-book-reading__loading-book" />
          <div className="document-book-reading__loading-text">排版中…</div>
        </div>
      )}

      {/* 隐藏测量器：CSS 多栏流负责精确断页，测得页模型后静态页按片段克隆渲染 */}
      {measurerActive ? (
        <div
          ref={measurerRef}
          className="document-book-measurer"
          style={{ width: geometry.contentWidth, height: geometry.contentHeight }}
          aria-hidden
        >
          <div
            className="document-book-measurer__flow"
            style={{ columnWidth: geometry.contentWidth, columnGap: 0, columnFill: 'auto' }}
          >
            {blocks.map((block, index) => (
              <div key={block.id} data-book-block-idx={index} className="document-book-measurer__block">
                <DocumentBookBlock block={block} embedsById={embedsById} widgetsById={widgetsById} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
    </BookImageContext.Provider>
  )
}
