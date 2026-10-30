import type { DocumentDraft, DocumentDraftAPI, DraftCreate, DraftFinalizeInput, DraftReceipt } from '../../../../shared/document-drafts'
import type { DocumentPagesAPI } from '../../../../shared/document-pages'
import type { DocTab } from '../../../stores/useDocTabs'
import { contentHash, unwrap } from './migration'

export type DraftStatus = { status: 'pending' | 'confirmed' | 'failed'; message?: string; conflict?: boolean }
type EditableTab = Exclude<DocTab, { kind: 'library' }>
export type DraftTabPatch = Partial<Omit<EditableTab, 'kind' | 'id'>>
export interface DraftPort {
  api(): DocumentDraftAPI
  tabs(): DocTab[]
  patch(id: string, patch: DraftTabPatch): void
  root(): Promise<string>
  locate(objectId: string): Promise<string>
  resolve(path: string): Promise<string>
  read(path: string): Promise<string>
  notify(): void
}
type FinalizedSnapshot = { path: string; content: string; writtenContent: string }
interface Session {
  tab: EditableTab
  base?: string
  receipt?: DraftReceipt
  acknowledged?: string
  state: DraftStatus
  timer?: ReturnType<typeof setTimeout>
  pending?: Promise<void>
  finalizeIntent?: DraftFinalizeInput
  finalizing?: Promise<FinalizedSnapshot>
}
export class DraftController {
  private sessions = new Map<string, Session>()
  recovery: DocumentDraft[] = []
  private earlierDrafts = new Set<string>()
  constructor(private port: DraftPort) {}
  status(id: string): DraftStatus | undefined { return this.sessions.get(id)?.state }
  private publish(session: Session, state: DraftStatus): void { session.state = state; this.port.notify() }
  changed(tab: DocTab, base?: string): void {
    if (tab.kind === 'library' || !tab.isDirty) return
    let session = this.sessions.get(tab.id)
    if (!session) {
      session = { tab: { ...tab }, base, state: { status: 'pending' } }
      this.sessions.set(tab.id, session)
    } else {
      session.tab = { ...tab }
      if (tab.content === session.acknowledged && !session.pending) {
        this.publish(session, { ...session.state, status: 'confirmed' }); return
      }
    }
    this.publish(session, { ...session.state, status: 'pending' })
    if (session.timer) return
    session.timer = setTimeout(() => { void this.flush(tab.id).catch(() => { /* status retains failure */ }) }, 300)
    session.timer.unref?.()
  }
  async flush(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.timer) clearTimeout(session.timer)
    session.timer = undefined
    if (session.finalizing) { await session.finalizing; return this.flush(id) }
    if (session.pending) { await session.pending; return this.flush(id) }
    const content = session.tab.content
    if (session.receipt && content === session.acknowledged) return
    if (session.finalizeIntent) {
      const message = '上次定稿尚未完成，请重试保存到原位置；新输入仍在当前标签中'
      this.publish(session, { status: 'failed', message })
      throw new Error(message)
    }
    const work = (async () => {
      const api = this.port.api()
      let result
      if (!session.receipt) {
        const common = { tabId: id, vaultRoot: await this.port.root(), content, title: session.tab.title }
        let input: DraftCreate & { tabId: string } = { ...common, origin: 'new' }
        if (session.tab.path) {
          if (session.base === undefined) throw new Error('缺少编辑前的磁盘版本，正文已保留')
          input = { ...common, origin: 'document', objectId: session.tab.objectId ?? await this.port.resolve(session.tab.path), baseVersion: await contentHash(session.base) }
        }
        result = await api.create(input)
      } else result = await api.save(session.receipt.draftId, session.receipt.revision, content, id)
      const receipt = result.ok ? result.value : result.receipt
      if (!receipt || receipt.contentHash !== await contentHash(content)) throw new Error(result.ok ? '草稿确认内容不一致' : result.message)
      session.receipt = receipt
      this.port.patch(id, { draftId: receipt.draftId })
      const draft = unwrap(await api.read(receipt.draftId))
      if (!draft || draft.content !== content || draft.revision !== receipt.revision || draft.contentHash !== receipt.contentHash) throw new Error('草稿回读不一致')
      session.acknowledged = content
      this.recovery = [...this.recovery.filter(item => item.draftId !== draft.draftId), draft]
      this.publish(session, { status: session.tab.content === content ? 'confirmed' : 'pending', conflict: draft.state === 'conflict' })
    })().catch(error => { this.publish(session, { ...session.state, status: 'failed', message: String(error) }); throw error })
    session.pending = work
    try { await work } finally { session.pending = undefined }
    if (session.tab.content !== session.acknowledged) await this.flush(id)
  }
  async flushAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.flush(id)))
  }
  hasUnconfirmed(): boolean { return [...this.sessions.values()].some(session => session.pending || session.finalizing || session.state.status !== 'confirmed') }
  async saved(id: string, snapshot: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    await this.flush(id)
    if (this.sessions.get(id) !== session) return
    if (session.pending) { await session.pending; return this.saved(id, snapshot) }
    const previous = session.receipt!
    const work = (async () => {
      const current = this.port.tabs().find(tab => tab.id === id) ?? session.tab
      if (session.tab.content !== snapshot) {
        // Rebase the successor only after the file save succeeded, preserving the old
        // durable copy until its replacement is confirmed.
        const content = session.tab.content
        const common = { tabId: id, vaultRoot: await this.port.root(), title: current.title, content }
        const input: DraftCreate & { tabId: string } = current.path
          ? { ...common, origin: 'document', objectId: current.objectId ?? await this.port.resolve(current.path), baseVersion: await contentHash(snapshot) }
          : { ...common, origin: 'new' }
        const next = unwrap(await this.port.api().create(input))
        session.receipt = next; session.acknowledged = content; session.base = snapshot
        session.tab = { ...session.tab, path: current.path, objectId: current.objectId }
        this.port.patch(id, { draftId: next.draftId })
        const draft = unwrap(await this.port.api().read(next.draftId))
        if (!draft || draft.content !== content) throw new Error('后续草稿回读失败')
        this.recovery.push(draft)
      }
      unwrap(await this.port.api().discard(previous.draftId, previous.revision))
      if (session.receipt?.draftId === previous.draftId) {
        session.receipt = undefined; session.acknowledged = undefined; session.base = snapshot
        session.tab = { ...session.tab, path: current.path, objectId: current.objectId }
        if (session.tab.content === snapshot) this.sessions.delete(id)
        this.port.patch(id, { draftId: undefined })
      }
      this.recovery = this.recovery.filter(item => item.draftId !== previous.draftId)
      this.publish(session, { status: session.acknowledged === session.tab.content ? 'confirmed' : 'pending' })
    })().catch(error => { this.publish(session, { status: 'failed', message: String(error) }); throw error })
    session.pending = work
    try { await work } finally { session.pending = undefined }
    if (this.sessions.has(id) && session.acknowledged !== session.tab.content) await this.flush(id)
  }
  recoveryLabel(draftId: string): string | undefined {
    if (this.earlierDrafts.has(draftId)) return '同一标签的较早版本'
    const draft = this.recovery.find(item => item.draftId === draftId)
    const latest = draft?.tabId ? this.recovery.filter(item => item.tabId === draft.tabId)
      .sort((a, b) => b.revision - a.revision || b.updatedAt - a.updatedAt || a.draftId.localeCompare(b.draftId))[0] : undefined
    if (latest && latest.draftId !== draftId) return '同一标签的较早版本'
    return undefined
  }
  async restore(): Promise<void> {
    this.recovery = unwrap(await this.port.api().list())
    this.earlierDrafts.clear()
    const tabIds = new Set([...this.port.tabs().filter(tab => tab.kind !== 'library').map(tab => tab.id),
      ...this.recovery.flatMap(draft => draft.tabId ? [draft.tabId] : [])])
    for (const tabId of tabIds) {
      const [draft] = unwrap(await this.port.api().list(tabId))
      for (const item of this.recovery) {
        if (item.tabId === tabId && item.draftId !== draft?.draftId) this.earlierDrafts.add(item.draftId)
      }
      const tab = this.port.tabs().find(tab => tab.id === tabId && tab.kind !== 'library')
      if (!tab) continue
      if (draft?.state === 'finalized' && draft.finalize?.receipt) {
        const receipt = draft.finalize.receipt
        this.port.patch(tab.id, { path: receipt.path, objectId: receipt.objectId, content: await this.port.read(receipt.path), isDirty: false, draftId: undefined })
      } else if (draft && ['editing', 'conflict'].includes(draft.state)) await this.attach(tab.id, draft)
      else this.port.patch(tab.id, { draftId: undefined, isDirty: false })
    }
    this.port.notify()
  }
  async attach(id: string, draft: DocumentDraft): Promise<void> {
    const owner = [...this.sessions.entries()].find(([, session]) => session.receipt?.draftId === draft.draftId)
    if (owner) {
      if (owner[1].pending || owner[1].tab.content !== owner[1].acknowledged) await this.flush(owner[0])
      const current = unwrap(await this.port.api().read(draft.draftId))
      if (!current) throw new Error('草稿不存在')
      draft = current
    }
    if (draft.tabId !== id) {
      const result = await this.port.api().save(draft.draftId, draft.revision, draft.content, id)
      const receipt = result.ok ? result.value : result.receipt
      if (!receipt) throw new Error(result.ok ? '草稿绑定未确认' : result.message)
      const bound = unwrap(await this.port.api().read(draft.draftId))
      if (!bound || bound.tabId !== id || bound.revision !== receipt.revision || bound.content !== draft.content) throw new Error('草稿标签绑定回读失败')
      draft = bound
      this.earlierDrafts.delete(draft.draftId)
      this.recovery = this.recovery.map(item => item.draftId === draft.draftId ? draft : item)
    }
    const path = draft.objectId ? await this.port.locate(draft.objectId) : null
    if (path && draft.baseVersion !== await contentHash(await this.port.read(path))) {
      draft = { ...draft, state: 'conflict' }
      this.recovery = this.recovery.map(item => item.draftId === draft.draftId ? draft : item)
    }
    const patch = { content: draft.content, isDirty: true, draftId: draft.draftId, objectId: draft.objectId ?? undefined, path, title: draft.title || '未保存的草稿' }
    const tab = this.port.tabs().find(tab => tab.id === id)
    if (!tab || tab.kind === 'library') throw new Error('草稿标签不存在')
    if (owner && owner[0] !== id) {
      clearTimeout(owner[1].timer)
      this.sessions.delete(owner[0])
    }
    this.sessions.set(id, { tab: { ...tab, ...patch }, receipt: { draftId: draft.draftId, revision: draft.revision, contentHash: draft.contentHash },
      acknowledged: draft.content, finalizeIntent: draft.finalize?.request, state: { status: 'confirmed', conflict: draft.state === 'conflict' } })
    this.port.patch(id, patch)
    this.port.notify()
  }
  async discard(draftId: string): Promise<boolean> {
    const entry = [...this.sessions.entries()].find(([, session]) => session.receipt?.draftId === draftId)
    if (entry) await this.flush(entry[0])
    let consumed = true
    const work = (async () => {
      const draft = unwrap(await this.port.api().read(draftId))
      if (!draft) throw new Error('草稿不存在')
      unwrap(await this.port.api().discard(draftId, draft.revision))
      if (entry) {
        const [id, session] = entry
        session.receipt = undefined; session.acknowledged = undefined
        this.port.patch(id, { draftId: undefined })
        if (session.tab.content !== draft.content) {
          // Only the explicit discard snapshot is consumed. Later input survives.
          const input: DraftCreate & { tabId: string } = draft.origin === 'document' && draft.objectId && draft.baseVersion
            ? { tabId: id, origin: 'document', vaultRoot: draft.vaultRoot, objectId: draft.objectId, baseVersion: draft.baseVersion, content: session.tab.content, title: draft.title }
            : { tabId: id, origin: 'new', vaultRoot: draft.vaultRoot, content: session.tab.content, title: draft.title }
          const saved = unwrap(await this.port.api().create(input))
          session.receipt = saved; session.acknowledged = input.content
          this.port.patch(id, { draftId: saved.draftId })
          consumed = false
        } else this.sessions.delete(id)
      }
      this.recovery = unwrap(await this.port.api().list())
      this.port.notify()
    })()
    if (entry) entry[1].pending = work
    try { await work }
    catch (error) { if (entry) this.publish(entry[1], { status: 'failed', message: String(error) }); throw error }
    finally { if (entry) entry[1].pending = undefined }
    if (entry && !consumed) {
      await this.flush(entry[0])
      this.publish(entry[1], { status: 'confirmed' })
    }
    return consumed
  }
  async overwrite(id: string, comparedDisk: string, save: DocumentPagesAPI['save']): Promise<{ status: 'saved' } | { status: 'conflict'; disk: string }> {
    await this.flush(id)
    const session = this.sessions.get(id)
    if (!session?.receipt || !session.tab.path) throw new Error('草稿原文件不可用')
    const snapshot = session.acknowledged!
    const path = session.tab.path
    const result = await save({ path, content: snapshot, expectedVersion: await contentHash(comparedDisk) })
    if (!result.ok) {
      if (result.code === 'version_conflict') {
        this.publish(session, { status: 'confirmed', conflict: true })
        return { status: 'conflict', disk: await this.port.read(path) }
      }
      throw new Error(result.message)
    }
    const written = await this.port.read(path)
    if (written !== snapshot || await contentHash(written) !== result.value.afterVersion) throw new Error('覆盖后回读不一致，草稿已保留')
    await this.saved(id, snapshot)
    if (this.port.tabs().find(tab => tab.id === id)?.content === snapshot) this.port.patch(id, { isDirty: false })
    return { status: 'saved' }
  }
  async finalize(id: string, input: DraftFinalizeInput): Promise<FinalizedSnapshot> {
    const existing = this.sessions.get(id)?.finalizing
    if (existing) return existing
    if (!this.sessions.get(id)?.finalizeIntent) await this.flush(id)
    const session = this.sessions.get(id)
    if (!session?.receipt) throw new Error('草稿尚未得到持久确认')
    const work = this.finalizeSession(id, session, input)
    session.finalizing = work
    try { return await work }
    catch (error) { this.publish(session, { status: 'failed', message: String(error) }); throw error }
    finally { session.finalizing = undefined }
  }
  private async finalizeSession(id: string, session: Session, input: DraftFinalizeInput): Promise<FinalizedSnapshot> {
    const snapshot = session.acknowledged!
    const request = session.finalizeIntent ?? input
    session.finalizeIntent = request
    const result = await this.port.api().finalize(session.receipt!.draftId, session.receipt!.revision, request)
    if (!result.ok) {
      const current = unwrap(await this.port.api().read(session.receipt!.draftId))
      session.finalizeIntent = current?.finalize?.request
      throw new Error(result.message)
    }
    const receipt = result.value
    const writtenContent = await this.port.read(receipt.path)
    if (await contentHash(writtenContent) !== receipt.contentHash) throw new Error('定稿后文件版本已变化，草稿仍保留')
    this.port.patch(id, { path: receipt.path, objectId: receipt.objectId, draftId: undefined })
    this.recovery = this.recovery.filter(item => item.draftId !== receipt.draftId)
    this.sessions.delete(id)
    const tab = this.port.tabs().find(tab => tab.id === id)
    if (tab && tab.content !== snapshot) { this.changed(tab, writtenContent); await this.flush(id) }
    this.port.notify()
    return { path: receipt.path, content: snapshot, writtenContent }
  }
}
