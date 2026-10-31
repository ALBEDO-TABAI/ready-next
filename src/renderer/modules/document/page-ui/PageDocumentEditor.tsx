import { useEffect } from 'react'
import MarkdownEditor from '../../../components/document/MarkdownEditor'
import { useDocTabs, type DocTab } from '../../../stores/useDocTabs'
import { useVault } from '../../../stores/useVault'
import type { RetainedDocumentEditorProps } from '../documentSceneRetention'
import { usePageView } from './page-panel-state'
import { PageHeader } from './PageHeader'
import { runRegisteredDocumentSave } from '../documentSaveRegistry'
import { readDocumentSource } from '../../../../shared/document-operations'
import { Database } from '../database'

export function PageDocumentEditor({ bookReading = false, ...props }: RetainedDocumentEditorProps<DocTab> & { bookReading?: boolean }) {
  const vault = useVault(state => state.view.data)
  useEffect(() => {
    if (useVault.getState().view.phase === 'idle') void useVault.getState().load()
  }, [])
  const view = usePageView(state => state.view)
  const { tab } = props
  const path = tab.path?.replace(/\\/g, '/')
  const root = vault?.status === 'ready' ? vault.root : null
  const inVault = root && path?.startsWith(`${root.replace(/\\/g, '/').replace(/\/$/, '')}/`)
  const beforeSave = async () => {
    if (!useDocTabs.getState().tabs.find(item => item.id === tab.id)?.isDirty) return
    if (!await runRegisteredDocumentSave(tab.id) || useDocTabs.getState().tabs.find(item => item.id === tab.id)?.isDirty) {
      throw new Error('正文尚未保存，页面属性未修改。请先保存正文后重试。')
    }
  }
  return <>
    {view === 'pages' && props.viewMode === 'preview' && !bookReading && root && inVault && path && /\.md$/i.test(path)
      && tab.objectId && tab.objectBinding?.status === 'resolved'
      && <PageHeader key={tab.objectId} objectId={tab.objectId} root={root} title={tab.title.replace(/\.md$/i, '')} beforeSave={beforeSave} />}
    {/* A database page shows its database under the header, like the inline views; the body below stays editable. */}
    {view === 'pages' && props.viewMode === 'preview' && !bookReading && inVault && tab.objectId && tab.objectBinding?.status === 'resolved'
      && databasePage(tab.content) && <section data-ready-database-page className="px-6"><Database key={tab.objectId} databaseId={tab.objectId} /></section>}
    <MarkdownEditor {...props} />
  </>
}

function databasePage(content: string): boolean {
  try { return Boolean(readDocumentSource(content).frontmatter.ready_database) } catch { return false }
}
