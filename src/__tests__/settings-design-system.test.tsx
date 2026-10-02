import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, useState } from 'react'
import { act } from 'react'
import { JSDOM } from 'jsdom'

// 设置页设计系统的行为合同：
// 1) 四档强调色在 OKLCH 上等明度配平（科学配色，不靠肉眼）；
// 2) 共享控件（分段、开关、按钮类名）对外的可访问语义与交互；
// 3) 设置页外壳：分组导航、aria-current、外观页把主题色写到根节点。

function installDom(): () => void {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as unknown as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

function oklchLightness(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = [channel(1), channel(3), channel(5)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
}

test('accent palettes are lightness-balanced in OKLCH for both themes', async () => {
  const restore = installDom()
  try {
    const { resolveAccentPalette } = await import('../renderer/stores/useTheme')
    const accents = ['blue', 'green', 'purple', 'orange'] as const
    const light = accents.map((accent) => oklchLightness(resolveAccentPalette(accent, 'light', 'liquid-glass').color))
    const dark = accents.map((accent) => oklchLightness(resolveAccentPalette(accent, 'dark', 'liquid-glass').color))
    for (const value of light) assert.ok(value >= 0.58 && value <= 0.7, `light accent L=${value.toFixed(3)} out of band`)
    for (const value of dark) assert.ok(value >= 0.68 && value <= 0.78, `dark accent L=${value.toFixed(3)} out of band`)
    assert.ok(Math.max(...light) - Math.min(...light) <= 0.07, 'light accents should share one lightness band')
    assert.ok(Math.max(...dark) - Math.min(...dark) <= 0.07, 'dark accents should share one lightness band')
  } finally {
    restore()
  }
})

test('settings button class helper maps variants onto the shared sx-btn system', async () => {
  const { settingsButtonClass } = await import('../renderer/pages/settings/settings-shared')
  assert.equal(settingsButtonClass(), 'sx-btn')
  assert.equal(settingsButtonClass('primary'), 'sx-btn sx-btn--primary')
  assert.equal(settingsButtonClass('danger-ghost', { size: 'sm' }), 'sx-btn sx-btn--danger sx-btn--ghost sx-btn--sm')
  assert.equal(settingsButtonClass('ghost', { icon: true, className: 'no-drag' }), 'sx-btn sx-btn--ghost sx-btn--icon no-drag')
})

test('segmented control and switch expose accessible state and report changes', async () => {
  const restore = installDom()
  try {
    const { createRoot } = await import('react-dom/client')
    const { SettingsSegmented, SettingsSwitch } = await import('../renderer/pages/settings/settings-shared')
    const switchChanges: boolean[] = []

    function Harness() {
      const [size, setSize] = useState<'small' | 'medium' | 'large'>('medium')
      return createElement('div', null,
        createElement(SettingsSegmented<'small' | 'medium' | 'large'>, {
          ariaLabel: '显示尺寸',
          value: size,
          onChange: setSize,
          options: [
            { value: 'small', label: '小' },
            { value: 'medium', label: '中' },
            { value: 'large', label: '大' },
          ],
        }),
        createElement(SettingsSegmented<'a' | 'b'>, {
          ariaLabel: '平台',
          kind: 'tabs',
          value: 'a',
          onChange: () => undefined,
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        }),
        createElement(SettingsSwitch, { checked: false, ariaLabel: '推送通知', onChange: (next: boolean) => switchChanges.push(next) }),
      )
    }

    const root = createRoot(document.getElementById('root')!)
    await act(async () => { root.render(createElement(Harness)) })

    const radiogroup = document.querySelector('[role="radiogroup"][aria-label="显示尺寸"]')!
    const radios = Array.from(radiogroup.querySelectorAll('[role="radio"]'))
    assert.deepEqual(radios.map((radio) => radio.getAttribute('aria-checked')), ['false', 'true', 'false'])
    await act(async () => { (radios[2] as HTMLButtonElement).click() })
    assert.deepEqual(radios.map((radio) => radio.getAttribute('aria-checked')), ['false', 'false', 'true'])

    const tabs = Array.from(document.querySelectorAll('[role="tablist"][aria-label="平台"] [role="tab"]'))
    assert.deepEqual(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false'])

    const toggle = document.querySelector('button[role="switch"][aria-label="推送通知"]') as HTMLButtonElement
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    await act(async () => { toggle.click() })
    assert.deepEqual(switchChanges, [true])

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('settings shell groups navigation, tracks the current section and applies the chosen accent', async () => {
  const restore = installDom()
  try {
    const { createRoot } = await import('react-dom/client')
    const { MemoryRouter } = await import('react-router-dom')
    const { default: Settings } = await import('../renderer/pages/Settings')

    const root = createRoot(document.getElementById('root')!)
    await act(async () => {
      root.render(createElement(MemoryRouter, null, createElement(Settings, { initialSection: 'privacy' })))
    })

    const nav = document.querySelector('nav[aria-label="设置分区"]')!
    const groupLabels = Array.from(nav.querySelectorAll('.sx-nav-group-label')).map((node) => node.textContent)
    assert.deepEqual(groupLabels, ['通用', '智能', '内容与连接', '隐私与数据', '应用'])

    const current = () => Array.from(nav.querySelectorAll('[aria-current="page"]')).map((node) => node.textContent)
    assert.deepEqual(current(), ['隐私'])
    assert.equal(document.querySelector('button[role="switch"][aria-label="文件涌现"]')?.getAttribute('aria-checked'), 'true', 'privacy rows render as switches')

    const appearance = Array.from(nav.querySelectorAll('button')).find((button) => button.textContent === '外观')!
    await act(async () => { appearance.click() })
    assert.deepEqual(current(), ['外观'])
    for (const label of ['主题模式', '视觉风格', '主题色']) {
      assert.ok(document.querySelector(`[role="radiogroup"][aria-label="${label}"]`), `${label} picker renders`)
    }

    const blue = document.querySelector('[role="radiogroup"][aria-label="主题色"] [aria-label="蓝色"]') as HTMLButtonElement
    await act(async () => { blue.click() })
    assert.equal(blue.getAttribute('aria-checked'), 'true')
    assert.equal(document.documentElement.getAttribute('data-accent'), 'blue')

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})
