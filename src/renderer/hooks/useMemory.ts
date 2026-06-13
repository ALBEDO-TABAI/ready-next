import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  MemoryEntry,
  MemoryQueryFilters,
  MemoryStats,
  TriggerDefinition,
  TriggerFilters,
  MemoryLifecycleStatus,
  MemoryMaintenanceResult,
  BeliefCardSettingsSnapshotData,
} from '../types/electron'

export function useMemories(filters: MemoryQueryFilters) {
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const filtersRef = useRef(filters)
  const filtersKey = JSON.stringify(filters)
  filtersRef.current = filters

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.memory.query(filtersRef.current)
      if (result.success && result.data) {
        setMemories(result.data)
        setError(null)
      } else {
        setError(new Error(result.error || 'Failed to query memories'))
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [filtersKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const createMemory = useCallback(
    async (entry: Partial<MemoryEntry>) => {
      const result = await window.electronAPI.memory.create(entry)
      if (result.success && result.data) {
        await refresh()
        return result.data
      }
      throw new Error(result.error || 'Failed to create memory')
    },
    [refresh]
  )

  const updateMemory = useCallback(
    async (id: string, updates: Partial<MemoryEntry>) => {
      const result = await window.electronAPI.memory.update(id, updates)
      if (result.success) {
        await refresh()
      } else {
        throw new Error(result.error || 'Failed to update memory')
      }
    },
    [refresh]
  )

  const deleteMemory = useCallback(
    async (id: string) => {
      const result = await window.electronAPI.memory.delete(id)
      if (result.success) {
        await refresh()
      } else {
        throw new Error(result.error || 'Failed to delete memory')
      }
    },
    [refresh]
  )

  return { memories, loading, error, refresh, createMemory, updateMemory, deleteMemory }
}

export function useTriggers(filters?: TriggerFilters) {
  const [triggers, setTriggers] = useState<TriggerDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.trigger.list(filtersRef.current)
      if (result.success && result.data) {
        setTriggers(result.data)
        setError(null)
      } else {
        setError(new Error(result.error || 'Failed to list triggers'))
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const createTrigger = useCallback(
    async (trigger: Partial<TriggerDefinition>) => {
      const result = await window.electronAPI.trigger.create(trigger)
      if (result.success && result.data) {
        await refresh()
        return result.data
      }
      throw new Error(result.error || 'Failed to create trigger')
    },
    [refresh]
  )

  const updateTrigger = useCallback(
    async (id: string, updates: Partial<TriggerDefinition>) => {
      const result = await window.electronAPI.trigger.update(id, updates)
      if (result.success) {
        await refresh()
      } else {
        throw new Error(result.error || 'Failed to update trigger')
      }
    },
    [refresh]
  )

  return { triggers, loading, error, refresh, createTrigger, updateTrigger }
}

export function useMemoryStats() {
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.memory.stats()
      if (result.success && result.data) {
        setStats(result.data)
        setError(null)
      } else {
        setError(new Error(result.error || 'Failed to get memory stats'))
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { stats, loading, error, refresh }
}

export function useMemoryLifecycle() {
  const [status, setStatus] = useState<MemoryLifecycleStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [maintenanceRunning, setMaintenanceRunning] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.memoryLifecycle.status()
      if (result.success && result.data) {
        setStatus(result.data)
        setError(null)
      } else {
        setError(new Error(result.error || 'Failed to get lifecycle status'))
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const runMaintenance = useCallback(async (): Promise<MemoryMaintenanceResult> => {
    try {
      setMaintenanceRunning(true)
      const result = await window.electronAPI.memoryLifecycle.runMaintenance()
      if (result.success && result.data) {
        await refreshStatus()
        return result.data
      }
      throw new Error(result.error || 'Failed to run maintenance')
    } finally {
      setMaintenanceRunning(false)
    }
  }, [refreshStatus])

  return { status, loading, error, maintenanceRunning, refreshStatus, runMaintenance }
}

export function useBeliefCards() {
  const [snapshot, setSnapshot] = useState<BeliefCardSettingsSnapshotData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [actionRunning, setActionRunning] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const result = await window.electronAPI.memoryCards.list()
      if (result.success && result.data) {
        setSnapshot(result.data)
        setError(null)
      } else {
        setError(new Error(result.error || 'Failed to list belief cards'))
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const transitionCard = useCallback(async (relPath: string, action: 'approve' | 'reject') => {
    try {
      setActionRunning(`${action}:${relPath}`)
      const result = await window.electronAPI.memoryCards.transition({ relPath, action })
      if (result.success && result.data) {
        setSnapshot(result.data)
        setError(null)
        return
      }
      throw new Error(result.error || 'Failed to update belief card')
    } finally {
      setActionRunning(null)
    }
  }, [])

  const setKnowledgeSystemEnabled = useCallback(async (enabled: boolean) => {
    try {
      setActionRunning('knowledge-system')
      const result = await window.electronAPI.memoryCards.setKnowledgeSystemEnabled(enabled)
      if (result.success && result.data) {
        setSnapshot(result.data)
        setError(null)
        return
      }
      throw new Error(result.error || 'Failed to update knowledge system')
    } finally {
      setActionRunning(null)
    }
  }, [])

  return { snapshot, loading, error, actionRunning, refresh, transitionCard, setKnowledgeSystemEnabled }
}
