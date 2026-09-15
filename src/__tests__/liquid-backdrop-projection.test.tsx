import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { LiquidBackdropProjection } from '../renderer/components/ui/liquid-glass/LiquidBackdropProjection'

test('live glass retains its projection on scroll, updates content, and releases shared masks', async () => {
  const dom = new JSDOM('<div id="pane"><div data-liquid-scroll-root="chat-messages"><p id="message">First reply</p></div><div id="root"></div></div>', { pretendToBeVisual: true })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const frames = new Map<number, FrameRequestCallback>()
  const resizeCallbacks = new Set<ResizeObserverCallback>()
  let frameId = 0
  install('window', dom.window)
  install('document', dom.window.document)
  install('MutationObserver', dom.window.MutationObserver)
  install('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  install('cancelAnimationFrame', (id: number) => frames.delete(id))
  install('IS_REACT_ACT_ENVIRONMENT', true)
  install('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) { resizeCallbacks.add(callback) }
    observe() {}
    unobserve() {}
    disconnect() { resizeCallbacks.delete(this.callback) }
  })
  const rect = (x: number, y: number, width: number, height: number) => new dom.window.DOMRect(x, y, width, height)
  let composerY = 360
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('[data-liquid-scroll-root]')) return rect(0, 0, 500, 500)
    return this.classList.contains('tabs-projection') ? rect(24, 310, 144, 38) : rect(16, composerY, 468, 120)
  }
  const source = dom.window.document.querySelector<HTMLElement>('[data-liquid-scroll-root]')!
  source.style.setProperty('mask-image', 'linear-gradient(black, transparent)')
  const originalMask = source.style.getPropertyValue('mask-image')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const render = (tabs = true) => act(async () => {
    root.render(createElement('div', null,
      createElement(LiquidBackdropProjection, { key: 'composer', className: 'composer-projection' }),
      tabs && createElement(LiquidBackdropProjection, { key: 'tabs', className: 'tabs-projection' }),
    ))
  })
  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      const batch = [...frames.values()]
      frames.clear()
      batch.forEach((callback) => callback(0))
      await Promise.resolve()
    })
  }
  const projection = () => dom.window.document.querySelector<HTMLElement>('.composer-projection > div')!
  try {
    await render()
    await flush()
    await flush()
    assert.equal(frames.size, 0, 'writing the source mask must not schedule another clone')
    const clone = projection()
    assert.ok(clone.hasAttribute('inert'))
    assert.equal(clone.getAttribute('aria-hidden'), 'true')
    assert.equal(clone.querySelectorAll('[id], [data-liquid-scroll-root]').length, 0)
    assert.equal(clone.style.getPropertyValue('mask-image'), '')
    const mask = source.style.getPropertyValue('mask-image')

    source.scrollTop = 248
    source.scrollLeft = 12
    source.dispatchEvent(new dom.window.Event('scroll'))
    assert.equal(projection().scrollTop, 248, 'scroll synchronization must happen in the scroll callback')
    assert.equal(projection().scrollLeft, 12)
    await flush()
    assert.equal(projection(), clone, 'scroll must reuse the existing DOM')
    assert.equal(source.style.getPropertyValue('mask-image'), mask, 'scroll must not rebuild the mask')
    assert.equal(frames.size, 0)

    source.querySelector('p')!.firstChild!.textContent = 'Streamed reply'
    await flush()
    assert.equal(projection().textContent, 'Streamed reply')
    assert.equal(projection(), clone, 'streaming text must update the existing projection without copying the conversation')
    assert.equal(projection().scrollTop, 248)
    const updated = projection()
    await flush()
    assert.equal(projection(), updated, 'one content update must settle without a feedback loop')

    source.querySelector('p')!.style.color = 'red'
    await flush()
    assert.equal(projection().querySelector('p')!.style.color, 'red')
    source.style.paddingTop = '12px'
    await flush()
    assert.equal(projection().style.paddingTop, '12px', 'external root styles must still propagate')

    source.appendChild(dom.window.document.createElement('strong')).textContent = 'New message'
    await flush()
    assert.equal(projection().querySelector('strong')!.textContent, 'New message')

    const resized = projection()
    composerY = 320
    resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver))
    await flush()
    assert.equal(projection(), resized, 'geometry changes must reuse the clone')
    assert.equal(projection().style.top, '-320px')
    assert.notEqual(source.style.getPropertyValue('mask-image'), mask)

    await render(false)
    await flush()
    const remainingMask = decodeURIComponent(source.style.getPropertyValue('mask-image'))
    assert.ok(remainingMask.includes('width="468"'))
    assert.ok(!remainingMask.includes('width="144"'), 'closing one lens must only remove its own hole')

    const parent = source.parentElement!
    source.remove()
    await flush()
    assert.equal(dom.window.document.querySelector('.composer-projection')!.childElementCount, 0)
    assert.equal(source.style.getPropertyValue('mask-image'), originalMask)
    const replacement = dom.window.document.createElement('div')
    replacement.setAttribute('data-liquid-scroll-root', 'chat-messages')
    replacement.textContent = 'Replacement conversation'
    parent.prepend(replacement)
    await flush()
    assert.equal(projection().textContent, 'Replacement conversation')
    replacement.scrollTop = 40
    replacement.dispatchEvent(new dom.window.Event('scroll'))
    assert.equal(projection().scrollTop, 40)
    source.scrollTop = 90
    source.dispatchEvent(new dom.window.Event('scroll'))
    assert.equal(projection().scrollTop, 40, 'retired sources must no longer drive the lens')
    await act(async () => root.unmount())
    assert.equal(replacement.style.getPropertyValue('mask-image'), '')
    assert.equal(source.style.getPropertyValue('mask-image'), originalMask)
    assert.equal(source.style.paddingTop, '12px')
    assert.equal(frames.size, 0)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
