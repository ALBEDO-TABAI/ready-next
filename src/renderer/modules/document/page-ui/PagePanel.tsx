import { useState } from 'react'
import type { PageRoot } from '../../../../shared/document-pages'
import { useWorkspace } from '../../../stores/useWorkspace'
import { useVault } from '../../../stores/useVault'
import { useDocTabs } from '../../../stores/useDocTabs'
import { requestWorkbenchModeOpen } from '../../workbench/mode-transition'
import { saveBeforePageTrash } from './page-panel-state'
import { PageSidebar } from './PageSidebar'

export function PageViewSwitch({ view, onChange }: { view: 'pages' | 'files'; onChange(view: 'pages' | 'files'): void }) {
  return <div role="group" aria-label="侧栏视角" className="flex gap-3 text-[13px] font-semibold">
    <button className="rounded px-2 py-1" style={{ background: view === 'pages' ? 'var(--files-panel-state-active-bg)' : undefined }} aria-pressed={view === 'pages'} onClick={() => onChange('pages')}>页面</button>
    <button className="rounded px-2 py-1" style={{ background: view === 'files' ? 'var(--files-panel-state-active-bg)' : undefined }} aria-pressed={view === 'files'} onClick={() => onChange('files')}>文件</button>
  </div>
}

export function PageRootNotice({ hasRoots }: { hasRoots: boolean }) {
  const { view, chooseFolder, createDefault } = useVault()
  const [error, setError] = useState<string | null>(null)
  const missing = view.data?.status === 'missing'
  if (hasRoots && !missing) return null
  return <section aria-label="页面位置" className="p-3 text-xs space-y-2" style={{ color: 'var(--text-secondary)' }}>
    <p>{missing ? `找不到资料库：${view.data?.root}` : '设置资料库 / 打开文件夹'}</p>
    <button onClick={() => void (missing ? chooseFolder() : createDefault())}>{missing ? '重新选择资料库…' : '设置资料库'}</button>
    <button className="ml-3" onClick={() => { void useWorkspace.getState().pickWorkspaceRoot().then(result => { if (!result.ok && result.message !== '已取消选择。') setError(result.message || '无法打开文件夹') }) }}>打开文件夹…</button>
    {(error || view.phase === 'error') && <p role="alert">{error || (view.phase === 'error' ? view.message : '')}</p>}
  </section>
}

export function ConnectedPageSidebar({ roots, onFiles }: { roots: PageRoot[]; onFiles(): void }) {
  return <PageSidebar roots={roots} beforeTrash={saveBeforePageTrash}
    onOpen={node => { useWorkspace.getState().selectFile(node.path); useDocTabs.getState().openTab(node.path); requestWorkbenchModeOpen('document') }}
    onShowFiles={async node => { onFiles(); await useWorkspace.getState().revealFile(node.path) }} />
}
