import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { FileWatcherRegistry, type FileWatcherHandle } from '../main/modules/search-engine/file-watcher'
import { watcherGroup, type WatcherGroupDeps } from '../main/modules/search-engine/ipc/watcher-group'

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => Promise<{ success: boolean; data?: { watcherId: string } }>

test('a renderer reload or closed window releases the file watchers it started; in-page navigation keeps them', async () => {
  const handlers = new Map<string, Handler>()
  const ipc = { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => {} } as unknown as IpcMain
  const registry = new FileWatcherRegistry()
  const closed: string[] = []
  let next = 0
  const deps: WatcherGroupDeps = {
    getSearchEngine: (() => ({ getRepository: () => ({ getConnection: () => ({}) }) })) as unknown as WatcherGroupDeps['getSearchEngine'],
    createFileWatcher: (async ({ workspaceRoot }: { workspaceRoot: string }) => {
      const id = `w${++next}`
      let isClosed = false
      const handle: FileWatcherHandle = {
        id, workspaceRoot,
        isClosed: () => isClosed,
        onFatalError: () => () => {},
        close: async () => { if (!isClosed) { isClosed = true; closed.push(id) } },
      }
      return handle
    }) as unknown as WatcherGroupDeps['createFileWatcher'],
    getFileWatcherRegistry: () => registry,
  }
  watcherGroup.register(ipc, deps)
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: () => {} }) as unknown as WebContents
  const start = async () => {
    const result = await handlers.get('document:startWatcher')!({ sender } as IpcMainInvokeEvent, { workspaceRoot: '/vault' })
    assert.equal(result.success, true)
    return result.data!.watcherId
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))

  const first = await start()
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  await settle()
  assert.ok(registry.has(first), 'hash routes and iframes keep the watcher')

  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await settle()
  assert.ok(!registry.has(first) && closed.includes(first), 'a reload releases the watcher')
  assert.equal((sender as unknown as EventEmitter).listenerCount('did-start-navigation'), 0)

  const second = await start()
  await handlers.get('document:stopWatcher')!({ sender } as IpcMainInvokeEvent, { watcherId: second })
  assert.ok(closed.includes(second))
  assert.equal((sender as unknown as EventEmitter).listenerCount('did-start-navigation'), 0, 'an explicit stop unbinds from the renderer')
  assert.equal((sender as unknown as EventEmitter).listenerCount('destroyed'), 0)

  const third = await start()
  sender.emit('destroyed')
  await settle()
  assert.ok(!registry.has(third) && closed.includes(third), 'a closed window releases the watcher')
})
