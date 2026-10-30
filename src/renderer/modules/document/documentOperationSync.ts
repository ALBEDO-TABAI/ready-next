import { applyDocumentOperation, type DocumentSyncReply, type DocumentSyncRequest, type DocumentTabSnapshot } from '../../../shared/document-operations'
import { getDocumentSaveSerializationKey, runSerializedDocumentSave } from './documentSaveRegistry'

interface TabPort {
  tabs(): DocumentTabSnapshot[]
  replace(tab: DocumentTabSnapshot): void
}
interface Lease {
  path: string
  before: DocumentTabSnapshot[]
  after: DocumentTabSnapshot[]
  state: 'prepared' | 'applied' | 'released'
  release(): void
  timer: ReturnType<typeof setTimeout>
}
const pendingPaths = new Map<string, string>()
export function isDocumentOperationPending(path: string): boolean { return pendingPaths.has(path) }

export function createDocumentOperationSync(port: TabPort): (request: DocumentSyncRequest) => Promise<DocumentSyncReply> {
  const leases = new Map<string, Lease>()
  const closed = new Set<string>()
  const close = (id: string, lease: Lease) => {
    clearTimeout(lease.timer)
    if (pendingPaths.get(lease.path) === id) pendingPaths.delete(lease.path)
    lease.release()
    leases.delete(id)
    closed.add(id)
    if (closed.size > 256) closed.delete(closed.values().next().value!)
  }
  const matches = (expected: DocumentTabSnapshot[]) => {
    const current = port.tabs().filter((tab) => tab.path === expected[0]?.path)
    return current.length === expected.length && expected.every((tab) => current.some((item) => item.id === tab.id && item.path === tab.path && item.content === tab.content && item.isDirty === tab.isDirty))
  }
  const rollback = (lease: Lease, content?: string) => {
    if (lease.state === 'prepared') return
    if (!matches(lease.after)) throw new Error('Tab changed after synchronization; rollback would overwrite newer edits')
    for (const tab of lease.before) port.replace({ ...tab, content: tab.isDirty ? tab.content : content ?? tab.content })
  }
  return async (request) => {
    try {
      if (request.phase === 'prepare') {
        if (Date.now() >= request.deadline || closed.has(request.id)) throw new Error('Expired document synchronization')
        const existing = leases.get(request.id)
        if (existing) return { ok: true, tabs: existing.before, content: existing.after[0]?.content }
        return await new Promise<DocumentSyncReply>((resolve) => {
          const queue = runSerializedDocumentSave(getDocumentSaveSerializationKey('', request.path), async () => {
            if (Date.now() >= request.deadline || closed.has(request.id)) { resolve({ ok: false, message: 'Expired document synchronization' }); return }
            const before = port.tabs().filter((tab) => tab.path === request.path).map((tab) => ({ ...tab }))
            try {
              const dirty = before.some((tab) => tab.isDirty)
              if (dirty && before.some((tab) => tab.content !== before[0].content || !tab.isDirty)) throw new Error('Open buffers disagree')
              const next = applyDocumentOperation(dirty ? before[0].content : request.diskContent, request.operation)
              const after = before.map((tab) => ({ ...tab, content: next, isDirty: dirty }))
              let unlock!: () => void
              const held = new Promise<void>((done) => { unlock = done })
              const lease: Lease = { path: request.path, before, after, state: 'prepared', release: unlock, timer: setTimeout(() => {
                try { if (lease.state !== 'released') rollback(lease) } catch (error) { console.error('[document-operation-sync] lease rollback failed', error) }
                close(request.id, lease)
              }, Math.max(1, request.deadline - Date.now())) }
              if (typeof lease.timer === 'object' && 'unref' in lease.timer) lease.timer.unref()
              leases.set(request.id, lease)
              pendingPaths.set(request.path, request.id)
              resolve({ ok: true, tabs: before, content: next })
              await held
            } catch (error) { resolve({ ok: false, code: before.some((tab) => tab.isDirty) ? 'dirty_conflict' : 'operation_failed', message: String(error) }) }
          })
          void queue.catch((error) => resolve({ ok: false, message: String(error) }))
        })
      }
      const lease = leases.get(request.id)
      if (request.phase === 'rollback') {
        closed.add(request.id)
        if (lease) {
          try { rollback(lease, request.content) } finally { close(request.id, lease) }
        }
        return { ok: true, tabs: [] }
      }
      if (!lease || request.path !== lease.path || Date.now() >= request.deadline) throw new Error('Unknown or expired document synchronization')
      if (request.phase === 'commit') {
        if (lease.state === 'prepared') {
          const current = port.tabs().filter((tab) => tab.path === request.path)
          if (lease.before.length === 0 ? current.length !== 0 : !matches(lease.before)) throw new Error('Tab was closed or edited during synchronization')
          for (const tab of lease.after) port.replace(tab)
          lease.state = 'applied'
        }
        return { ok: true, tabs: lease.after, content: lease.after[0]?.content }
      }
      // Keep the snapshot until the deadline so a lost release acknowledgement
      // can still be compensated; releasing only unblocks ordinary saves.
      if (lease.state === 'prepared') throw new Error('Cannot release an unapplied operation')
      if (lease.after.length && !matches(lease.after)) throw new Error('Tab changed before release')
      lease.state = 'released'
      if (pendingPaths.get(lease.path) === request.id) pendingPaths.delete(lease.path)
      lease.release()
      return { ok: true, tabs: lease.after, content: lease.after[0]?.content }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  }
}
