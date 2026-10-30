import { create } from 'zustand'
import type { BookLocation } from './location'

export interface BookTarget { book: string; location: BookLocation }
export const useLibraryRequest = create<{ path?: string; target?: BookTarget; sequence: number }>(() => ({ sequence: 0 }))
export function requestBookLocation(target: BookTarget) {
  useLibraryRequest.setState(s => ({ path: undefined, target, sequence: s.sequence + 1 }))
}
