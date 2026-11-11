import { showToast } from '../../../components/ui'
import { useWorkspace } from '../../../stores/useWorkspace'
import { openPopover } from '../ink/overlay'
import { SaveToPicker } from '../page-ui/SaveToPicker'

/**
 * 收进资料库 (W3 M4): move a mounted folder's file or folder into the library, at a place the writer picks. Main keeps
 * every object's id and repairs references (documentPages adopt); from then on it is managed as pages. A mounted
 * root that moved in is no longer mounted.
 */
export async function adoptIntoLibrary(source: string): Promise<void> {
  const vault = await window.electronAPI.vault.get()
  if (vault.status !== 'ready') { showToast('请先设置资料库'); return }
  const api = window.electronAPI.documentPages
  const tree = await api.tree({ path: vault.root, kind: 'vault' })
  if (!tree.ok) { showToast(tree.message); return }
  const name = source.split(/[\\/]/).filter(Boolean).pop() ?? ''
  openPopover({ id: 'ink-adopt', anchor: { left: 0, top: 0, right: 0, bottom: 0 }, placement: 'center', modal: true,
    render: close => <div className="ink-menu" style={{ width: 440, padding: 8 }}>
      <SaveToPicker trees={[tree.value]} mode="adopt" initialTitle={name.replace(/\.(md|canvas)$/i, '')} onCancel={close}
        onConfirm={async selection => {
          const target = selection.parentObjectId ? { parentObjectId: selection.parentObjectId } : { parentPath: selection.parentPath! }
          const result = await api.operate({ type: 'adopt', root: vault.root, source, operationId: selection.operationId, ...target })
          if (result.ok) {
            const workspace = useWorkspace.getState()
            if (workspace.pinnedFolders.includes(source)) workspace.removePinnedFolder(source)
            showToast(`已收进资料库：${name}`)
          }
          return result
        }} />
    </div> })
}
