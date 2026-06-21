import { SpecialistBlueprintConfirmationStore } from './specialist-blueprint-confirmation'
import { SpecialistBlueprintStore } from './specialist-blueprint-store'
import { getDatabase } from '../../database'

let specialistBlueprintStore: SpecialistBlueprintStore | null = null
let specialistBlueprintConfirmationStore: SpecialistBlueprintConfirmationStore | null = null

export function getSpecialistBlueprintStore(): SpecialistBlueprintStore {
  if (!specialistBlueprintStore) {
    specialistBlueprintStore = new SpecialistBlueprintStore({
      getRawDb: () => getDatabase().getRawDb(),
    })
  }
  return specialistBlueprintStore
}

export function getSpecialistBlueprintConfirmationStore(): SpecialistBlueprintConfirmationStore {
  if (!specialistBlueprintConfirmationStore) {
    specialistBlueprintConfirmationStore = new SpecialistBlueprintConfirmationStore({
      getRawDb: () => getDatabase().getRawDb(),
    })
  }
  return specialistBlueprintConfirmationStore
}
