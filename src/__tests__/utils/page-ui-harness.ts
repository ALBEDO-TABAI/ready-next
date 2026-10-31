import assert from 'node:assert/strict'
import { act, createElement, Fragment, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import type { DocumentPagesAPI, PageChange, PageNode, PageOperation, PageProperties, PageResult, PageTrashEntry, PageUserState } from '../../shared/document-pages'

export function pageNode(id: string, children: PageNode[] = [], kind: PageNode['kind'] = 'page'): PageNode {
  return { objectId: id, revision: 1, path: `/vault/${id}.md`, name: `${id}.md`, kind, title: id, children, hasChildren: children.length > 0, position: 0 }
}
export const success = <T,>(value: T): PageResult<T> => ({ ok: true, value })

export function pageAPI(tree: PageNode) {
  const calls: PageOperation[] = [], orders: { parent: string; ids: string[] }[] = [], patches: PageProperties[] = []
  const states: PageUserState[] = []
  let trash: PageTrashEntry[] = []
  let properties: PageProperties = { title: 'A', icon: '🌱' }
  let version = 'v1'
  const listeners = new Set<(event: PageChange) => void>()
  let restoreConflict = false, treeCalls = 0
  const find = (id: string, node = tree): PageNode | undefined => node.objectId === id ? node : node.children.map(child => find(id, child)).find(Boolean)
  const detach = (id: string, node = tree): PageNode | undefined => {
    const index = node.children.findIndex(child => child.objectId === id)
    if (index >= 0) return node.children.splice(index, 1)[0]
    return node.children.map(child => detach(id, child)).find(Boolean)
  }
  const api: DocumentPagesAPI = {
    tree: async () => { treeCalls++; return success(structuredClone(tree)) },
    properties: async () => success({ properties: structuredClone(properties), version }),
    patchProperties: async (_id, expected, set, remove) => {
      assert.equal(expected, version)
      patches.push(set); properties = { ...properties, ...set, ready_page: { ...properties.ready_page, ...set.ready_page } }
      for (const key of remove || []) delete properties[key]
      version += 'p'; return success({ version })
    },
    operate: async input => {
      calls.push(input)
      const id = input.type === 'create' ? `created-${calls.length}` : input.objectId
      if (input.type === 'rename') { const node = find(id); if (node) node.title = input.title; properties.title = input.title; version += 'r' }
      if (input.type === 'create') { const parent = find(input.parentObjectId || tree.objectId)!; const node = pageNode(id); node.title = input.title; parent.children.push(node); parent.hasChildren = true }
      if (input.type === 'move') { const parent = find(input.parentObjectId || tree.objectId)!; const node = detach(id)!; parent.children.push(node); parent.hasChildren = true }
      if (input.type === 'trash') { const node = detach(id)!; trash.push({ operationId: input.operationId, state: 'committed', objectId: id, revision: 2, path: null, originalPath: node.path, trashedPath: `/vault/.ready/trash/${id}`, title: node.title, parentObjectId: tree.objectId }) }
      if (input.type === 'restore') {
        if (restoreConflict && !input.parentObjectId) return { ok: false, code: 'name_collision', message: '原位置重名', candidateNames: ['A (2)'] }
        const item = trash.find(item => item.objectId === id)!
        find(input.parentObjectId || tree.objectId)!.children.push({ ...pageNode(id), title: item.title })
        trash = trash.filter(item => item.objectId !== id)
      }
      if (input.type === 'delete') trash = trash.filter(item => item.objectId !== id)
      listeners.forEach(listener => listener({ operationId: input.operationId, objectId: id, revision: 2 }))
      return success({ operationId: input.operationId, state: 'committed', objectId: id, revision: 2, path: `/vault/${id}.md` })
    },
    operation: async () => success(null), trash: async () => success([...trash]),
    order: async (parent, ids) => { orders.push({ parent, ids }); const node = find(parent)!; node.children.sort((a, b) => ids.indexOf(a.objectId) - ids.indexOf(b.objectId)); return success(undefined) },
    favorite: async (objectId, favorite) => { const state = states.find(state => state.objectId === objectId); if (state) state.favorite = favorite; else states.push({ objectId, favorite, lastVisitedAt: null }); listeners.forEach(listener => listener({ operationId: 'favorite', objectId, revision: 1 })); return success(undefined) },
    visit: async objectId => { const state = states.find(state => state.objectId === objectId); if (state) state.lastVisitedAt = 100; else states.push({ objectId, favorite: false, lastVisitedAt: 100 }); listeners.forEach(listener => listener({ operationId: 'visit', objectId, revision: 1 })); return success(undefined) },
    states: async () => success([...states]),
    save: async input => success({ path: input.path, beforeVersion: input.expectedVersion, afterVersion: 'next', committedAt: 1 }),
    onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
  }
  return { api, calls, orders, patches, setRestoreConflict: () => { restoreConflict = true }, get treeCalls() { return treeCalls }, get subscribed() { return listeners.size > 0 } }
}

export async function mountPageUI() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage, ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const { createRoot } = await import('react-dom/client')
  const { OverlayHost } = await import('../../renderer/modules/document/ink/overlay')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const body = dom.window.document.body
  const click = async (name: string, within: ParentNode = body) => {
    const button = [...within.querySelectorAll<HTMLElement>('button, [role=button], [role=menuitem], [role=radio], [role=menuitemcheckbox]')].find(button => button.textContent === name || button.getAttribute('aria-label') === name)
    assert.ok(button, `Missing button: ${name}`)
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })); button.click() })
  }
  const input = async (label: string, value: string) => {
    const element = body.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
    assert.ok(element, label)
    const prototype = element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  return { dom, body, click, input, render: async (node: ReactNode) => { await act(async () => root.render(createElement(Fragment, null, node, createElement(OverlayHost)))) },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } },
  }
}
