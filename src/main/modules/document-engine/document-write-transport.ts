import type { DocumentSyncReply, DocumentSyncRequest } from '../../../shared/document-operations'
import type { DocumentTabTransport } from './document-write-service'

export interface DocumentSyncEndpoint {
  id: number
  request(request: DocumentSyncRequest): Promise<DocumentSyncReply>
}

// Freeze recipients for the transaction: a closing window must never turn a
// prepared dirty document into a successful "not open" acknowledgement.
export function createDocumentTabTransport(owners: () => DocumentSyncEndpoint[]): DocumentTabTransport {
  const transactions = new Map<string, DocumentSyncEndpoint[]>()
  return async (request) => {
    if (request.phase === 'prepare' && !transactions.has(request.id)) {
      transactions.set(request.id, owners())
      const timer = setTimeout(() => transactions.delete(request.id), Math.max(1, request.deadline - Date.now()) + 10_000)
      timer.unref()
    }
    const recipients = transactions.get(request.id)
    if (!recipients) return { ok: false, message: 'Unknown document synchronization transaction' }
    if (request.phase !== 'rollback') {
      const current = owners()
      if (current.length !== recipients.length || recipients.some((owner) => !current.some((item) => item.id === owner.id))) {
        return { ok: false, message: 'Document window membership changed during synchronization' }
      }
    }
    const results = await Promise.all(recipients.map((owner) => owner.request(request)))
    const failed = results.find((reply) => !reply.ok)
    if (failed) return failed
    const successful = results.filter((reply): reply is Extract<DocumentSyncReply, { ok: true }> => reply.ok)
    const tabs = successful.flatMap((reply) => reply.tabs)
    const contents = successful.filter((reply) => reply.tabs.length > 0).map((reply) => reply.content)
    if (contents.some((content) => content !== contents[0]) || (tabs.some((tab) => tab.isDirty) && tabs.some((tab) => !tab.isDirty))) {
      return { ok: false, message: 'Document buffers disagree across windows' }
    }
    return { ok: true, tabs, content: contents[0] }
  }
}
