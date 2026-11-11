import type { PageNode, PageRoot } from '../../../../shared/document-pages'
import { Segmented } from '../../../components/ui'
import FilesPanel from '../../../components/layout/FilesPanel'
import { FILES_PANEL_DIMENSIONS } from '../../../components/layout/panelTokens'
import { useDocumentNavigator, type DocumentNavigatorView } from './useDocumentNavigator'
import { ShellSidebarToggle } from '../../workbench/shell/ShellSidebar'
import { InkSidebar } from '../ink/InkSidebar'
import './document-navigator.css'

// The document mode's navigator in the shell sidebar (W2-T5): the library seen as pages (the page tree)
// or as files (the file manager, with its list/thumbnail views, filters and context actions). W3 turns
// the two into one tree with two views; until then each view is the existing component, unchanged.

const VIEW_OPTIONS: { value: DocumentNavigatorView; label: string }[] = [
  { value: 'pages', label: '页面' },
  { value: 'files', label: '文件' },
]

export default function DocumentNavigator({ roots, visible, onShowFiles }: {
  roots: PageRoot[]
  visible: boolean
  onShowFiles(node: PageNode): void | Promise<void>
}) {
  const view = useDocumentNavigator(state => state.view)
  const setView = useDocumentNavigator(state => state.setView)
  return (
    <div className="document-navigator" data-document-navigator-view={view}>
      <div className="document-navigator__switch">
        <Segmented label="资料库视角" value={view} onChange={setView} options={VIEW_OPTIONS} />
        <ShellSidebarToggle />
      </div>
      <div className="document-navigator__view ink-scope" hidden={view !== 'pages'}>
        <InkSidebar roots={roots} onShowFiles={onShowFiles} />
      </div>
      <div className="document-navigator__view" hidden={view !== 'files'}>
        <FilesPanel isVisible={visible && view === 'files'}>
          {slots => (
            <div className="document-navigator__files" style={{ gridTemplateRows: `${FILES_PANEL_DIMENSIONS.headerHeight}px minmax(0, 1fr)` }}>
              <div className="document-navigator__files-head">{slots.header}</div>
              <div className="document-navigator__files-body">{slots.body}</div>
            </div>
          )}
        </FilesPanel>
      </div>
    </div>
  )
}
