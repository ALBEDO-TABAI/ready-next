import { ipcMain } from 'electron'
import type { PetActivityOpenIdentity, PetSettings, PetStickyNoteInput } from '../../../shared/pet'
import { setActivePetWindowManager } from './active-pet-window-manager'
import { createPetWindowManager, type PetWindowManager } from './pet-window-manager'

interface PetIPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

interface SetupPetIPCOptions {
  preloadPath: string
  rendererFile: string
  packaged: boolean
  resourcesPath: string
  ensureDockApp?: () => void
  openActivity?: (activity: PetActivityOpenIdentity) => void
}

function ok<T>(data: T): PetIPCResponse<T> {
  return { success: true, data }
}

function fail(error: unknown): PetIPCResponse {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

export function setupPetIPC(options: SetupPetIPCOptions): PetWindowManager {
  const manager = createPetWindowManager(options)
  setActivePetWindowManager(manager)

  ipcMain.handle('pet:getSettings', () => {
    try {
      return ok(manager.getSettings())
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:updateSettings', async (_, patch: Partial<PetSettings>) => {
    try {
      return ok(await manager.updateSettings(patch || {}))
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:listPets', () => {
    try {
      return ok(manager.listPets())
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:getSnapshot', () => {
    try {
      return ok(manager.getSnapshot())
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:show', async () => {
    try {
      await manager.show()
      return ok(manager.getSnapshot())
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:hide', () => {
    try {
      manager.hide()
      return ok(true)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:setPet', async (_, petId: string) => {
    try {
      return ok(await manager.setPet(petId))
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:resetPosition', () => {
    try {
      return ok(manager.resetPosition())
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:moveBy', (_, delta: { dx: number; dy: number }) => {
    try {
      manager.moveBy(delta)
      return ok(true)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:pushStickyNote', (_, note: PetStickyNoteInput) => {
    try {
      return ok(manager.pushStickyNote(note))
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:dismissStickyNote', (_, id: string) => {
    try {
      return ok(manager.dismissStickyNote(id))
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:clearStickyNotes', () => {
    try {
      manager.clearStickyNotes()
      return ok(true)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.on('pet:snapshotApplied', (_, applied: { revision?: unknown; contentDigest?: unknown }) => {
    if (Number.isSafeInteger(applied?.revision) && typeof applied.contentDigest === 'string') {
      manager.acknowledgeSnapshot(applied.revision as number, applied.contentDigest)
    }
  })

  ipcMain.handle('pet:openActivity', (_, requested: Partial<PetActivityOpenIdentity>) => {
    const activity = manager.getActivity()
    if (requested?.revision !== activity.revision
      || requested.taskId !== activity.taskId
      || requested.scopeId !== activity.scopeId
      || requested.runId !== activity.runId
      || requested.messageId !== activity.messageId
      || requested.updatedAt !== activity.updatedAt
      || !activity.taskId
      || !activity.scopeId
      || !activity.runId
      || !activity.updatedAt
      || !options.openActivity) {
      return fail('pet_activity_identity_mismatch')
    }
    options.openActivity({
      revision: activity.revision,
      taskId: activity.taskId,
      scopeId: activity.scopeId,
      runId: activity.runId,
      messageId: activity.messageId,
      updatedAt: activity.updatedAt,
    })
    return ok(true)
  })

  ipcMain.on('pet:activityOpened', (_, opened: Partial<PetActivityOpenIdentity>) => {
    const activity = manager.getActivity()
    if (opened?.revision !== activity.revision
      || opened.taskId !== activity.taskId
      || opened.scopeId !== activity.scopeId
      || opened.runId !== activity.runId
      || opened.messageId !== activity.messageId
      || opened.updatedAt !== activity.updatedAt
      || typeof activity.scopeId !== 'string') return
    if (manager.markActivityOpened(activity)) manager.refreshActivity()
  })

  ipcMain.on('pet:scopeViewed', (_, scopeId: unknown) => {
    if (typeof scopeId !== 'string' || !scopeId.trim()) return
    if (manager.markScopeViewed(scopeId)) manager.refreshActivity()
  })

  return manager
}
