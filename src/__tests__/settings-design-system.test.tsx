import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { JSDOM } from 'jsdom'

// 设置页设计系统的行为合同：
// 1) 设置页自己的版式件（卡、行、提示、状态）在共用基元上的结构与语义（B13：私有控件已删除）；
// 2) 设置页外壳：分组导航、aria-current、外观页的减少透明开关写到根节点。

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

test('settings rows and notices keep their structure and roles on the shared primitives', async () => {
  const restore = installDom()
  try {
    const { createRoot } = await import('react-dom/client')
    const { SettingsCard, SettingsRow, SettingsNotice, SettingsStatus, SettingsSwitchLabel } = await import('../renderer/pages/settings/settings-shared')
    const { Switch } = await import('../renderer/components/ui')
    const switchChanges: boolean[] = []

    const root = createRoot(document.getElementById('root')!)
    await act(async () => {
      root.render(createElement(SettingsCard, { title: '卡片' },
        createElement(SettingsRow, { label: '推送通知', description: '说明' },
          createElement(SettingsSwitchLabel, { text: '启用' },
            createElement(Switch, { checked: false, label: '推送通知', onChange: (next: boolean) => switchChanges.push(next) }))),
        createElement(SettingsNotice, { tone: 'danger', title: '出错了' }, '原因'),
        createElement(SettingsStatus, { tone: 'accent' }, '已连接'),
      ))
    })

    assert.ok(document.querySelector('section.sx-card .sx-card-title'))
    assert.equal(document.querySelector('.sx-row .sx-row__label')?.textContent, '推送通知')
    assert.equal(document.querySelector('.sx-row .sx-row__desc')?.textContent, '说明')
    assert.equal(document.querySelector('[role="alert"].sx-notice--danger .sx-notice__title')?.textContent, '出错了')
    assert.ok(document.querySelector('.sx-status .sx-dot--accent'))
    // The switch is the shared primitive: role, name and state; the visible text is only a caption.
    const toggle = document.querySelector('button[role="switch"].rn-switch[aria-label="推送通知"]') as HTMLButtonElement
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(document.querySelector('.sx-switch-label > span[aria-hidden]')?.textContent, '启用')
    await act(async () => { toggle.click() })
    assert.deepEqual(switchChanges, [true])

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('settings shell groups navigation, tracks the current section and applies reduced transparency', async () => {
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
    assert.deepEqual(groupLabels, ['通用', '助手', '内容', '隐私与数据', '关于'])

    const current = () => Array.from(nav.querySelectorAll('[aria-current="page"]')).map((node) => node.textContent)
    assert.deepEqual(current(), ['隐私'])
    assert.equal(document.querySelector('button[role="switch"][aria-label="文件涌现"]')?.getAttribute('aria-checked'), 'true', 'privacy rows render as switches')

    const appearance = Array.from(nav.querySelectorAll('button')).find((button) => button.textContent === '外观')!
    await act(async () => { appearance.click() })
    assert.deepEqual(current(), ['外观'])
    assert.ok(document.querySelector('[role="radiogroup"][aria-label="主题模式"]'))
    assert.equal(document.querySelector('[role="radiogroup"][aria-label="视觉风格"]'), null)
    assert.equal(document.querySelector('[role="radiogroup"][aria-label="主题色"]'), null)
    const reduce = document.querySelector('button[role="switch"][aria-label="减少透明"]') as HTMLButtonElement
    assert.ok(reduce)
    assert.equal(reduce.getAttribute('aria-checked'), 'false')
    await act(async () => { reduce.click() })
    assert.equal(reduce.getAttribute('aria-checked'), 'true')
    assert.equal(document.documentElement.getAttribute('data-transparency'), 'reduced')

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})
