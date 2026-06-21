import { getDatabase } from '../../database'
import { SpecialistContentEditProposalStore } from './specialist-content-edit-proposals'

let specialistContentEditProposalStore: SpecialistContentEditProposalStore | null = null

export function getSpecialistContentEditProposalStore(): SpecialistContentEditProposalStore {
  if (!specialistContentEditProposalStore) {
    specialistContentEditProposalStore = new SpecialistContentEditProposalStore({
      getRawDb: () => getDatabase().getRawDb(),
    })
  }
  return specialistContentEditProposalStore
}
