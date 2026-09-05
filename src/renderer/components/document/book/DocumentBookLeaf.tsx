/**
 * 翻页叶片：独立的等宽切片共享曲面坐标，内容只在 arm 时克隆。
 * 每帧只更新切片自身；没有嵌套变换或向后续纸片扩散的继承变量。
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
  frontSource: HTMLElement | null
  backSource: HTMLElement | null
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
  mirrored: boolean
}

const DocumentBookLeaf = forwardRef<BookLeafHandle, BookLeafProps>(function DocumentBookLeaf(
  { spec, mirrored }, ref,
) {
  const slices = Math.max(2, Math.floor(spec.slices))
  const sliceWidth = spec.pageWidth / slices
  const seamOverlap = cssPixelsForOnePhysicalPixel(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
  const rootRef = useRef<HTMLDivElement>(null)
  const rigidRef = useRef(false)
  const geometryRef = useRef({ sliceWidth, slices })
  geometryRef.current = { sliceWidth, slices }
  const sliceRefs = useRef<Array<HTMLDivElement | null>>([])
  const frontShades = useRef<Array<HTMLDivElement | null>>([])
  const backShades = useRef<Array<HTMLDivElement | null>>([])
  const bleedRefs = useRef<Array<HTMLDivElement | null>>([])
  const gutterRefs = useRef<Array<HTMLDivElement | null>>([])
  const edgeRefs = useRef<Array<HTMLDivElement | null>>([])

  useLayoutEffect(() => {
    rootRef.current?.querySelectorAll<HTMLElement>('[data-book-leaf-slot]').forEach((slot) => {
      slot.style.transform = resolveLeafSlotTransform({
        sliceIndex: Number(slot.dataset.bookLeafSlot), sliceWidth,
        pageWidth: spec.pageWidth, mirrored, backFace: slot.dataset.bookLeafBack === '1',
      })
    })
  }, [mirrored, sliceWidth, slices, spec.pageWidth])

  const api = useMemo<BookLeafHandle>(() => ({
    arm: ({ frontSource, backSource, rigid }) => {
      const root = rootRef.current
      if (!root) return
      rigidRef.current = rigid
      // 每个源只清理一次 id，再复制给可见面及微弱透印面。
      const template = (source: HTMLElement | null) => {
        if (!source) return null
        const clone = source.cloneNode(true) as HTMLElement
        clone.removeAttribute('id')
        clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
        if (clone.classList.contains('document-book-cover')) {
          clone.classList.remove('is-closed', 'is-offstage')
          clone.classList.add('is-leaf-face')
        }
        clone.setAttribute('aria-hidden', 'true')
        return clone
      }
      const front = template(frontSource)
      const back = template(backSource)
      root.querySelectorAll<HTMLElement>('[data-book-leaf-slot]').forEach((slot) => {
        const bleed = slot.dataset.bookLeafBleed === '1'
        const isBack = slot.dataset.bookLeafBack === '1'
        const source = isBack !== bleed ? back : front
        slot.replaceChildren()
        if (!source || (bleed && rigid)) return
        const clone = source.cloneNode(true) as HTMLElement
        if (bleed) clone.classList.add('document-book-leaf__through-ink')
        slot.appendChild(clone)
      })
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
      const lift = Math.sin(Math.min(Math.PI, Math.max(0, theta))) ** 2
      root.style.transform = rigid ? '' : `skewY(${frame.shearDeg.toFixed(3)}deg)`
      const gutterOpacity = leafGutterOpacityForTheta(theta).toFixed(3)
      gutterRefs.current.forEach((el) => { if (el) el.style.opacity = gutterOpacity })
      edgeRefs.current.forEach((el) => { if (el) el.style.opacity = (rigid ? 0 : lift).toFixed(3) })
      const { sliceWidth: width, slices: count } = geometryRef.current
      for (let i = 0; i < count; i += 1) {
        const slice = frame.slices[i]
        if (!slice) continue
        const angle = rigid ? theta : slice.angle
        const x = rigid ? i * width * Math.cos(theta) : slice.x
        const z = rigid ? i * width * Math.sin(theta) : slice.z
        const el = sliceRefs.current[i]
        if (el) el.style.transform = `translate3d(${x.toFixed(4)}px,0,${z.toFixed(4)}px) rotateY(${(-angle).toFixed(6)}rad)`
        const shade = (target: HTMLElement | null, start: number, end: number) => {
          if (!target) return
          target.style.background = `linear-gradient(to right, rgb(36 28 20 / ${start.toFixed(3)}), rgb(36 28 20 / ${end.toFixed(3)}))`
        }
        shade(frontShades.current[i], rigid ? frontShadeForAngle(theta) : slice.shadeStart, rigid ? frontShadeForAngle(theta) : slice.shadeEnd)
        // 背面局部左右与纸面边界相反，交换端点才能跨切片连续受光。
        shade(backShades.current[i], rigid ? backShadeForAngle(theta) : slice.backShadeEnd, rigid ? backShadeForAngle(theta) : slice.backShadeStart)
        for (const bleed of [bleedRefs.current[i * 2], bleedRefs.current[i * 2 + 1]]) {
          if (bleed) bleed.style.opacity = (rigid ? 0 : slice.transmission).toFixed(3)
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

  return (
    <div className="document-book-leaf" ref={rootRef} style={{
      display: 'none',
      ['--book-page-width' as string]: `${spec.pageWidth}px`,
      ['--book-page-height' as string]: `${spec.pageHeight}px`,
      ['--book-slice-width' as string]: `${sliceWidth}px`,
      ['--book-leaf-seam-overlap' as string]: `${seamOverlap}px`,
    }}>
      {Array.from({ length: slices }, (_, index) => (
        <div className={`document-book-leaf__slice${index === slices - 1 ? ' is-free-edge' : ''}`} key={index}
          ref={(el) => { sliceRefs.current[index] = el }} style={{
            width: sliceWidth,
            ['--book-front-slice-offset' as string]: `${mirrored ? spec.pageWidth - (index + 1) * sliceWidth : index * sliceWidth}px`,
            ['--book-back-slice-offset' as string]: `${mirrored ? index * sliceWidth : spec.pageWidth - (index + 1) * sliceWidth}px`,
          }}>
          {(['front', 'back'] as const).map((face, faceIndex) => (
            <div className={`document-book-leaf__face document-book-leaf__face--${face}`} key={face}>
              <div className="document-book-leaf__slot" data-book-leaf-slot={index} data-book-leaf-back={faceIndex} />
              <div className="document-book-leaf__transmission" ref={(el) => { bleedRefs.current[index * 2 + faceIndex] = el }}>
                <div className="document-book-leaf__slot" data-book-leaf-slot={index} data-book-leaf-back={faceIndex} data-book-leaf-bleed="1" />
              </div>
              <div className={`document-book-leaf__shade document-book-leaf__shade--${face}`}
                ref={(el) => { (faceIndex ? backShades : frontShades).current[index] = el }} />
              {index === slices - 1 ? <div className="document-book-leaf__paper-edge" ref={(el) => { edgeRefs.current[faceIndex] = el }} /> : null}
            </div>
          ))}
          {index === 0 && (['front', 'back'] as const).map((face, i) => (
            <div className={`document-book-leaf__gutter-plane document-book-leaf__gutter-plane--${face}`} key={face}
              ref={(el) => { gutterRefs.current[i] = el }} />
          ))}
        </div>
      ))}
    </div>
  )
})
export default memo(DocumentBookLeaf)
