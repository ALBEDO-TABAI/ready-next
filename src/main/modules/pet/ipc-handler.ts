import { ipcMain } from 'electron'
import type { PetActivitySnapshot, PetSettings, PetStickyNoteInput } from '../../../shared/pet'
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

  ipcMain.handle('pet:updateSettings', (_, patch: Partial<PetSettings>) => {
    try {
      return ok(manager.updateSettings(patch || {}))
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

  ipcMain.handle('pet:setPet', (_, petId: string) => {
    try {
      return ok(manager.setPet(petId))
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('pet:updateActivity', (_, snapshot: PetActivitySnapshot) => {
    try {
      manager.updateActivity(snapshot)
      return ok(true)
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

  return manager
}
