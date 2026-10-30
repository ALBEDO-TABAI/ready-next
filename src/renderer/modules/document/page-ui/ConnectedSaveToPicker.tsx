import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { SaveToPicker, type SaveToPickerProps } from './SaveToPicker'
import { createPageTreeStore } from './page-state'
import { usePagePanel } from './page-panel-state'

/** Drafts and tab drops share the same location picker as page move/restore. */
export function ConnectedSaveToPicker(props: Omit<SaveToPickerProps, 'trees'>) {
  const { roots } = usePagePanel()
  const store = useMemo(() => createPageTreeStore(window.electronAPI.documentPages), [])
  const { trees, loading, error } = useStore(store)
  useEffect(() => {
    const reload = () => { void store.getState().load(roots) }
    reload()
    const unsubscribe = window.electronAPI.documentPages.onChanged(reload)
    return () => { unsubscribe(); store.getState().invalidate() }
  }, [roots, store])
  if (loading && !trees.length) return <p role="status">正在读取保存位置…</p>
  if (error) return <div role="alert">{error}<button onClick={() => void store.getState().load(roots)}>重试</button><button onClick={props.onCancel}>取消</button></div>
  return <SaveToPicker {...props} trees={trees} />
}
