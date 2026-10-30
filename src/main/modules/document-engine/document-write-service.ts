import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { applyDocumentOperation as applyOperation, type DocumentOperation, type DocumentSyncRequest, type DocumentSyncReply } from '../../../shared/document-operations'
import { publishFileAtomically } from './atomic-file-publish'

export type DocumentWriteErrorCode = 'version_conflict' | 'dirty_conflict' | 'operation_failed' | 'write_failed' | 'readback_mismatch'
export interface DocumentWriteFailure { code: DocumentWriteErrorCode; message: string }
export interface DocumentWriteReceipt {
  path: string
  beforeVersion: string
  afterVersion: string
  committedAt: number
  tab: 'not_open' | 'synced_clean' | 'merged_dirty'
}
export interface DocumentWriteInput { path: string; expectedVersion?: string; operation: DocumentOperation; origin: string }
export type DocumentTabTransport = (request: DocumentSyncRequest) => Promise<DocumentSyncReply>
export interface DocumentWriteDependencies {
  index(path: string, content: string): Promise<void>
  tabs?: DocumentTabTransport
  timeoutMs?: number
  publish?: typeof publishFileAtomically
}
export interface DocumentWriteParticipant {
  published?(content: string): Promise<void>
  indexed?(content: string): Promise<void>
  rollback?(content: string): Promise<void>
  complete?(): void
}

export function documentVersion(content: string): string { return createHash('sha256').update(content).digest('hex') }
export function documentWriteError(code: DocumentWriteErrorCode, message: string): Error & DocumentWriteFailure {
  return Object.assign(new Error(message), { code })
}
const tails = new Map<string, Promise<void>>()
let runtime: DocumentWriteDependencies | null = null
export function configureDocumentWriteService(dependencies: DocumentWriteDependencies): void { runtime = dependencies }
export function getDocumentTabTransport(): DocumentTabTransport | undefined { return runtime?.tabs }

// Paths are canonicalised one at a time in call order, so a caller whose realpath
// resolves sooner cannot take a queue slot ahead of an earlier caller.
let canonicalizing: Promise<unknown> = Promise.resolve()

export async function withDocumentPathLock<T>(path: string, work: (path: string) => Promise<T>): Promise<T> {
  const resolving = canonicalizing.then(() => realpath(path))
  canonicalizing = resolving.catch(() => undefined)
  const canonical = await resolving
  const previous = tails.get(canonical) ?? Promise.resolve()
  const result = previous.then(() => work(canonical))
  const tail = result.then(() => undefined, () => undefined)
  tails.set(canonical, tail)
  try { return await result } finally { if (tails.get(canonical) === tail) tails.delete(canonical) }
}

export async function requestDocumentTab(transport: DocumentTabTransport, request: DocumentSyncRequest, timeoutMs: number): Promise<DocumentSyncReply> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      transport(request),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(documentWriteError('dirty_conflict', 'Document tab acknowledgement timed out')), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

/** The sole publisher used by both the operation service and the scoped Tag Forge writer. */
export async function publishDocumentContent(path: string, content: string): Promise<void> {
  await publishFileAtomically(path, content)
  if (await readFile(path, 'utf8') !== content) throw documentWriteError('readback_mismatch', 'Disk readback differs from published content')
}

export async function restoreDocumentContent(path: string, writtenVersion: string, original: string): Promise<string> {
  const current = await readFile(path, 'utf8')
  // An external writer owns this newer version; never destroy it during compensation.
  if (documentVersion(current) !== writtenVersion) return current
  await publishDocumentContent(path, original)
  return original
}

export async function commitDocumentOperation(
  input: DocumentWriteInput,
  dependencies: DocumentWriteDependencies,
  participant: DocumentWriteParticipant = {},
): Promise<DocumentWriteReceipt> {
  return withDocumentPathLock(input.path, async (path) => {
    const original = await readFile(path, 'utf8')
    const beforeVersion = documentVersion(original)
    if (input.expectedVersion && input.expectedVersion !== beforeVersion) throw documentWriteError('version_conflict', 'Document version has changed')
    const id = randomUUID()
    const timeoutMs = dependencies.timeoutMs ?? 10_000
    const deadline = Date.now() + timeoutMs * 4
    const send = async (request: DocumentSyncRequest): Promise<Extract<DocumentSyncReply, { ok: true }>> => {
      if (!dependencies.tabs) return { ok: true, tabs: [] }
      const reply = await requestDocumentTab(dependencies.tabs, request, timeoutMs)
      if (!reply.ok) throw documentWriteError(reply.code ?? 'dirty_conflict', reply.message)
      return reply
    }
    let next = original
    let published = false
    let indexStarted = false
    let participantStarted = false
    let rollbackVersion: string | undefined
    let dirty = false
    let prepared = false
    try {
      prepared = true
      const snapshot = await send({ id, path, deadline, phase: 'prepare', operation: input.operation, diskContent: original })
      dirty = snapshot.tabs.some((tab) => tab.isDirty)
      if (dirty) {
        if (participant.published || participant.indexed) throw documentWriteError('dirty_conflict', 'This write requires a saved document')
        try { next = applyOperation(snapshot.tabs[0].content, input.operation) } catch (error) {
          throw documentWriteError('dirty_conflict', String(error))
        }
        if (snapshot.content !== next) throw documentWriteError('readback_mismatch', 'Merged buffer readback mismatch')
      } else {
        try { next = applyOperation(original, input.operation) } catch (error) {
          throw documentWriteError('operation_failed', String(error))
        }
        if (await readFile(path, 'utf8') !== original) throw documentWriteError('version_conflict', 'Document changed before publish')
        try {
          await (dependencies.publish ?? publishFileAtomically)(path, next)
          published = true
        } catch (error) {
          // A publisher can fail during cleanup after the replacement already happened.
          published = next !== original && await readFile(path, 'utf8') === next
          throw documentWriteError('write_failed', String(error))
        }
        const readback = await readFile(path, 'utf8')
        if (readback !== next) {
          rollbackVersion = documentVersion(readback)
          throw documentWriteError('readback_mismatch', 'Disk readback mismatch')
        }
        const synced = await send({ id, path, deadline, phase: 'commit' })
        if (synced.content !== undefined && synced.content !== next) throw documentWriteError('readback_mismatch', 'Tab readback mismatch')
        participantStarted = true
        await participant.published?.(next)
        indexStarted = true
        await dependencies.index(path, next)
        if (await readFile(path, 'utf8') !== next) throw documentWriteError('readback_mismatch', 'post_index_revision_conflict')
        await participant.indexed?.(next)
      }
      if (dirty) {
        const committed = await send({ id, path, deadline, phase: 'commit' })
        if (committed.content !== undefined && committed.content !== next) throw documentWriteError('readback_mismatch', 'Tab readback mismatch')
      }
      await send({ id, path, deadline, phase: 'release' })
      participant.complete?.()
      return { path, beforeVersion: dirty ? documentVersion(snapshot.tabs[0].content) : beforeVersion, afterVersion: documentVersion(next), committedAt: Date.now(), tab: dirty ? 'merged_dirty' : snapshot.tabs.length ? 'synced_clean' : 'not_open' }
    } catch (error) {
      const rollbackErrors: unknown[] = []
      let restored = original
      if (published) {
        try { restored = await restoreDocumentContent(path, rollbackVersion ?? documentVersion(next), original) } catch (failure) { rollbackErrors.push(failure) }
      }
      if (indexStarted) {
        try { await dependencies.index(path, restored) } catch (failure) { rollbackErrors.push(failure) }
      }
      if (prepared) {
        try { await send({ id, path, deadline: Date.now() + timeoutMs, phase: 'rollback', content: dirty ? undefined : restored }) } catch (failure) { rollbackErrors.push(failure) }
      }
      if (participantStarted) {
        try { await participant.rollback?.(restored) } catch (failure) { rollbackErrors.push(failure) }
      }
      if (rollbackErrors.length) throw documentWriteError('write_failed', `Rollback failed: ${rollbackErrors.map(String).join('; ')}; original: ${String(error)}`)
      throw error
    }
  })
}

export async function applyDocumentOperation(input: DocumentWriteInput, dependencies = runtime): Promise<DocumentWriteReceipt | DocumentWriteFailure> {
  if (!dependencies) return { code: 'operation_failed', message: 'Document write service is not initialized' }
  try { return await commitDocumentOperation(input, dependencies) } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    const allowed: readonly unknown[] = ['version_conflict', 'dirty_conflict', 'operation_failed', 'write_failed', 'readback_mismatch']
    return { code: allowed.includes(code) ? code as DocumentWriteErrorCode : 'operation_failed', message: error instanceof Error ? error.message : String(error) }
  }
}
