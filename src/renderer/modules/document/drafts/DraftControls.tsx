import { Inbox, Library } from 'lucide-react'
import { Button } from '../../../components/ui'
import { finalizeDraftTab } from './save'
import { useState } from 'react'
import { ConnectedSaveToPicker } from '../page-ui/ConnectedSaveToPicker'
import { useDocTabs } from '../../../stores/useDocTabs'
import { useInkLayout } from '../ink/layout-state'
import { completeDraftSave, drafts, initializeDrafts, reportDraftError, requestDraftSave, useDraftUI } from './runtime'
import type { DocumentDraft } from '../../../../shared/document-drafts'

export function DraftBootNotice() {
  const { boot, error } = useDraftUI()
  const [setup, setSetup] = useState<{ busy: boolean; error: string }>({ busy: false, error: '' })
  if (boot === 'no_vault') {
    // Choosing the vault broadcasts vault:changed; the draft runtime then starts by itself.
    const run = async (choose: () => Promise<{ status: string } | null>) => {
      setSetup({ busy: true, error: '' })
      try {
        const state = await choose()
        setSetup({ busy: false, error: state && state.status !== 'ready' ? '这个文件夹现在无法作为资料库使用，请换一个。' : '' })
      } catch (failure) { console.warn('[DraftControls] select vault failed:', failure instanceof Error ? failure.message : String(failure)); setSetup({ busy: false, error: failure instanceof Error ? failure.message : String(failure) }) }
    }
    return <div className="ink-scope ink-boot" data-draft-boot="no_vault">
      <div role="status" className="ink-boot-card rn-sheet">
        <div className="ink-boot-mark" aria-hidden><Library size={26} strokeWidth={1.5} /></div>
        <h2 className="ink-boot-title">先选一个资料库</h2>
        <p className="ink-boot-text">页面、草稿和书房都保存在资料库这个文件夹里。选好之后，就可以开始写了。</p>
        <div className="ink-boot-actions">
          <Button variant="primary" disabled={setup.busy} onClick={() => void run(() => window.electronAPI.vault.createDefault())}>新建默认资料库</Button>
          <Button disabled={setup.busy} onClick={() => void run(async () => {
            const picked = await window.electronAPI.document.openFolder({ validateAsWorkspace: true })
            return picked.success && picked.path ? window.electronAPI.vault.set(picked.path) : null
          })}>选择文件夹…</Button>
        </div>
        {setup.error && <p role="alert" className="ink-boot-error">{setup.error}</p>}
      </div>
    </div>
  }
  return <div className="ink-scope ink-boot" data-draft-boot={boot}>
    <div role="status" className="ink-boot-card rn-sheet">
      {boot === 'loading' ? <p className="ink-boot-text">正在恢复未保存的草稿…</p> : <p className="ink-boot-text ink-boot-error">{error}</p>}
      {boot === 'failed' && <div className="ink-boot-actions"><Button onClick={() => { void initializeDrafts().catch(reportDraftError) }}>重试恢复（原数据已保留）</Button></div>}
    </div>
  </div>
}

export function DraftControls() {
  const { error, saveTabId, saveParentPath, saveRequestId, saveHost } = useDraftUI()
  const tabs = useDocTabs(state => state.tabs)
  const activeId = useDocTabs(state => state.focusedPaneTabId || state.activeTabId)
  // On 今日 there is no page: only the recovery badge and its panel show (the active tab's status does not).
  const home = useInkLayout(state => state.home)
  const [showList, setShowList] = useState(false)
  const [conflict, setConflict] = useState<{ draft: DocumentDraft; tabId: string; disk: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const status = drafts.status(activeId)
  const run = async (work: () => Promise<void>) => {
    setBusy(true); useDraftUI.setState({ error: '' })
    try { await work() } catch (error) { reportDraftError(error) } finally { setBusy(false) }
  }
  const open = async (draft: DocumentDraft) => {
    const state = useDocTabs.getState()
    let id = state.tabs.find(tab => tab.draftId === draft.draftId)?.id
    if (!id) id = state.createBackgroundTab({ title: draft.title })
    await drafts.attach(id, draft)
    state.setActiveTab(id)
    if (drafts.status(id)?.conflict) {
      const tab = useDocTabs.getState().tabs.find(tab => tab.id === id)!
      const disk = tab.path ? await window.electronAPI.document.readFile(tab.path) : null
      if (!disk?.success || typeof disk.content !== 'string') throw new Error(disk?.error || '无法读取磁盘版本，草稿已保留')
      setConflict({ draft, tabId: id, disk: disk.content })
    }
  }
  // Lives in the document topbar: a quiet status, the drafts pill when there are drafts, and dropdown panels below it.
  return <div className="ink-draft-controls" data-testid="draft-controls">
    {!home && status && <span role="status" className={`ink-topbar-status${status.status === 'failed' ? ' is-error' : status.status === 'confirmed' ? ' is-quiet' : ''}`} data-testid="draft-status">{status.status === 'confirmed' ? '已持久确认' : status.status === 'pending' ? '等待确认' : `确认失败，内容已保留：${status.message}`}</span>}
    {!home && status?.status === 'failed' && <Button size="sm" variant="ghost" onClick={() => { void run(() => drafts.flush(activeId)) }}>重试确认</Button>}
    {!home && status?.conflict && <Button size="sm" variant="ghost" onClick={() => { const draft = drafts.recovery.find(item => item.draftId === tabs.find(tab => tab.id === activeId)?.draftId); if (draft) void run(() => open(draft)) }}>查看版本冲突</Button>}
    {/* The recovery badge counts drafts not yet saved: "unsaved" is a now-state, so its count carries the signal (DL5). */}
    {drafts.recovery.length > 0 && <button type="button" className="rn-icon-btn ink-draft-badge" aria-pressed={showList} aria-expanded={showList} aria-label={`未保存的草稿（${drafts.recovery.length}）`} title="未保存的草稿"
      onClick={() => setShowList(!showList)}><Inbox aria-hidden /><span aria-hidden>{drafts.recovery.length}</span></button>}
    {!home && (() => { const tab = tabs.find(item => item.id === activeId); return tab?.path === null && tab.kind !== 'library' })() && <Button size="sm" variant="primary" onClick={() => requestDraftSave(activeId)}>保存到…</Button>}
    {error && !saveTabId && <p role="alert" className="ink-draft-panel rn-float ink-panel-error">{error}</p>}
    {showList && <div className="ink-draft-panel rn-float ink-draft-list" role="dialog" aria-label="未保存的草稿">{drafts.recovery.map(draft => <div key={draft.draftId} className="ink-trash-item" data-testid={`draft-recovery-${draft.draftId}`}>
      <button type="button" disabled={busy} className="ink-sb-label-btn" onClick={() => { void run(() => open(draft)) }}>{draft.title || '未命名草稿'}{draft.state === 'conflict' ? '（冲突）' : ''}{drafts.recoveryLabel(draft.draftId) && `（${drafts.recoveryLabel(draft.draftId)}）`}</button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(async () => {
        if (!await drafts.discard(draft.draftId)) throw new Error('放弃期间有新输入，已另存为草稿')
        for (const tab of tabs.filter(tab => tab.draftId === draft.draftId)) useDocTabs.getState().closeTab(tab.id)
      }) }}>放弃更改</Button>
    </div>)}</div>}
    {conflict && <section role="dialog" aria-label="草稿版本冲突" className="ink-draft-panel rn-float ink-draft-conflict">
      <div className="grid grid-cols-2 gap-3"><div>磁盘版本<pre className="max-h-64 overflow-auto whitespace-pre-wrap">{conflict.disk}</pre></div><div>草稿版本<pre className="max-h-64 overflow-auto whitespace-pre-wrap">{tabs.find(tab => tab.id === conflict.tabId)?.content ?? conflict.draft.content}</pre></div></div>
      <div className="ink-draft-conflict-actions">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void run(async () => {
        const result = await drafts.overwrite(conflict.tabId, conflict.disk, input => window.electronAPI.documentPages.save(input))
        if (result.status === 'conflict') {
          setConflict({ ...conflict, disk: result.disk })
          throw new Error('磁盘版本又有变化，请重新比较后再决定')
        }
        setConflict(null)
      }) }}>用草稿覆盖</Button>
      <Button size="sm" disabled={busy} onClick={() => { void run(async () => {
        if (!await drafts.discard(conflict.draft.draftId)) throw new Error('放弃期间有新输入，已另存为草稿')
        useDocTabs.getState().closeTab(conflict.tabId)
        setConflict(null)
      }) }}>保留磁盘版本并放弃草稿</Button>
      <Button size="sm" disabled={busy} onClick={() => { void run(async () => {
        const state = useDocTabs.getState()
        const original = state.tabs.find(tab => tab.id === conflict.tabId)!
        const id = state.createBackgroundTab({ title: original.title, content: original.content })
        state.updateTabContent(id, original.content)
        await drafts.flush(id)
        state.setActiveTab(id); requestDraftSave(id); setConflict(null)
      }) }}>另存为新文档</Button>
      <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>关闭比较</Button>
      </div>
    </section>}
    {saveTabId && saveHost === 'document' && <div className="ink-draft-panel rn-float"><ConnectedSaveToPicker key={saveRequestId} initialTitle={tabs.find(tab => tab.id === saveTabId)?.title.replace(/\.md$/i, '') || '新文档'}
      initialParentPath={saveParentPath} onCancel={() => completeDraftSave(null, saveRequestId)} onConfirm={async selection => {
        const saved = await finalizeDraftTab(saveTabId, selection)
        completeDraftSave(saved.path, saveRequestId)
        return { ok: true, value: saved }
      }} /></div>}
  </div>
}
