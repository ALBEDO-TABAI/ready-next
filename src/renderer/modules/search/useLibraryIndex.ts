import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeDesiredRoots, useWorkspace } from '../../stores/useWorkspace'
import { reduceReindexResponse } from '../../components/layout/reindex-response-reducer'
import { readJsonStorage, removeStorage, writeJsonStorage } from '../../utils/storage'

// The library's full-text index: one build path for find-and-replace and 设置 › 资料库 (W2 §2.3, §3.2).
// Building is an explicit user action (a home folder once scanned 600K+ files into an 80GB index), and
// the last success is remembered per primary root so both places can say "rebuild" rather than "build".

export interface LibraryIndexStatus {
  docCount: number
  lastIndexedAt: string // ISO timestamp
  workspaceRoot: string
}

const KEY_PREFIX = 'ready-search-index-status:'
const storageKey = (root: string) => `${KEY_PREFIX}${root}`

export function loadLibraryIndexStatus(root: string | null): LibraryIndexStatus | null {
  if (!root) return null
  const raw = readJsonStorage<LibraryIndexStatus | null>(storageKey(root), null)
  if (!raw || typeof raw !== 'object' || raw.workspaceRoot !== root) return null
  if (typeof raw.docCount !== 'number' || typeof raw.lastIndexedAt !== 'string') return null
  return raw
}

export function formatIndexedAt(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

export function useLibraryIndex() {
  const workspaceRoot = useWorkspace(state => state.workspaceRoot)
  const pinnedFolders = useWorkspace(state => state.pinnedFolders)
  // Every safe pinned folder plus the workspace root; computeDesiredRoots is the one rule for that set.
  const roots = useMemo(() => computeDesiredRoots({ workspaceRoot, pinnedFolders }), [workspaceRoot, pinnedFolders])
  const statusKey = roots[0] ?? null
  const [status, setStatus] = useState<LibraryIndexStatus | null>(() => loadLibraryIndexStatus(statusKey))
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  useEffect(() => {
    setStatus(loadLibraryIndexStatus(statusKey))
    setError(null)
  }, [statusKey])

  // A status cached for a root that is no longer open is dropped, so the empty state shows.
  useEffect(() => {
    if (roots.length === 0 && status) {
      if (status.workspaceRoot) removeStorage(storageKey(status.workspaceRoot))
      setStatus(null)
    }
  }, [roots, status])

  const rebuild = useCallback(async () => {
    if (roots.length === 0 || typeof window === 'undefined') return
    const doc = window.electronAPI?.document
    if (!doc?.reindexAllSources && !doc?.reindexWorkspace) { setError('当前环境不支持索引'); return }
    if (running.current) return
    running.current = true
    setIndexing(true)
    setError(null)
    try {
      // The first root rebuilds its files plus the shared sources (bookmarks, RSS, calendar, agent
      // messages, one shared bucket); later roots rebuild files only, so the shared sources run once.
      let docCount = 0
      let rootsSucceeded = 0
      const errors: string[] = []
      for (let index = 0; index < roots.length; index++) {
        const root = roots[index]
        const outcome = index === 0 && doc.reindexAllSources
          ? reduceReindexResponse(root, await doc.reindexAllSources(root), 'all-sources')
          : doc.reindexWorkspace
            ? reduceReindexResponse(root, await doc.reindexWorkspace(root), 'fs-only')
            : null
        if (!outcome) continue
        docCount += outcome.docCount
        if (outcome.error) errors.push(outcome.error)
        // A root whose files were indexed counts even if one shared source failed: that failure is a
        // warning, not a reason to throw away a good file index.
        if (outcome.rootIndexed) rootsSucceeded += 1
      }
      if (rootsSucceeded === 0 && errors.length > 0) throw new Error(errors.join('; '))
      const next: LibraryIndexStatus = { docCount, lastIndexedAt: new Date().toISOString(), workspaceRoot: statusKey ?? '' }
      writeJsonStorage(storageKey(next.workspaceRoot), next)
      setStatus(next)
      if (errors.length > 0) setError(`搜索结果可能不完整：${errors.join('; ')}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      running.current = false
      setIndexing(false)
    }
  }, [roots, statusKey])

  return { roots, status, indexing, error, rebuild }
}
