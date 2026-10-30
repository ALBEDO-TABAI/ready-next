import { useEffect } from 'react'
import { useLibraryRequest } from './reader/navigation-state'
import { useDocTabs } from '../../stores/useDocTabs'
import { Library } from './Library'

// An explicit file-open request belongs to the library surface, not the pathless tab.
export function LibraryTab() {
  const request = useLibraryRequest()
  return <Library key={request.sequence} requestedPath={request.path} requestedTarget={request.target} onOpenOther={path => useDocTabs.getState().openTab(path)} />
}
export function OpenEpubInLibrary({ path, sourceTabId }: { path: string; sourceTabId: string }) {
  useEffect(() => {
    useLibraryRequest.setState(s => ({ path, target: undefined, sequence: s.sequence + 1 }))
    const tabs = useDocTabs.getState()
    tabs.openLibraryTab()
    tabs.closeTab(sourceTabId)
  }, [path, sourceTabId])
  return <div role="status">正在打开书房…</div>
}
