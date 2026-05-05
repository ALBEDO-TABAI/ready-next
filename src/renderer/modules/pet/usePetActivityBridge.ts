import { useEffect } from 'react'
import { useAgent } from '../../stores/useAgent'
import { getActiveScopeRunState } from '../agent/scopeRunState'
import { createPetActivitySnapshot } from './petActivitySnapshot'

export function usePetActivityBridge(): void {
  useEffect(() => {
    if (!window.electronAPI?.pet) return undefined
    let lastSerialized = ''

    const pushSnapshot = () => {
      const state = useAgent.getState()
      const run = getActiveScopeRunState(state.scopeRunStates, state.currentScopeId)
      const snapshot = createPetActivitySnapshot(run)
      const serialized = JSON.stringify(snapshot)
      if (serialized === lastSerialized) return
      lastSerialized = serialized
      void window.electronAPI.pet.updateActivity(snapshot)
    }

    pushSnapshot()
    return useAgent.subscribe(pushSnapshot)
  }, [])
}
