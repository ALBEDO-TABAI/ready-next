import { useEffect, useRef, useState } from 'react'
import type { LayerEntry, LayerRange } from '../../../../../shared/calendar-layers'
import { isoDate } from '../../../../../shared/calendar/dates'

export function useLayerEntries(from: number, to: number, timeZone: string, active: boolean) {
  const [entries, setEntries] = useState<LayerEntry[]>([]), [error, setError] = useState<string | null>(null)
  const vaultGeneration = useRef(0)
  const generation = useRef(0), owner = useRef<string | null>(null)
  const scope = `${from}:${to}:${timeZone}:${active}`
  const range: LayerRange = { from: isoDate(from), to: isoDate(to), timeZone }
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    setEntries([]); setError(null)
    if (!active) return
    owner.current = scope
    let disposed = false
    const reload = async () => {
      const current = ++generation.current
      try {
        const result = await window.electronAPI.calendarLayers.query({ from: isoDate(from), to: isoDate(to), timeZone })
        if (disposed || current !== generation.current) return
        if (!result.ok) throw new Error(result.message)
        setEntries(result.value); setError(null)
      } catch (error) { if (!disposed && current === generation.current) { setEntries([]); setError(String(error)) } }
    }
    refresh.current = reload
    const stop = window.electronAPI.calendarLayers.onChanged(() => { void reload() })
    const stopVault = window.electronAPI.vault.onChanged(() => {
      vaultGeneration.current++; setEntries([]); setError(null); void reload()
    })
    void reload()
    return () => { disposed = true; owner.current = null; stop(); stopVault() }
  }, [from, to, timeZone, active, scope])
  const move = async (entry: LayerEntry, date: string) => {
    if (!entry.edit || !entry.version) return
    const vault = vaultGeneration.current
    const current = () => owner.current === scope && vault === vaultGeneration.current
    try {
      const result = await window.electronAPI.calendarLayers.move({ range, id: entry.id, expectedVersion: entry.version, date })
      if (!current()) return
      if (!result.ok) throw new Error(result.message)
      await refresh.current()
      if (current() && result.value.state === 'unsaved') setError('日期已合入打开的文档，保存后会显示在日历中。')
    } catch (error) { if (!current()) return; await refresh.current(); if (current()) setError(String(error)) }
  }
  return { entries, error, move }
}

