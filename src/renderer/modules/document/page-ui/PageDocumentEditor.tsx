import { useEffect } from 'react'
import MarkdownEditor from '../../../components/document/MarkdownEditor'
import { useDocTabs, type DocTab } from '../../../stores/useDocTabs'
import { useVault } from '../../../stores/useVault'
import type { RetainedDocumentEditorProps } from '../documentSceneRetention'
import { PageHeader } from './PageHeader'
import { runRegisteredDocumentSave } from '../documentSaveRegistry'
import { readDocumentSource } from '../../../../shared/document-operations'
import type { PageProperties } from '../../../../shared/document-pages'
import { Database } from '../database'

/** Markdown in the preview reads as an Inkwell page; vault pages also get the page header (icon, cover, title). */
export function PageDocumentEditor({ bookReading = false, ...props }: RetainedDocumentEditorProps<DocTab> & { bookReading?: boolean }) {
  const vault = useVault(state => state.view.data)
  useEffect(() => {
    if (useVault.getState().view.phase === 'idle') void useVault.getState().load()
  }, [])
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
  const markdown = props.viewMode === 'preview' && !bookReading && (!path || /\.md$/i.test(path))
  if (!markdown) return <MarkdownEditor {...props} />
  const source = frontmatter(tab.content)
  const display = (source.ready_page ?? {}) as NonNullable<PageProperties['ready_page']>
  const page = root && inVault && tab.objectId && tab.objectBinding?.status === 'resolved'
  const classes = ['ink-page', display.font === 'serif' ? 'font-serif' : display.font === 'mono' ? 'font-mono' : '',
    display.small_text ? 'is-small' : '', display.full_width ? 'is-full' : '', page ? 'has-header' : ''].filter(Boolean).join(' ')
  return <MarkdownEditor {...props} previewClassName={classes} previewHeader={page ? <>
    <PageHeader key={tab.objectId} objectId={tab.objectId!} root={root} title={tab.title.replace(/\.md$/i, '')} beforeSave={beforeSave} tabId={tab.id} />
    {/* A database page shows its database under the header, like the inline views; the body below stays editable. */}
    {source.ready_database ? <section data-ready-database-page className="ink-page-database"><Database key={tab.objectId} databaseId={tab.objectId!} /></section> : null}
  </> : undefined} />
}

function frontmatter(content: string): Record<string, unknown> {
  try { return readDocumentSource(content).frontmatter } catch { return {} }
}
