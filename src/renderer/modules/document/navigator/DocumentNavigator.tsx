import { useCallback, useState } from 'react'
import type { PageNode, PageRoot } from '../../../../shared/document-pages'
import { Segmented } from '../../../components/ui'
import FilesPanel from '../../../components/layout/FilesPanel'
import FileTree from '../../../components/layout/FileTree'
import { useVault } from '../../../stores/useVault'
import { useWorkspace } from '../../../stores/useWorkspace'
import { useDocumentNavigator, type DocumentNavigatorView } from './useDocumentNavigator'
import { InkSidebar } from '../ink/InkSidebar'
import { mountFolder } from '../mountFolder'
import { adoptIntoLibrary } from './adopt'
import { useSceneMotion } from '../../workbench/scene-motion'
import type { ContextMenuItem } from '../../../components/layout/ContextMenu'
import type { FileItem } from '../../../stores/useWorkspace'
import './document-navigator.css'

// The document mode's navigator in the shell sidebar (W3 §3): one library, two views.
// - 页面 (default): the page tree (A.md and A/ merged, no extensions, no .assets or .ready, system objects
//   out), then the folders mounted beside the library, which are only ever shown as files (M4).
// - 文件: the same library as it is on disk, with the file tools (list or thumbnails, filters, new file
//   or folder). The view is remembered; switching it changes nothing on disk.

const VIEW_OPTIONS: { value: DocumentNavigatorView; label: string }[] = [
  { value: 'pages', label: '页面' },
  { value: 'files', label: '文件' },
]
const VIEW_ORDER = VIEW_OPTIONS.map(option => option.value)

export default function DocumentNavigator({ roots, visible, onShowFiles }: {
  /** The library alone: other folders are files, listed once under 文件夹 (M4). */
  roots: PageRoot[]
  visible: boolean
  onShowFiles(node: PageNode): void | Promise<void>
}) {
  const view = useDocumentNavigator(state => state.view)
  const setView = useDocumentNavigator(state => state.setView)
  const vault = useVault(state => state.view.data)
  const vaultRoot = vault?.status === 'ready' ? vault.root : null
  const hasMounted = useWorkspace(state => state.pinnedFolders.some(folder => folder !== vaultRoot))
  const isMounted = useCallback((root: string) => root !== vaultRoot, [vaultRoot])
  // A mounted folder's entries can be brought into the library (M4).
  const adoptItem = useCallback((item: FileItem): ContextMenuItem[] => vaultRoot
    ? [{ id: 'adopt', label: '收进资料库…', onClick: () => { void adoptIntoLibrary(item.path) } }] : [], [vaultRoot])
  const [mountError, setMountError] = useState<string | null>(null)
  // Switching the view moves the lists on the switch's own axis (motion language M2): 页面 → 文件 slides left, and back.
  // Shown and moving are read from the same state, so the arriving view is marked in the commit that shows it.
  const motion = useSceneMotion(view, { animate: true, order: VIEW_ORDER })
  const viewMotion = (key: DocumentNavigatorView) => {
    const shown = motion.current === key
    const leftAs = shown ? undefined : motion.leaving[key]
    const move = leftAs ? 'leave' : shown && motion.entering ? 'enter' : undefined
    return {
      hidden: !shown && !leftAs,
      inert: leftAs ? true : undefined,
      'data-view-motion': move,
      'data-view-direction': move ? leftAs ?? motion.direction : undefined,
    }
  }

  const mount = async () => {
    setMountError(null)
    setMountError(await mountFolder())
  }

  return (
    <div className="document-navigator" data-document-navigator-view={view}>
      <div className="shell-navigator__head document-navigator__head">
        {/* A fixed name for what the navigator holds (V24); the library's folder stays in the tooltip. */}
        <span className="shell-navigator__title" title={vaultRoot ?? undefined}>内容管理</span>
        <Segmented label="资料库视角" value={view} onChange={setView} options={VIEW_OPTIONS} />
      </div>
      <div className="document-navigator__stage">
      <div className="document-navigator__view ink-scope" {...viewMotion('pages')}>
        <InkSidebar
          roots={roots}
          onShowFiles={onShowFiles}
          onMountFolder={() => { void mount() }}
          mountedFolders={hasMounted || mountError ? (
            <>
              {hasMounted && <FileTree rootFilter={isMounted} showEmergence={false} contextExtras={adoptItem} />}
              {mountError && <div role="alert" className="ink-sb-banner">{mountError}</div>}
            </>
          ) : undefined}
        />
      </div>
      <div className="document-navigator__view" {...viewMotion('files')}>
        <FilesPanel isVisible={visible && view === 'files'}>
          {slots => <div className="document-navigator__files">{slots.body}</div>}
        </FilesPanel>
      </div>
      </div>
    </div>
  )
}
