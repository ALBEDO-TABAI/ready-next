import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import type { RuntimeProvisionTaskSnapshot, RuntimeStatus } from '../shared/runtime-provision-types'

const NOT_READY: RuntimeStatus = {
  platformSupported: true,
  python: { ready: false },
  ffmpeg: { ready: false },
  ffprobe: { ready: false },
  coreDeps: { ready: false, missing: ['video-expert-analyzer'] },
  overallReady: false,
}

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
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
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return {
    dom,
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as unknown as Record<string, unknown>)[key]
      }
      dom.window.close()
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mount(element: ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  await flush()
  return { root, container }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
  await flush()
}

test('runtime environment card restores an in-flight task after settings remount', async () => {
  const handle = installDom()
  try {
    const { RuntimeEnvironmentCard } = await import('../renderer/components/settings/ModelsRuntimeSettingsPanel')
    let snapshot: RuntimeProvisionTaskSnapshot = {
      runId: 'runtime-1',
      revision: 2,
      state: 'running',
      startedAt: 10,
      updatedAt: 20,
      progress: { assetId: 'python', phase: 'download', receivedBytes: 50, totalBytes: 100 },
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      skills: {
        getSkillRuntimeStatus: async () => ({ success: true, data: NOT_READY }),
        getSkillRuntimeProvisionState: async () => ({ success: true, data: snapshot }),
        getSkillRuntimeMirror: async () => ({ success: true, data: '' }),
        onSkillRuntimeProvisionUpdate: () => () => {},
        provisionSkillRuntime: async () => ({ success: false, error: 'must not start while running' }),
        cancelSkillRuntimeProvision: async () => ({ success: true, data: snapshot }),
        setSkillRuntimeMirror: async () => ({ success: true }),
      },
    }

    const first = await mount(createElement(RuntimeEnvironmentCard))
    assert.match(first.container.textContent || '', /正在下载 python/)
    assert.match(first.container.textContent || '', /50%/)
    assert.equal(first.container.querySelector('button')?.disabled, true)
    await unmount(first.root)

    const second = await mount(createElement(RuntimeEnvironmentCard))
    assert.match(second.container.textContent || '', /正在下载 python/)
    assert.match(second.container.textContent || '', /50%/)
    assert.equal(second.container.querySelector('button')?.disabled, true)
    await unmount(second.root)

    snapshot = {
      runId: 'runtime-1',
      revision: 3,
      state: 'failed',
      startedAt: 10,
      updatedAt: 30,
      finishedAt: 30,
      errorKind: 'runtime_setup_failed',
      error: '核心依赖安装失败',
    }
    const failed = await mount(createElement(RuntimeEnvironmentCard))
    assert.match(failed.container.textContent || '', /核心依赖安装失败/)
    assert.equal(failed.container.querySelector('button')?.disabled, false)
    await unmount(failed.root)
  } finally {
    handle.restore()
  }
})

test('runtime environment card can stop an in-flight task and shows cancelling state', async () => {
  const handle = installDom()
  try {
    const { RuntimeEnvironmentCard } = await import('../renderer/components/settings/ModelsRuntimeSettingsPanel')
    const running: RuntimeProvisionTaskSnapshot = {
      runId: 'runtime-stop',
      revision: 4,
      state: 'running',
      startedAt: 10,
      updatedAt: 20,
      progress: { assetId: 'ffmpeg', phase: 'download', receivedBytes: 20, totalBytes: 100 },
    }
    const cancelling: RuntimeProvisionTaskSnapshot = {
      ...running,
      revision: 5,
      state: 'cancelling',
      updatedAt: 30,
    }
    let cancelCalls = 0
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      skills: {
        getSkillRuntimeStatus: async () => ({ success: true, data: NOT_READY }),
        getSkillRuntimeProvisionState: async () => ({ success: true, data: running }),
        getSkillRuntimeMirror: async () => ({ success: true, data: '' }),
        onSkillRuntimeProvisionUpdate: () => () => {},
        provisionSkillRuntime: async () => ({ success: false, error: 'must not start while running' }),
        cancelSkillRuntimeProvision: async () => {
          cancelCalls += 1
          return { success: true, data: cancelling }
        },
        setSkillRuntimeMirror: async () => ({ success: true }),
      },
    }

    const mounted = await mount(createElement(RuntimeEnvironmentCard))
    const stopButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '停止')
    assert.ok(stopButton, 'running task must expose a stop button')

    await act(async () => {
      stopButton.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(cancelCalls, 1)
    assert.match(mounted.container.textContent || '', /正在停止/)
    const cancellingButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('正在停止'))
    assert.equal(cancellingButton?.disabled, true)
    await unmount(mounted.root)
  } finally {
    handle.restore()
  }
})
