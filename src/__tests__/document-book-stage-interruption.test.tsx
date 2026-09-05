import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, createRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const previousGlobals = new Map<string, unknown>()
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'navigator']) {
  previousGlobals.set(key, (globalThis as Record<string, unknown>)[key])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: (dom.window as unknown as Record<string, unknown>)[key],
  })
}

process.on('exit', () => {
  for (const [key, value] of previousGlobals) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  dom.window.close()
})

const { default: DocumentBookStage } = await import('../renderer/components/document/book/DocumentBookStage')
const { default: DocumentBookLeaf } = await import('../renderer/components/document/book/DocumentBookLeaf')
const {
  cssPixelsForOnePhysicalPixel,
  resolveBookStagePerspective,
  resolveBookStacks,
} = await import('../renderer/modules/document/book/bookGeometry')
const {
  resolveBookLeafTakeoverPolicy,
  settleBookPointerRelease,
} = await import('../renderer/modules/document/book/bookMotionPolicy')
const { buildCurlFrame } = await import('../renderer/modules/document/book/bookCurlMath')

test('舞台透视随页宽保持稳定比例，宽窗口不得回退到短焦放大', () => {
  assert.equal(resolveBookStagePerspective(100), 6000)
  assert.equal(resolveBookStagePerspective(520), 6240)
})

test('切片接缝在任意设备像素密度下都只覆盖一个物理像素', () => {
  for (const ratio of [1, 2, 2.5, 3]) {
    assert.equal(cssPixelsForOnePhysicalPixel(ratio) * ratio, 1)
  }
  assert.equal(cssPixelsForOnePhysicalPixel(0), 1)
  assert.equal(cssPixelsForOnePhysicalPixel(Number.NaN), 1)
})

function pointerEvent(type: string, pointerId: number, clientX = 160, clientY = 40): MouseEvent {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX,
    clientY,
  })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

test('按下不换层，越过拖动阈值后才接管纸页，打断时只取消已开始的拖页', () => {
  const host = dom.window.document.getElementById('root')
  assert.ok(host)
  const root = createRoot(host)
  const stageRef = createRef<import('../renderer/components/document/book/DocumentBookStage').BookStageHandle>()
  const leafRef = createRef<import('../renderer/components/document/book/DocumentBookLeaf').BookLeafHandle>()
  const calls = { prewarm: 0, press: 0, drag: 0, cancel: 0, release: 0, tap: 0 }
  const releaseDirections: string[] = []
  const tapPoints: Array<{ direction: string; nx: number; ny: number }> = []
  flushSync(() => {
    root.render(createElement(DocumentBookStage, {
      ref: stageRef,
      geometry: {
        pageWidth: 100,
        pageHeight: 140,
        contentWidth: 80,
        contentHeight: 110,
        paddingInner: 10,
        paddingOuter: 10,
        paddingTop: 15,
        paddingBottom: 15,
        coverOverhang: 7,
        stackMaxPx: 8,
      },
      model: {
        pages: [
          { index: 0, entries: [], anchorBlock: 0, anchorRatio: 0 },
          { index: 1, entries: [], anchorBlock: 0, anchorRatio: 0 },
        ],
        pageCount: 2,
        contentWidth: 80,
        contentHeight: 110,
      },
      blocks: [],
      embedsById: new Map(),
      widgetsById: new Map(),
      spread: { index: 0, left: -1, right: 0 },
      spreadCount: 2,
      coverClosed: false,
      hideStaticCover: false,
      hiddenSide: null,
      coverLifting: false,
      docTitle: 'Book',
      docSubtitle: '',
      leafMirrored: false,
      sliceCount: 2,
      reducedMotion: false,
      handlers: {
        onPrewarm: () => { calls.prewarm += 1 },
        onPress: () => { calls.press += 1; return true },
        onDrag: () => { calls.drag += 1 },
        onRelease: (direction: string) => { calls.release += 1; releaseDirections.push(direction) },
        onCancel: () => { calls.cancel += 1 },
        onTap: (direction: string, nx: number, ny: number) => {
          calls.tap += 1
          tapPoints.push({ direction, nx, ny })
        },
      },
      canFlip: () => true,
      leafRef,
      registerPageEl: () => undefined,
    }))
  })

  const book = host.querySelector('.document-book-stage__book') as HTMLElement
  const hotZones = host.querySelectorAll('.document-book-stage__hot')
  const hot = host.querySelector('.document-book-stage__hot--right') as HTMLElement
  assert.ok(book && hot)
  assert.equal(hotZones.length, 2, '只有左右外侧纸边负责翻页，正文中间不能被透明手势层盖住')
  let bookRectReads = 0
  book.getBoundingClientRect = () => {
    bookRectReads += 1
    return {
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 140,
      width: 200, height: 140, toJSON: () => ({}),
    }
  }

  hot.dispatchEvent(new dom.window.MouseEvent('pointermove', {
    bubbles: true,
    clientX: 195,
    clientY: 5,
  }))

  hot.dispatchEvent(pointerEvent('pointerdown', 1))
  hot.dispatchEvent(pointerEvent('pointercancel', 1))
  hot.dispatchEvent(pointerEvent('pointerdown', 2))
  hot.dispatchEvent(pointerEvent('lostpointercapture', 2))
  hot.dispatchEvent(pointerEvent('pointerdown', 3))
  dom.window.dispatchEvent(new dom.window.Event('blur'))

  assert.deepEqual(
    calls,
    { prewarm: 1, press: 0, drag: 0, cancel: 0, release: 0, tap: 0 },
    '单纯按住、系统取消或轻微手抖都不能把静态页换成活动叶片',
  )

  hot.dispatchEvent(pointerEvent('pointerdown', 4))
  hot.dispatchEvent(pointerEvent('pointermove', 4, 164, 42))
  assert.equal(calls.press, 0, '未越过 6px 阈值时书页必须保持原位')
  hot.dispatchEvent(pointerEvent('pointermove', 4, 175, 42))
  hot.dispatchEvent(pointerEvent('pointercancel', 4, 175, 42))
  assert.deepEqual(
    calls,
    { prewarm: 1, press: 1, drag: 1, cancel: 1, release: 0, tap: 0 },
    '真正拖动后活动叶片才接管，取消时只撤销这一次拖页',
  )

  hot.dispatchEvent(pointerEvent('pointerdown', 5))
  hot.dispatchEvent(pointerEvent('pointerup', 5))
  assert.deepEqual(
    calls,
    { prewarm: 1, press: 1, drag: 1, cancel: 1, release: 0, tap: 1 },
    '短按应直接触发一次翻页，不得先制造一个活动叶片中间态',
  )
  assert.deepEqual(tapPoints, [{ direction: 'forward', nx: 60, ny: 40 / 140 }], '点击入口必须把真实抓取位置交给翻页控制器')

  hot.dispatchEvent(pointerEvent('pointerdown', 6))
  hot.dispatchEvent(pointerEvent('pointermove', 6, 175, 42))
  hot.dispatchEvent(pointerEvent('pointerup', 6, 175, 42))
  assert.deepEqual(
    calls,
    { prewarm: 1, press: 2, drag: 2, cancel: 1, release: 1, tap: 1 },
    '越过阈值后松手必须只结算一次拖页',
  )
  assert.deepEqual(releaseDirections, ['forward'], '松手结算必须保留起始页侧的方向')
  assert.equal(bookRectReads, 9, '抬手不再为装饰光标额外读取几何；需要坐标的事件仍最多读取一次')

  const underPages = host.querySelectorAll('.document-book-stage__page-under')
  assert.equal(underPages.length, 2)
  assert.equal(
    (host.querySelector('.document-book-stage') as HTMLElement).style.perspective,
    '6000px',
    '翻页透视深度必须按页宽设置下限，避免页片落定前被光学放宽',
  )
  assert.ok(Array.from(underPages).every((page) => page.hasAttribute('inert')), '被揭开页不得提前进入键盘焦点序列')
  assert.ok(host.querySelector('.document-book-stage__leaf')?.hasAttribute('inert'), '活动叶片的克隆链接不得获得焦点')
  assert.ok(host.querySelector('.document-book-offstage')?.hasAttribute('inert'), '离屏克隆源不得获得焦点')

  const leaf = host.querySelector('.document-book-leaf') as HTMLElement
  const gutters = host.querySelectorAll('.document-book-leaf__gutter-plane')
  assert.ok(leaf && gutters.length === 2, '活动页正反面必须各用一张连续书脊光影，不能在每个切片里重复起算')
  assert.equal(leaf.style.getPropertyValue('--book-leaf-seam-overlap'), '1px', '普通屏只允许补一个物理像素的内容采样缝')
  assert.equal(host.querySelectorAll('.document-book-leaf__paper-edge').length, 2, '活动页正反面必须共享一条连续的自由纸边')
  const slots = host.querySelectorAll<HTMLElement>('[data-book-leaf-slot]')
  assert.ok(Array.from(slots).every((slot) => slot.style.transform), '每个纸页切片都必须保留对应的内容条带定位')
  const source = dom.window.document.createElement('div')
  source.textContent = 'PAGE_CONTENT'
  leafRef.current?.arm({ frontSource: source, backSource: source, rigid: false })
  assert.equal(leaf.style.display, '', '预武装叶片必须参与空闲帧布局')
  assert.equal(leaf.style.visibility, 'hidden', '预武装叶片不得提前露出')
  const frame = buildCurlFrame(
    { slices: 2, pageWidth: 100, pageHeight: 140 },
    { theta: 0.05, skew: 0.4, velocity: 1 },
  )
  leafRef.current?.apply({ frame, theta: 0.05, visible: true })
  assert.equal(leaf.style.visibility, 'visible')
  assert.match(leaf.style.transform, /skewY\(/, '方向形变必须施加在整张叶片上，不能逐片错开共享边')
  assert.ok(
    Array.from(host.querySelectorAll<HTMLElement>('.document-book-leaf__slice'))
      .every((slice) => !slice.style.transform.includes('translateY')),
    '切片不得独立纵向位移，否则页顶页底会裂开',
  )
  assert.ok(Array.from(gutters).every((el) => Number((el as HTMLElement).style.opacity) > 0.9), '起翻瞬间必须继承静态书脊阴影')
  const litFrame = buildCurlFrame(
    { slices: 2, pageWidth: 100, pageHeight: 140 },
    { theta: Math.PI * 0.72, skew: 0.5, velocity: 8 },
  )
  leafRef.current?.apply({ frame: litFrame, theta: Math.PI * 0.72, visible: true })
  const leafSlices = host.querySelectorAll<HTMLElement>('.document-book-leaf__slice')
  assert.equal(host.querySelectorAll('.document-book-leaf__slice .document-book-leaf__slice').length, 0, '逐帧样式不得向后续切片和正文树级联')
  const expectedShade = (start: number, end: number) => {
    const el = document.createElement('div')
    el.style.background = `linear-gradient(to right, rgb(36 28 20 / ${start.toFixed(3)}), rgb(36 28 20 / ${end.toFixed(3)}))`
    return el.style.background
  }
  leafSlices.forEach((slice, i) => {
    assert.equal((slice.querySelector('.document-book-leaf__shade--front') as HTMLElement).style.background,
      expectedShade(litFrame.slices[i].shadeStart, litFrame.slices[i].shadeEnd))
    assert.equal((slice.querySelector('.document-book-leaf__shade--back') as HTMLElement).style.background,
      expectedShade(litFrame.slices[i].backShadeEnd, litFrame.slices[i].backShadeStart))
  })
  const settledFrame = buildCurlFrame(
    { slices: 2, pageWidth: 100, pageHeight: 140 },
    { theta: Math.PI, skew: 0.8, velocity: 0 },
  )
  leafRef.current?.apply({ frame: settledFrame, theta: Math.PI, visible: true })
  leafSlices.forEach((slice) => assert.match(slice.style.transform, /translate3d\([\d.-]+px,0,0\.0000px\)/, '满翻终点必须回到静态页平面'))
  host.querySelectorAll<HTMLElement>('.document-book-leaf__paper-edge').forEach((el) => assert.equal(Number(el.style.opacity), 0))
  gutters.forEach((el) => assert.equal(Number((el as HTMLElement).style.opacity), 1))
  stageRef.current?.applyShadows(frame, 'forward', true)
  const revealedGutter = host.querySelector('.document-book-stage__shade-gutter--right') as HTMLElement
  assert.ok(Number(revealedGutter.style.opacity) > 0, '纸页抬起后，被揭开页的书脊接触阴影不得消失')
  assert.ok(Number(revealedGutter.style.opacity) <= 0.12, '动态接触阴影不得叠成固定灰带')
  flushSync(() => root.unmount())
})

test('纸堆随阅读进度互补变化；厚书与薄书有别', () => {
  const first = resolveBookStacks(1000, 0, 18)
  const middle = resolveBookStacks(1000, 250, 18)
  const last = resolveBookStacks(1000, 500, 18)
  assert.equal(first.left, 0)
  assert.equal(first.right, last.left)
  assert.equal(last.right, 0)
  assert.equal(middle.left, middle.right)
  assert.equal(middle.left + middle.right, first.total)
  assert.ok(resolveBookStacks(20, 0, 18).total < first.total)
})

test('纸背透印来自另一面；刚性封面不透印，clear 释放所有正文克隆', () => {
  const host = document.getElementById('root')!
  const root = createRoot(host)
  const ref = createRef<import('../renderer/components/document/book/DocumentBookLeaf').BookLeafHandle>()
  flushSync(() => root.render(createElement(DocumentBookLeaf, { ref, spec: { slices: 4, pageWidth: 200, pageHeight: 280 }, mirrored: false })))
  const front = document.createElement('div')
  front.innerHTML = '<p id="original-front">FRONT_INK</p>'
  const back = document.createElement('div')
  back.innerHTML = '<p id="original-back">BACK_INK</p>'
  ref.current!.arm({ frontSource: front, backSource: back, rigid: false })
  assert.equal(host.querySelector('.document-book-leaf__face--front [data-book-leaf-bleed]')?.textContent, 'BACK_INK')
  assert.equal(host.querySelector('.document-book-leaf__face--back [data-book-leaf-bleed]')?.textContent, 'FRONT_INK')
  assert.equal(host.querySelectorAll('#original-front, #original-back').length, 0)
  assert.equal(host.querySelectorAll('[data-book-leaf-slot] > *').length, 16)
  ref.current!.apply({ frame: buildCurlFrame({ slices: 4, pageWidth: 200, pageHeight: 280 }, { theta: 1.4, skew: 0 }), theta: 1.4, visible: true })
  assert.ok(Number((host.querySelector('.document-book-leaf__transmission') as HTMLElement).style.opacity) > 0)
  ref.current!.arm({ frontSource: front, backSource: back, rigid: true })
  assert.equal(host.querySelectorAll('[data-book-leaf-bleed] > *').length, 0)
  ref.current!.clear()
  assert.equal(host.querySelectorAll('[data-book-leaf-slot] > *').length, 0)
  flushSync(() => root.unmount())
})

test('减少动态效果下拖页只直接跳一次，运行中切换会立即撤销叶片接管', () => {
  const order: string[] = []
  const controller = {
    cancel: () => { order.push('cancel') },
    release: () => { order.push('release') },
  } as import('../renderer/modules/document/book/bookFlipController').BookFlipController

  settleBookPointerRelease(true, 'forward', controller, (direction) => {
    order.push(`jump:${direction}`)
  })
  assert.deepEqual(order, ['cancel', 'jump:forward'], '初始即减少动效时必须先归零活动页，再且只跳页一次')

  assert.deepEqual(resolveBookLeafTakeoverPolicy({
    reducedMotion: true,
    active: true,
    theta: Math.PI * 0.65,
    direction: 'forward',
    armedSide: 'right',
    armedRigid: true,
    coverClosed: true,
  }), {
    visible: false,
    shadowsVisible: false,
    hiddenSide: null,
    hideCover: false,
    coverLifting: false,
  }, '普通拖页中途切换减少动效时，即使控制器仍报 active 也不得留下半页、隐藏页或封面接管')
})

test('运行中缩减切片数量时，旧切片卸载不得写坏新叶片', () => {
  const host = dom.window.document.getElementById('root')
  assert.ok(host)
  const root = createRoot(host)
  const leafRef = createRef<import('../renderer/components/document/book/DocumentBookLeaf').BookLeafHandle>()
  const renderLeaf = (slices: number) => createElement(
    DocumentBookLeaf,
    { ref: leafRef, spec: { slices, pageWidth: 180, pageHeight: 240 }, mirrored: false },
  )
  assert.doesNotThrow(() => {
    flushSync(() => root.render(renderLeaf(24)))
    flushSync(() => root.render(renderLeaf(18)))
  })
  assert.equal(host.querySelectorAll('.document-book-leaf__slice').length, 18)
  flushSync(() => root.unmount())
})
