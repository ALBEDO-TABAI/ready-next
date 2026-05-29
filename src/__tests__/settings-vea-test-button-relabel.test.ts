/**
 * Stage Y1.1 — Settings vision-model test button honest relabel behavior test
 * (path-(b) per plan §11.1).
 *
 * Sub-plan: docs/superpowers/plans/archive/2026-05-23-Y1-1-vea-test-reliability-implementation.md
 *
 * Path-(b) (honest label) is the chosen disposition for Y1.1 — the Settings
 * external-services `测试` button for `kind === 'vision-model'` profiles
 * relabels to `仅校验字段` (Validate fields only) and disables when required
 * fields are missing, because the main-process testResolvedProfile() for
 * vision-model ONLY field-validates (no HTTP probe — see
 * `src/main/modules/settings-engine/external-service-store.ts:342-344,390`).
 * Other kinds (amap / jina / rsshub / duckduckgo) DO probe and stay labeled
 * `测试`. Stage Z owns the real per-`apiKind` probe adapter.
 *
 * Mount strategy follows `settings-cache-quota-relabel.test.ts`: jsdom +
 * createRoot + flushSync; electronAPI.settings.listExternalServices stub
 * returns one vision-model (missing apiKey) + one amap (configured) profile.
 *
 * Filename uses `.test.ts` (no `.tsx`) because the file uses `createElement`
 * instead of JSX so it can be discovered by `scripts/run-parallel-tests.cjs`
 * which globs `src/__tests__/*.test.ts` only.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type {
  ExternalServiceTestResult,
  ExternalServiceUpdateInput,
  PublicExternalServiceProfile,
} from '../shared/external-services'

interface PreviousGlobals {
  window: Window | undefined
  document: Document | undefined
  HTMLElement: typeof HTMLElement | undefined
  Node: typeof Node | undefined
  Element: typeof Element | undefined
  requestAnimationFrame: typeof requestAnimationFrame | undefined
  cancelAnimationFrame: typeof cancelAnimationFrame | undefined
  getComputedStyle: typeof getComputedStyle | undefined
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
    Node: g.Node as typeof Node | undefined,
    Element: g.Element as typeof Element | undefined,
    requestAnimationFrame: g.requestAnimationFrame as typeof requestAnimationFrame | undefined,
    cancelAnimationFrame: g.cancelAnimationFrame as typeof cancelAnimationFrame | undefined,
    getComputedStyle: g.getComputedStyle as typeof getComputedStyle | undefined,
    navigator: g.navigator as Navigator | undefined,
  }

  function setGlobal(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  setGlobal('cancelAnimationFrame', () => undefined)
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobal('navigator', dom.window.navigator)
  const matchMediaStub = (_q: string) => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  })
  Object.defineProperty(dom.window, 'matchMedia', { value: matchMediaStub, configurable: true, writable: true })
  setGlobal('matchMedia', matchMediaStub)

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
      try { dom.window.close() } catch { /* best-effort */ }
    },
  }
}

interface ElectronAPIStubResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

interface StubBag {
  profiles: PublicExternalServiceProfile[]
  testCalls: ExternalServiceUpdateInput[]
  updateCalls?: ExternalServiceUpdateInput[]
}

function makeVisionProfile(overrides: Partial<PublicExternalServiceProfile> = {}): PublicExternalServiceProfile {
  return {
    id: 'vision-model-default',
    kind: 'vision-model',
    name: 'Vision Model',
    enabled: false,
    baseUrl: '',
    options: { model: '', provider: '', apiKind: 'openai-completions', inputModes: ['text', 'image'] },
    // No apiKey configured — required field missing.
    secretStatus: { apiKey: { configured: false } },
    ...overrides,
  }
}

function makeAmapProfile(overrides: Partial<PublicExternalServiceProfile> = {}): PublicExternalServiceProfile {
  return {
    id: 'amap-default',
    kind: 'amap',
    name: 'Amap',
    enabled: true,
    baseUrl: 'https://restapi.amap.com',
    options: {},
    secretStatus: { apiKey: { configured: true, masked: '****1234' } },
    ...overrides,
  }
}

function installElectronAPIStub(dom: JSDOM, bag: StubBag): void {
  const settings = {
    listExternalServices: async (): Promise<ElectronAPIStubResult<PublicExternalServiceProfile[]>> => ({
      success: true,
      data: bag.profiles,
    }),
    updateExternalService: async (input: ExternalServiceUpdateInput): Promise<ElectronAPIStubResult<PublicExternalServiceProfile>> => {
      bag.updateCalls?.push(input)
      const existing = bag.profiles.find((p) => p.id === input.id)
      return { success: true, data: existing }
    },
    resetExternalService: async (input: { id: string }): Promise<ElectronAPIStubResult<PublicExternalServiceProfile>> => {
      const existing = bag.profiles.find((p) => p.id === input.id)
      return { success: true, data: existing }
    },
    testExternalServiceDraft: async (input: ExternalServiceUpdateInput): Promise<ElectronAPIStubResult<ExternalServiceTestResult>> => {
      bag.testCalls.push(input)
      return {
        success: true,
        data: { ok: true, serviceId: input.id, message: '配置已就绪', latencyMs: 1 },
      }
    },
  }
  ;(dom.window as Window & { electronAPI?: unknown }).electronAPI = { settings }
}

async function flushAsync(): Promise<void> {
  // act() needed because ExternalServicesSettingsPanel mounts useEffect that
  // calls listExternalServices() → setProfiles(...) → useEffect on profiles
  // → setSelectedId(...). Without act the second setState batch is not
  // flushed before assertions run. The "not configured to support act"
  // warning is benign for node:test + jsdom + createRoot harness.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

test('Y1.1 — vision-model profile: button shows honest "仅校验字段" label + is disabled when fields missing + renders inline help', async () => {
  const handle = installDomGlobals()
  const bag: StubBag = {
    profiles: [makeVisionProfile()],
    testCalls: [],
  }
  installElectronAPIStub(handle.dom, bag)

  const { ExternalServicesSettingsPanel } = await import('../renderer/pages/Settings')

  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => { root.render(createElement(ExternalServicesSettingsPanel)) })
    await flushAsync()
    flushSync(() => { /* drain post-resolve state updates */ })

    const buttons = Array.from(handle.dom.window.document.querySelectorAll('button'))
    const testButton = buttons.find((b) => (b as HTMLButtonElement).getAttribute('data-vea-test-button') === 'fields-only') as HTMLButtonElement | undefined

    assert.ok(testButton, 'vision-model test button with data-vea-test-button="fields-only" must render')
    assert.ok(
      testButton.textContent?.includes('仅校验字段'),
      `expected button text to contain "仅校验字段"; got: "${testButton.textContent}"`,
    )
    assert.ok(
      !testButton.textContent?.includes('测试中') && !/^测试$/.test((testButton.textContent || '').trim()),
      `vision-model button must NOT show plain "测试" / "测试中"; got: "${testButton.textContent}"`,
    )
    assert.equal(testButton.disabled, true, 'button must be disabled when required fields are missing')

    const helpEl = handle.dom.window.document.querySelector('[data-vea-test-help]')
    assert.ok(helpEl, 'inline help text element [data-vea-test-help] must render for vision-model profile')
    const helpText = helpEl?.textContent || ''
    assert.ok(
      helpText.includes('仅校验字段，不发起真实请求'),
      `help text must contain CN copy "仅校验字段，不发起真实请求"; got: "${helpText}"`,
    )
    assert.ok(
      helpText.includes('Validates fields only'),
      `help text must contain EN copy "Validates fields only"; got: "${helpText}"`,
    )
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})

test('Y1.1 — vision-model disabled button: clicking does NOT invoke testExternalServiceDraft IPC', async () => {
  const handle = installDomGlobals()
  const bag: StubBag = {
    profiles: [makeVisionProfile()],
    testCalls: [],
  }
  installElectronAPIStub(handle.dom, bag)

  const { ExternalServicesSettingsPanel } = await import('../renderer/pages/Settings')

  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => { root.render(createElement(ExternalServicesSettingsPanel)) })
    await flushAsync()
    flushSync(() => { /* drain */ })

    const buttons = Array.from(handle.dom.window.document.querySelectorAll('button'))
    const testButton = buttons.find((b) => (b as HTMLButtonElement).getAttribute('data-vea-test-button') === 'fields-only') as HTMLButtonElement | undefined
    assert.ok(testButton, 'vision-model test button must render')

    // DOM-level click on a disabled button is a no-op (the JSX disabled=true
    // both prevents pointer activation AND any synthetic React invocation).
    testButton?.click()
    await flushAsync()

    assert.equal(
      bag.testCalls.length,
      0,
      `disabled vision-model button must NOT fire testExternalServiceDraft; got ${bag.testCalls.length} call(s)`,
    )
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})

test('Y1.1 — non-vision-model profile (amap) keeps the original "测试" label (does NOT relabel)', async () => {
  const handle = installDomGlobals()
  // Only amap, so it becomes the selected profile.
  const bag: StubBag = {
    profiles: [makeAmapProfile()],
    testCalls: [],
  }
  installElectronAPIStub(handle.dom, bag)

  const { ExternalServicesSettingsPanel } = await import('../renderer/pages/Settings')

  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => { root.render(createElement(ExternalServicesSettingsPanel)) })
    await flushAsync()
    flushSync(() => { /* drain */ })

    const buttons = Array.from(handle.dom.window.document.querySelectorAll('button'))
    const probeButton = buttons.find((b) => (b as HTMLButtonElement).getAttribute('data-vea-test-button') === 'probe') as HTMLButtonElement | undefined

    assert.ok(probeButton, 'non-vision-model probe test button with data-vea-test-button="probe" must render')
    assert.ok(
      /测试/.test(probeButton.textContent || '') && !(probeButton.textContent || '').includes('仅校验字段'),
      `amap button text must keep "测试" framing (NOT vision-model relabel); got: "${probeButton.textContent}"`,
    )
    assert.equal(probeButton.disabled, false, 'amap button (apiKey configured) must NOT be disabled')

    // No vision-only help text leaks into non-vision profiles.
    const helpEl = handle.dom.window.document.querySelector('[data-vea-test-help]')
    assert.equal(helpEl, null, 'inline vision help text must NOT render for non-vision-model profile')
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})

test('Y1.1 — configured external-service secrets can be marked for clearing and draft-test/save carry clearSecrets', async () => {
  const handle = installDomGlobals()
  const bag: StubBag = {
    profiles: [makeAmapProfile()],
    testCalls: [],
    updateCalls: [],
  }
  installElectronAPIStub(handle.dom, bag)

  const { ExternalServicesSettingsPanel } = await import('../renderer/pages/Settings')

  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => { root.render(createElement(ExternalServicesSettingsPanel)) })
    await flushAsync()
    flushSync(() => { /* drain */ })

    const clearButton = handle.dom.window.document.querySelector('[data-external-secret-clear="amap-default:apiKey"]') as HTMLButtonElement | null
    assert.ok(clearButton, 'configured Amap apiKey should render a clear button')
    assert.equal(clearButton.textContent?.trim(), '清除')

    clearButton.click()
    await flushAsync()

    const textAfterClear = handle.dom.window.document.body.textContent || ''
    assert.ok(
      textAfterClear.includes('将清除 1 项密钥'),
      `clear intent should be visible in the panel summary; got: ${textAfterClear.slice(0, 500)}`,
    )

    const buttons = Array.from(handle.dom.window.document.querySelectorAll('button'))
    const testButton = buttons.find((b) => (b as HTMLButtonElement).getAttribute('data-vea-test-button') === 'probe') as HTMLButtonElement | undefined
    assert.ok(testButton, 'Amap probe button should render')
    testButton.click()
    await flushAsync()

    assert.equal(bag.testCalls.length, 1)
    assert.deepEqual(bag.testCalls[0].clearSecrets, ['apiKey'])
    assert.deepEqual(bag.testCalls[0].secrets, {})

    const saveButton = Array.from(handle.dom.window.document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').trim() === '保存') as HTMLButtonElement | undefined
    assert.ok(saveButton, 'save button should render')
    saveButton.click()
    await flushAsync()

    assert.equal(bag.updateCalls?.length, 1)
    assert.deepEqual(bag.updateCalls?.[0].clearSecrets, ['apiKey'])
    assert.deepEqual(bag.updateCalls?.[0].secrets, {})
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})
