import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

interface UserProfile {
  id: string
  name?: string
  preferredLanguage: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

interface UserProfilePayload {
  id?: string
  name?: string
  preferredLanguage?: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
}

interface UserProfileAPIStub {
  get: (id: string) => Promise<{ success: boolean; data?: UserProfile | null; error?: string }>
  list: () => Promise<{ success: boolean; data?: UserProfile[]; error?: string }>
  create: (payload: UserProfilePayload) => Promise<{ success: boolean; data?: UserProfile; error?: string }>
  update: (id: string, payload: UserProfilePayload) => Promise<{ success: boolean; error?: string }>
  delete: (id: string) => Promise<{ success: boolean; error?: string }>
}

interface PreviousGlobals {
  window: Window | undefined
  document: Document | undefined
  HTMLElement: typeof HTMLElement | undefined
  HTMLInputElement: typeof HTMLInputElement | undefined
  HTMLSelectElement: typeof HTMLSelectElement | undefined
  HTMLTextAreaElement: typeof HTMLTextAreaElement | undefined
  SVGElement: typeof SVGElement | undefined
  Node: typeof Node | undefined
  Element: typeof Element | undefined
  Event: typeof Event | undefined
  MouseEvent: typeof MouseEvent | undefined
  navigator: Navigator | undefined
}

function installDomGlobals(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  const previous: PreviousGlobals = {
    window: g.window as Window | undefined,
    document: g.document as Document | undefined,
    HTMLElement: g.HTMLElement as typeof HTMLElement | undefined,
    HTMLInputElement: g.HTMLInputElement as typeof HTMLInputElement | undefined,
    HTMLSelectElement: g.HTMLSelectElement as typeof HTMLSelectElement | undefined,
    HTMLTextAreaElement: g.HTMLTextAreaElement as typeof HTMLTextAreaElement | undefined,
    SVGElement: g.SVGElement as typeof SVGElement | undefined,
    Node: g.Node as typeof Node | undefined,
    Element: g.Element as typeof Element | undefined,
    Event: g.Event as typeof Event | undefined,
    MouseEvent: g.MouseEvent as typeof MouseEvent | undefined,
    navigator: g.navigator as Navigator | undefined,
  }

  function setGlobal(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('HTMLInputElement', dom.window.HTMLInputElement)
  setGlobal('HTMLSelectElement', dom.window.HTMLSelectElement)
  setGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement)
  setGlobal('SVGElement', dom.window.SVGElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  return {
    dom,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key]
        } else {
          Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
        }
      }
      delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
      try { dom.window.close() } catch { /* best-effort */ }
    },
  }
}

function installUserProfileAPI(dom: JSDOM, api: UserProfileAPIStub): void {
  ;(dom.window as Window & { electronAPI?: unknown }).electronAPI = {
    userProfile: api,
  }
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountEditor(dom: JSDOM): Promise<{ root: Root; document: Document }> {
  const [{ createRoot }, { default: UserProfileEditor }] = await Promise.all([
    import('react-dom/client'),
    import('../renderer/components/profile/UserProfileEditor'),
  ])
  const host = dom.window.document.getElementById('root')
  assert.ok(host, 'test root must exist')
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(UserProfileEditor))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flushAsync()
  return { root, document: dom.window.document }
}

function sampleProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'default-user',
    name: 'Mai',
    preferredLanguage: 'zh',
    communicationStyle: 'detailed',
    preferencesJson: { longTermPreferences: '先给结论' },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function getField<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  document: Document,
  label: string,
): T {
  const field = document.querySelector(`[aria-label="${label}"]`) as T | null
  assert.ok(field, `field ${label} must render`)
  return field
}

async function changeField(
  dom: JSDOM,
  field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const proto = field instanceof dom.window.HTMLSelectElement
      ? dom.window.HTMLSelectElement.prototype
      : field instanceof dom.window.HTMLTextAreaElement
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    assert.ok(setter, 'form field value setter must exist')
    setter.call(field, value)
    if (field instanceof dom.window.HTMLSelectElement) {
      field.dispatchEvent(new dom.window.Event('change', { bubbles: true, cancelable: true }))
    } else {
      field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, cancelable: true, data: value }))
      field.dispatchEvent(new dom.window.Event('change', { bubbles: true, cancelable: true }))
    }
  })
}

async function clickSave(dom: JSDOM, document: Document): Promise<void> {
  const saveButton = Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent?.includes('保存偏好')) as HTMLButtonElement | undefined
  assert.ok(saveButton, 'save button must render')
  await act(async () => {
    saveButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flushAsync()
}

test('UserProfileEditor loads only default-user and removes multi-user controls', async () => {
  const handle = installDomGlobals()
  const getCalls: string[] = []
  let listCalls = 0
  installUserProfileAPI(handle.dom, {
    get: async (id) => {
      getCalls.push(id)
      return { success: true, data: sampleProfile() }
    },
    list: async () => {
      listCalls += 1
      return { success: true, data: [] }
    },
    create: async () => ({ success: true, data: sampleProfile() }),
    update: async () => ({ success: true }),
    delete: async () => ({ success: true }),
  })

  const { root, document } = await mountEditor(handle.dom)
  try {
    assert.deepEqual(getCalls, ['default-user'])
    assert.equal(listCalls, 0)
    assert.equal(getField<HTMLInputElement>(document, '昵称').value, 'Mai')
    assert.equal(getField<HTMLSelectElement>(document, '语言').value, 'zh')
    assert.equal(getField<HTMLSelectElement>(document, '回复风格').value, 'detailed')
    assert.equal(getField<HTMLTextAreaElement>(document, '长期偏好').value, '先给结论')
    const text = document.body.textContent || ''
    assert.equal(text.includes('新建用户'), false)
    assert.equal(text.includes('删除'), false)
    assert.equal(text.includes('用户列表'), false)
  } finally {
    await act(async () => { root.unmount() })
    handle.restore()
  }
})

test('UserProfileEditor updates existing default-user with long-term preferences', async () => {
  const handle = installDomGlobals()
  const updateCalls: Array<{ id: string; payload: UserProfilePayload }> = []
  const createCalls: UserProfilePayload[] = []
  let storedProfile = sampleProfile({
    preferencesJson: { longTermPreferences: '旧偏好', keep: 'preserved' },
  })
  installUserProfileAPI(handle.dom, {
    get: async () => ({ success: true, data: storedProfile }),
    list: async () => ({ success: true, data: [] }),
    create: async (payload) => {
      createCalls.push(payload)
      return { success: true, data: storedProfile }
    },
    update: async (id, payload) => {
      updateCalls.push({ id, payload })
      storedProfile = {
        ...storedProfile,
        ...payload,
        id: storedProfile.id,
        preferredLanguage: payload.preferredLanguage || storedProfile.preferredLanguage,
        updatedAt: storedProfile.updatedAt + 1,
      }
      return { success: true }
    },
    delete: async () => ({ success: true }),
  })

  const { root, document } = await mountEditor(handle.dom)
  try {
    await changeField(handle.dom, getField<HTMLInputElement>(document, '昵称'), '白')
    await changeField(handle.dom, getField<HTMLSelectElement>(document, '语言'), 'en')
    await changeField(handle.dom, getField<HTMLSelectElement>(document, '回复风格'), 'concise')
    await changeField(handle.dom, getField<HTMLTextAreaElement>(document, '长期偏好'), '先给结论\n少寒暄')
    await clickSave(handle.dom, document)

    assert.equal(createCalls.length, 0)
    assert.equal(updateCalls.length, 1)
    assert.equal(updateCalls[0].id, 'default-user')
    assert.deepEqual(updateCalls[0].payload, {
      name: '白',
      preferredLanguage: 'en',
      communicationStyle: 'concise',
      preferencesJson: {
        keep: 'preserved',
        longTermPreferences: '先给结论\n少寒暄',
      },
    })
    assert.match(document.body.textContent || '', /我的偏好已保存/)
  } finally {
    await act(async () => { root.unmount() })
    handle.restore()
  }
})

test('UserProfileEditor creates default-user when the profile is missing', async () => {
  const handle = installDomGlobals()
  const createCalls: UserProfilePayload[] = []
  let storedProfile: UserProfile | null = null
  installUserProfileAPI(handle.dom, {
    get: async () => ({ success: true, data: storedProfile }),
    list: async () => ({ success: true, data: [] }),
    create: async (payload) => {
      createCalls.push(payload)
      storedProfile = sampleProfile({
        ...payload,
        id: 'default-user',
        preferredLanguage: payload.preferredLanguage || 'zh',
      })
      return { success: true, data: storedProfile }
    },
    update: async () => {
      throw new Error('update must not be called for a missing default-user profile')
    },
    delete: async () => ({ success: true }),
  })

  const { root, document } = await mountEditor(handle.dom)
  try {
    await changeField(handle.dom, getField<HTMLInputElement>(document, '昵称'), '新用户')
    await changeField(handle.dom, getField<HTMLTextAreaElement>(document, '长期偏好'), '中文回答')
    await clickSave(handle.dom, document)

    assert.equal(createCalls.length, 1)
    assert.deepEqual(createCalls[0], {
      id: 'default-user',
      name: '新用户',
      preferredLanguage: 'zh',
      communicationStyle: '',
      preferencesJson: {
        longTermPreferences: '中文回答',
      },
    })
  } finally {
    await act(async () => { root.unmount() })
    handle.restore()
  }
})

test('UserProfileEditor shows a clear save error when IPC reports failure', async () => {
  const handle = installDomGlobals()
  installUserProfileAPI(handle.dom, {
    get: async () => ({ success: true, data: sampleProfile() }),
    list: async () => ({ success: true, data: [] }),
    create: async () => ({ success: true, data: sampleProfile() }),
    update: async () => ({ success: false, error: 'database locked' }),
    delete: async () => ({ success: true }),
  })

  const { root, document } = await mountEditor(handle.dom)
  try {
    await clickSave(handle.dom, document)
    const text = document.body.textContent || ''
    assert.match(text, /保存失败：database locked/)
    assert.equal(text.includes('我的偏好已保存'), false)
  } finally {
    await act(async () => { root.unmount() })
    handle.restore()
  }
})
