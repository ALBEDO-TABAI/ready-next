import { watch, type FSWatcher } from 'chokidar'
import { join } from 'node:path'
import { LIBRARY_FOLDER, type LibraryState } from '../../../shared/library'
import type { LibraryEngine } from './library-engine'

/** Poll only vault availability/configuration; filesystem events trigger book scans. */
export function watchLibrary(engine: LibraryEngine, changed: (state: LibraryState) => void, onError: (error: unknown) => void): () => Promise<void> {
  let closed = false
  let root: string | null | undefined
  let watcher: FSWatcher | undefined
  let refresh: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let pending = Promise.resolve()
  const publish = async () => {
    const state = await engine.get()
    if (!closed && (state.status === 'ready' ? state.vaultRoot : null) === engine.vaultRoot()) changed(state)
  }
  const scheduleRefresh = () => {
    clearTimeout(refresh)
    refresh = setTimeout(() => {
      pending = pending.then(publish).catch(onError)
    }, 50)
  }
  const checkRoot = async () => {
    const next = engine.vaultRoot()
    if (next === root) return
    await watcher?.close()
    watcher = undefined
    root = next
    if (closed) return
    if (root) {
      watcher = watch(join(root, LIBRARY_FOLDER), { ignoreInitial: true, followSymlinks: false })
      watcher.on('all', scheduleRefresh).on('error', onError)
      await new Promise<void>((resolve, reject) => {
        watcher!.once('ready', resolve).once('error', reject)
      })
    }
    await publish()
  }
  const tick = () => {
    pending = pending.then(checkRoot).catch(onError).finally(() => {
      if (!closed) { poll = setTimeout(tick, 1000); poll.unref() }
    })
  }
  tick()
  return async () => {
    closed = true
    clearTimeout(refresh)
    clearTimeout(poll)
    await pending
    await watcher?.close()
  }
}
