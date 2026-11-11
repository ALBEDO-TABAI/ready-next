import { useEffect, useMemo } from 'react'
import type { PageNode } from '../../../../shared/document-pages'
import { useWorkspace } from '../../../stores/useWorkspace'
import { useVault } from '../../../stores/useVault'
import { useDocTabs } from '../../../stores/useDocTabs'
import { runRegisteredDocumentSave } from '../documentSaveRegistry'
import { pageRoots } from './page-state'

/** The page roots: the vault, the workspace folder and pinned folders; libraryRoots is the vault alone (W3 M4). */
export function usePagePanel() {
  const vault = useVault(state => state.view)
  const load = useVault(state => state.load)
  const workspaceRoot = useWorkspace(state => state.workspaceRoot)
  const pinned = useWorkspace(state => state.pinnedFolders)
  useEffect(() => { void load() }, [load])
  const roots = useMemo(() => pageRoots(vault.data, workspaceRoot, pinned), [vault.data, workspaceRoot, pinned])
  const libraryRoots = useMemo(() => roots.filter(root => root.kind === 'vault'), [roots])
  return { roots, libraryRoots }
}

export async function saveBeforePageTrash(node: PageNode): Promise<void> {
  const pagePath = node.path.replace(/\\/g, '/')
  const base = pagePath.slice(0, -3)
  for (const tab of useDocTabs.getState().tabs.filter(tab => {
    const path = tab.path?.replace(/\\/g, '/')
    return tab.isDirty && path && (path === pagePath || path.startsWith(`${base}/`) || path.startsWith(`${base}.assets/`))
  })) {
    if (!await runRegisteredDocumentSave(tab.id) || useDocTabs.getState().tabs.find(current => current.id === tab.id)?.isDirty) {
      throw new Error('页面仍有未保存内容，请先保存后再移到回收站。')
    }
  }
}

