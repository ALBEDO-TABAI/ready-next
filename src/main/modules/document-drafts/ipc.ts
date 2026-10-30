import type { IpcMain } from 'electron'
import type { DraftResult, DraftReceipt } from '../../../shared/document-drafts'
import { DraftCreateSchema, DraftFinalizeInputSchema, DraftIdSchema, DraftReceiptSchema, DraftRevisionSchema, LegacyDraftItemSchema } from '../../../shared/document-drafts'
import type { VaultState } from '../../../shared/vault'
import { z } from 'zod'
import { DocumentDraftService } from './service'
import { draftError, vaultRoot } from './files'

export function registerDocumentDraftIPC(ipcMain: Pick<IpcMain, 'handle'>, service: DocumentDraftService, vault: () => VaultState): void {
  const root = () => {
    const state = vault()
    if (state.status !== 'ready') throw draftError('no_vault', '请先配置可用的资料库')
    return vaultRoot(state.root)
  }
  const scoped = (id: unknown): string => {
    const draftId = DraftIdSchema.parse(id)
    const currentRoot = root()
    const draft = service.read(draftId)
    if (draft && draft.vaultRoot !== currentRoot) throw draftError('wrong_vault', '草稿不属于当前资料库')
    return draftId
  }
  const reply = async <T>(work: () => T | Promise<T>): Promise<DraftResult<T>> => {
    try { return { ok: true, value: await work() } }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'draft_failed'
      const candidateNames = error instanceof Error && 'candidateNames' in error ? z.array(z.string()).parse(error.candidateNames) : undefined
      const receipt: DraftReceipt | undefined = error instanceof Error && 'receipt' in error ? DraftReceiptSchema.parse(error.receipt) : undefined
      return { ok: false, code, message, ...(candidateNames ? { candidateNames } : {}), ...(receipt ? { receipt } : {}) }
    }
  }
  ipcMain.handle('documentDrafts:create', (_event, input: unknown) => reply(() => {
    const parsed = DraftCreateSchema.parse(input)
    DraftIdSchema.parse(parsed.tabId)
    if (vaultRoot(parsed.vaultRoot) !== root()) throw draftError('wrong_vault', '草稿不属于当前资料库')
    return service.create(parsed)
  }))
  ipcMain.handle('documentDrafts:save', (_event, id: unknown, revision: unknown, content: unknown, tabId: unknown) => reply(() => service.save(scoped(id), DraftRevisionSchema.parse(revision), z.string().parse(content), DraftIdSchema.parse(tabId))))
  ipcMain.handle('documentDrafts:list', (_event, tabId: unknown) => reply(() => service.list(root(), tabId === undefined ? undefined : DraftIdSchema.parse(tabId))))
  ipcMain.handle('documentDrafts:read', (_event, id: unknown) => reply(() => service.read(scoped(id))))
  ipcMain.handle('documentDrafts:discard', (_event, id: unknown, revision: unknown) => reply(() => service.discard(scoped(id), DraftRevisionSchema.parse(revision))))
  ipcMain.handle('documentDrafts:finalize', (_event, id: unknown, revision: unknown, input: unknown) => reply(() => service.finalize(scoped(id), DraftRevisionSchema.parse(revision), DraftFinalizeInputSchema.parse(input))))
  ipcMain.handle('documentDrafts:importLegacy', (_event, items: unknown) => reply(() => service.importLegacy(root(), z.array(LegacyDraftItemSchema).parse(items))))
}
