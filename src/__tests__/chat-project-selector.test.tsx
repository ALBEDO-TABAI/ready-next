import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { prepareFileDragRef } from '../renderer/modules/workbench/file-drag-ref'
import { buildWorkspaceDragPayload, writeWorkspaceDragData } from '../renderer/components/layout/fileTreeDragPayload'
import { beginWorkspaceDragSession, endWorkspaceDragSession } from '../renderer/components/layout/workspaceDragSession'

test('project selector selects, clears, rejects files and ignores a picker returning after chat switch', async () => {
  const dom = new JSDOM('<div data-chat-panel-root="true"><div id="root"></div></div>', { url: 'http://localhost' })
  const old = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  dom.window.HTMLElement.prototype.attachEvent = (() => {}) as never
  dom.window.HTMLElement.prototype.detachEvent = (() => {}) as never
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const { ProjectSelector } = await import('../renderer/components/agent/ProjectSelector')
  const previousAgent = useAgent.getState()
  const previousWorkspace = useWorkspace.getState()
  const scope = { id: 'project-a', sourceKind: 'local', messageVisibilityEpoch: 0, meta: {} } as NonNullable<ReturnType<typeof useAgent.getState>['currentScope']>
  useAgent.setState({ currentScope: scope, scopes: [scope], retiredScopeIds: {} })
  useWorkspace.setState({ workspaceRoot: '/project/first', pinnedFolders: ['/project/second'] })
  const saves: Array<[string, string | null]> = []
  let pick: () => Promise<unknown> = async () => ({ success: false, error: 'cancelled' })
  Object.defineProperty(dom.window, 'electronAPI', { value: {
    document: { openFolder: () => pick() },
    objects: { resolvePath: async (path: string) => ({ objectId: path, path }) },
    agent: { setProjectDirectory: async (id: string, path: string | null, epoch: number) => {
      if (path === '/file.txt') return { success: false, error: '请选择文件夹' }
      saves.push([id, path])
      return { success: true, data: { id, sourceKind: 'local', messageVisibilityEpoch: epoch, meta: { projectDirectory: path } } }
    } }, getFilePathFromDrop: () => '/native-folder',
  } })
  const root = createRoot(dom.window.document.getElementById('root')!)
  const click = async (selector: string) => { await act(async () => { (dom.window.document.querySelector(selector) as HTMLElement).click() }) }
  try {
    await act(async () => root.render(createElement(ProjectSelector)))
    await click('[data-project-trigger]')
    await click('button[title="/project/first"]')
    assert.equal(useAgent.getState().currentScope?.meta.projectDirectory, '/project/first')
    await click('button[aria-label="取消项目选择"]')
    assert.equal(useAgent.getState().currentScope?.meta.projectDirectory, null)
    const drop = async (path: string, isDirectory: boolean) => {
      await prepareFileDragRef(path, isDirectory)
      const payload = buildWorkspaceDragPayload({ path, name: path.split('/').pop()!, isDirectory, size: 0, modified: new Date() }, true)
      const data = new Map<string, string>()
      const dataTransfer = { files: [], effectAllowed: 'uninitialized' as DataTransfer['effectAllowed'],
        setData: (format: string, value: string) => { data.set(format, value) }, getData: (format: string) => data.get(format) || '' }
      beginWorkspaceDragSession([payload])
      writeWorkspaceDragData(dataTransfer, payload)
      const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      try { await act(async () => dom.window.document.querySelector('[data-chat-project-selector]')!.dispatchEvent(event)) }
      finally { endWorkspaceDragSession() }
    }
    await drop('/project/dropped', true)
    assert.equal(useAgent.getState().currentScope?.meta.projectDirectory, '/project/dropped')
    await drop('/file.txt', false)
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /文件夹/)
    assert.equal(useAgent.getState().currentScope?.meta.projectDirectory, '/project/dropped')
    let resolvePicker!: (value: unknown) => void
    pick = () => new Promise((resolve) => { resolvePicker = resolve })
    await click('[data-project-trigger]')
    const pickerButton = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent?.includes('选择其他文件夹'))!
    await act(async () => pickerButton.click())
    await act(async () => useAgent.setState({ currentScope: { ...scope, id: 'project-b', meta: {} } }))
    await act(async () => resolvePicker({ success: true, path: '/late-folder' }))
    assert.equal(useAgent.getState().currentScope?.meta.projectDirectory, undefined)
    assert.equal(saves.some(([, path]) => path === '/late-folder'), false)
  } finally {
    await act(async () => root.unmount())
    useAgent.setState(previousAgent, true); useWorkspace.setState(previousWorkspace, true)
    dom.window.close()
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
