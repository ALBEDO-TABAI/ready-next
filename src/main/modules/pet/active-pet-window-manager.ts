import type { PetWindowManager } from './pet-window-manager'

let activePetWindowManager: PetWindowManager | null = null

export function setActivePetWindowManager(manager: PetWindowManager): void {
  activePetWindowManager = manager
}

export function getActivePetWindowManager(): PetWindowManager | null {
  return activePetWindowManager
}
