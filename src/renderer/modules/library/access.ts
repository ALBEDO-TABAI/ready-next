import type { LibraryReadingPosition, LibraryResult } from '../../../shared/library'

/** The only IPC boundary; L1a owns the implementation and shared payload types. */
export type LibraryAPI = Window['electronAPI']['library']

export function getLibraryAPI(): LibraryAPI {
  const api = window.electronAPI?.library
  if (!api) throw new Error('书房接口尚未就绪，请重启 Ready Next 后重试。')
  return api
}

export function confirmed<T>(result: LibraryResult<T>): T {
  if (!result.success) throw new Error(result.error)
  return result.data
}

// One writer per API/book; an old reader's pending save cannot overtake a new one.
const positionTails = new WeakMap<LibraryAPI, Map<string, Promise<void>>>()
export function savePosition(api: LibraryAPI, position: LibraryReadingPosition): Promise<void> {
  let tails = positionTails.get(api)
  if (!tails) { tails = new Map(); positionTails.set(api, tails) }
  const previous = tails.get(position.bookId) ?? Promise.resolve()
  const result = previous.then(async () => { confirmed(await api.setPosition(position)) })
  const settled = result.then(() => {}, () => {}) // caller receives the failure; the next save can retry
  tails.set(position.bookId, settled)
  void settled.then(() => { if (tails.get(position.bookId) === settled) tails.delete(position.bookId) })
  return result
}
