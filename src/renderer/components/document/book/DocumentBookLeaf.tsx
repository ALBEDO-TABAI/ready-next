/**
 * DocumentBookLeaf.tsx — 翻页叶片：K 层嵌套切片 + 正/反/透光三面。
 *
 * React 只挂切片空壳（一次性）；内容用 cloneNode 从静态页注入（arm），
 * 逐帧 transform/opacity 由 apply() 直写（不经过 React 渲染）。
 * 透印规则：相对观察者恒为左右镜像（见 bookCurlMath 与设计文档 §4.1）。
 * 后翻由外层 scaleX(-1) 镜像实现（mirrored），内容槽自动反向抵消，文字始终正读。
 */

import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { cssPixelsForOnePhysicalPixel } from '../../../modules/document/book/bookGeometry'
import {
  backShadeForAngle,
  frontShadeForAngle,
  leafGutterOpacityForTheta,
  resolveLeafSlotTransform,
  type BookCurlSpec,
  type CurlFrame,
} from '../../../modules/document/book/bookCurlMath'

export interface BookLeafArmArgs {
  /** 正面内容源（静态页 inner 元素，cloneNode 注入；null = 空白纸面） */
  frontSource: HTMLElement | null
  /** 背面内容源 */
  backSource: HTMLElement | null
  /** 硬页（封面）：所有切片同角，无弯曲 */
  rigid: boolean
}

export interface BookLeafApplyArgs {
  frame: CurlFrame
  theta: number
  visible: boolean
}

export interface BookLeafHandle {
  arm: (args: BookLeafArmArgs) => void
  apply: (args: BookLeafApplyArgs) => void
  clear: () => void
}

interface BookLeafProps {
  spec: BookCurlSpec
  /** 后翻镜像：叶片几何被外层 scaleX(-1) 翻转 */
  mirrored: boolean
}

interface SlotRefs {
  slice: HTMLDivElement | null
}

const stripCloneIds = (root: HTMLElement) => {
  if (root.id) root.removeAttribute('id')
  root.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
}

const DocumentBookLeaf = forwardRef<BookLeafHandle, BookLeafProps>(function DocumentBookLeaf(
  { spec, mirrored },
  ref,
) {
  const slices = Math.max(2, Math.floor(spec.slices))
  const sliceWidth = spec.pageWidth / slices
  const renderPixelRatio = typeof window === 'undefined'
    ? 1
    : window.devicePixelRatio || 1
  const seamOverlap = cssPixelsForOnePhysicalPixel(renderPixelRatio)
  const rootRef = useRef<HTMLDivElement>(null)
  const slotRefs = useRef<SlotRefs[]>([])
  const rigidRef = useRef(false)
  slotRefs.current = Array.from({ length: slices }, (_, i) => slotRefs.current[i] ?? {
    slice: null,
  })

  // 内容槽定位：切片 i 显示页内容 [i·w, (i+1)·w] 竖条；
  // 需镜像的槽（后翻的内容槽 / 所有透光槽）翻转到 (i+1)·w 再 scaleX(-1)。
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('[data-book-leaf-slot]').forEach((slot) => {
      const i = Number(slot.dataset.bookLeafSlot)
      slot.style.transform = resolveLeafSlotTransform({
        sliceIndex: i,
        sliceWidth,
        pageWidth: spec.pageWidth,
        mirrored,
        backFace: slot.dataset.bookLeafBack === '1',
      })
    })
  }, [mirrored, sliceWidth, slices, spec.pageWidth])

  const api = useMemo<BookLeafHandle>(() => ({
    arm: ({ frontSource, backSource, rigid }) => {
      const root = rootRef.current
      if (!root) return
      rigidRef.current = rigid
      root.querySelectorAll<HTMLElement>('[data-book-leaf-slot]').forEach((slot) => {
        slot.replaceChildren()
        const isBackFace = slot.dataset.bookLeafBack === '1'
        const source = isBackFace ? backSource : frontSource
        if (!source) return
        const clone = source.cloneNode(true) as HTMLElement
        stripCloneIds(clone)
        if (clone.classList.contains('document-book-cover')) {
          clone.classList.remove('is-closed', 'is-offstage')
          clone.classList.add('is-leaf-face')
        }
        clone.setAttribute('aria-hidden', 'true')
        slot.appendChild(clone)
      })
      // 预武装时保持参与布局但不可见，让切片/文字排版在空闲帧完成。
      // 若用 display:none，第一次抬页才会集中触发布局，长文档会在起翻瞬间卡住。
      root.style.display = ''
      root.style.visibility = 'hidden'
    },
    apply: ({ frame, theta, visible }) => {
      const root = rootRef.current
      if (!root) return
      root.style.display = visible ? '' : 'none'
      if (!visible) return
      root.style.visibility = 'visible'
      const rigid = rigidRef.current
      // z 偏移只在页片抬起时存在；两个平放终点必须与静态页共面。
      const lift = Math.pow(Math.max(0, Math.sin(theta)), 0.8)
      // 方向形变施加在整张叶片上：
      // skewY 的 x=0 边恒定在书脊，切片之间不会因各自位移而裂开。
      root.style.transform = rigid
        ? `translateZ(${(0.2 * lift).toFixed(3)}px)`
        : `translateZ(${(0.08 * lift).toFixed(3)}px) skewY(${frame.shearDeg.toFixed(3)}deg)`
      root.style.setProperty(
        '--book-leaf-gutter-opacity',
        leafGutterOpacityForTheta(theta).toFixed(3),
      )
      root.style.setProperty('--book-leaf-edge-opacity', lift.toFixed(3))
      let previous = 0
      for (let i = 0; i < slotRefs.current.length; i += 1) {
        const refs = slotRefs.current[i]
        const sliceFrame = frame.slices[i]
        const angle = rigid ? theta : sliceFrame?.angle ?? 0
        const delta = angle - previous
        previous = angle
        // 取负：CSS rotateY 正向把页缘转向屏内，物理翻页页缘必须朝向观察者（-z → +z）
        if (refs.slice) {
          refs.slice.style.transform = `rotateY(${(-delta).toFixed(4)}rad)`
          // 根部和自由边朝向不同，必须分别受光。整页共用 theta 会把几乎
          // 平放的装订侧压成一整条灰带，看起来像纸页和书脊断开。
          refs.slice.style.setProperty(
            '--book-leaf-front-shade-start',
            (rigid ? frontShadeForAngle(theta) : sliceFrame?.shadeStart ?? 0).toFixed(3),
          )
          refs.slice.style.setProperty(
            '--book-leaf-front-shade-end',
            (rigid ? frontShadeForAngle(theta) : sliceFrame?.shadeEnd ?? 0).toFixed(3),
          )
          refs.slice.style.setProperty(
            '--book-leaf-back-shade-start',
            (rigid ? backShadeForAngle(theta) : sliceFrame?.backShadeStart ?? 0).toFixed(3),
          )
          refs.slice.style.setProperty(
            '--book-leaf-back-shade-end',
            (rigid ? backShadeForAngle(theta) : sliceFrame?.backShadeEnd ?? 0).toFixed(3),
          )
        }
      }
    },
    clear: () => {
      const root = rootRef.current
      if (!root) return
      root.style.display = 'none'
      root.style.visibility = 'hidden'
      root.querySelectorAll<HTMLElement>('[data-book-leaf-slot]').forEach((slot) => slot.replaceChildren())
    },
  }), [])

  useImperativeHandle(ref, () => api, [api])

  // 嵌套切片链：slice[i+1] 是 slice[i] 的子节点（位于父切片右缘），
  // 与正/反面平级——面裁切自己的内容条，子切片不受裁切影响。
  const renderSlice = (index: number): React.ReactNode => {
    if (index >= slices) return null
    return (
      <div
        className={`document-book-leaf__slice${index === slices - 1 ? ' is-free-edge' : ''}`}
        style={{
          width: sliceWidth,
          ['--book-front-slice-offset' as string]: `${(
            mirrored ? spec.pageWidth - (index + 1) * sliceWidth : index * sliceWidth
          )}px`,
          ['--book-back-slice-offset' as string]: `${(
            mirrored ? index * sliceWidth : spec.pageWidth - (index + 1) * sliceWidth
          )}px`,
        }}
        ref={(el) => {
          const refs = slotRefs.current[index]
          if (refs) refs.slice = el
        }}
      >
        <div className="document-book-leaf__face document-book-leaf__face--front">
          <div className="document-book-leaf__slot" data-book-leaf-slot={index} data-book-leaf-back="0" />
          <div className="document-book-leaf__shade document-book-leaf__shade--front" />
          {index === slices - 1 ? <div className="document-book-leaf__paper-edge" /> : null}
        </div>
        <div className="document-book-leaf__face document-book-leaf__face--back">
          <div className="document-book-leaf__slot" data-book-leaf-slot={index} data-book-leaf-back="1" />
          <div className="document-book-leaf__shade document-book-leaf__shade--back" />
          {index === slices - 1 ? <div className="document-book-leaf__paper-edge" /> : null}
        </div>
        {renderSlice(index + 1)}
        {index === 0 ? (
          <>
            <div className="document-book-leaf__gutter-plane document-book-leaf__gutter-plane--front" />
            <div className="document-book-leaf__gutter-plane document-book-leaf__gutter-plane--back" />
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="document-book-leaf"
      ref={rootRef}
      style={{
        display: 'none',
        ['--book-page-width' as string]: `${spec.pageWidth}px`,
        ['--book-page-height' as string]: `${spec.pageHeight}px`,
        ['--book-leaf-seam-overlap' as string]: `${seamOverlap}px`,
      }}
    >
      {renderSlice(0)}
    </div>
  )
})

export default memo(DocumentBookLeaf)
