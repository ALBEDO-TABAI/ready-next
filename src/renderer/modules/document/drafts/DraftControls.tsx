import { Inbox, Library } from 'lucide-react'
import { finalizeDraftTab } from './save'
import { useState } from 'react'
import { ConnectedSaveToPicker } from '../page-ui/ConnectedSaveToPicker'
import { useDocTabs } from '../../../stores/useDocTabs'
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
      } catch (failure) { setSetup({ busy: false, error: failure instanceof Error ? failure.message : String(failure) }) }
    }
    return <div className="ink-scope ink-boot" data-draft-boot="no_vault">
      <div role="status" className="ink-boot-card">
        <div className="ink-boot-mark" aria-hidden><Library size={26} strokeWidth={1.5} /></div>
        <h2 className="ink-boot-title">先选一个资料库</h2>
        <p className="ink-boot-text">页面、草稿和书房都保存在资料库这个文件夹里。选好之后，就可以开始写了。</p>
        <div className="ink-boot-actions">
          <button className="ink-btn ink-btn-primary" disabled={setup.busy} onClick={() => void run(() => window.electronAPI.vault.createDefault())}>新建默认资料库</button>
          <button className="ink-btn" disabled={setup.busy} onClick={() => void run(async () => {
            const picked = await window.electronAPI.document.openFolder({ validateAsWorkspace: true })
            return picked.success && picked.path ? window.electronAPI.vault.set(picked.path) : null
          })}>选择文件夹…</button>
        </div>
        {setup.error && <p role="alert" className="ink-boot-error">{setup.error}</p>}
      </div>
    </div>
  }
  return <div className="ink-scope ink-boot" data-draft-boot={boot}>
    <div role="status" className="ink-boot-card">
      {boot === 'loading' ? <p className="ink-boot-text">正在恢复未保存的草稿…</p> : <p className="ink-boot-text ink-boot-error">{error}</p>}
      {boot === 'failed' && <div className="ink-boot-actions"><button className="ink-btn" onClick={() => { void initializeDrafts().catch(reportDraftError) }}>重试恢复（原数据已保留）</button></div>}
    </div>
  </div>
}

export function DraftControls() {
  const { error, saveTabId, saveParentPath, saveRequestId } = useDraftUI()
  const tabs = useDocTabs(state => state.tabs)
  const activeId = useDocTabs(state => state.focusedPaneTabId || state.activeTabId)
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
    {status && <span role="status" className={`ink-topbar-status${status.status === 'failed' ? ' is-error' : status.status === 'confirmed' ? ' is-quiet' : ''}`} data-testid="draft-status">{status.status === 'confirmed' ? '已持久确认' : status.status === 'pending' ? '等待确认' : `确认失败，内容已保留：${status.message}`}</span>}
    {status?.status === 'failed' && <button className="ink-topbar-btn" onClick={() => { void run(() => drafts.flush(activeId)) }}>重试确认</button>}
    {status?.conflict && <button className="ink-topbar-btn" onClick={() => { const draft = drafts.recovery.find(item => item.draftId === tabs.find(tab => tab.id === activeId)?.draftId); if (draft) void run(() => open(draft)) }}>查看版本冲突</button>}
    {drafts.recovery.length > 0 && <button className={`ink-topbar-icon ink-draft-badge${showList ? ' is-open' : ''}`} aria-expanded={showList} aria-label={`未保存的草稿（${drafts.recovery.length}）`} title="未保存的草稿"
      onClick={() => setShowList(!showList)}><Inbox size={18} strokeWidth={1.6} aria-hidden /><span aria-hidden>{drafts.recovery.length}</span></button>}
    {(() => { const tab = tabs.find(item => item.id === activeId); return tab?.path === null && tab.kind !== 'library' })() && <button className="ink-topbar-btn is-accent" onClick={() => requestDraftSave(activeId)}>保存到…</button>}
    {error && !saveTabId && <p role="alert" className="ink-draft-panel ink-panel-error">{error}</p>}
    {showList && <div className="ink-draft-panel ink-trash-list" role="dialog" aria-label="未保存的草稿">{drafts.recovery.map(draft => <div key={draft.draftId} className="ink-trash-item" data-testid={`draft-recovery-${draft.draftId}`}>
      <button disabled={busy} className="ink-sb-label-btn ink-menu-text" onClick={() => { void run(() => open(draft)) }}>{draft.title || '未命名草稿'}{draft.state === 'conflict' ? '（冲突）' : ''}{drafts.recoveryLabel(draft.draftId) && `（${drafts.recoveryLabel(draft.draftId)}）`}</button>
      <button disabled={busy} className="ink-btn" onClick={() => { void run(async () => {
        if (!await drafts.discard(draft.draftId)) throw new Error('放弃期间有新输入，已另存为草稿')
        for (const tab of tabs.filter(tab => tab.draftId === draft.draftId)) useDocTabs.getState().closeTab(tab.id)
      }) }}>放弃更改</button>
    </div>)}</div>}
    {conflict && <section role="dialog" aria-label="草稿版本冲突" className="ink-draft-panel ink-draft-conflict">
      <div className="grid grid-cols-2 gap-3"><div>磁盘版本<pre className="max-h-64 overflow-auto whitespace-pre-wrap">{conflict.disk}</pre></div><div>草稿版本<pre className="max-h-64 overflow-auto whitespace-pre-wrap">{tabs.find(tab => tab.id === conflict.tabId)?.content ?? conflict.draft.content}</pre></div></div>
      <button disabled={busy} onClick={() => { void run(async () => {
        const result = await drafts.overwrite(conflict.tabId, conflict.disk, input => window.electronAPI.documentPages.save(input))
        if (result.status === 'conflict') {
          setConflict({ ...conflict, disk: result.disk })
          throw new Error('磁盘版本又有变化，请重新比较后再决定')
        }
        setConflict(null)
      }) }}>用草稿覆盖</button>
      <button disabled={busy} className="ink-btn" onClick={() => { void run(async () => {
        if (!await drafts.discard(conflict.draft.draftId)) throw new Error('放弃期间有新输入，已另存为草稿')
        useDocTabs.getState().closeTab(conflict.tabId)
        setConflict(null)
      }) }}>保留磁盘版本并放弃草稿</button>
      <button disabled={busy} className="ink-btn" onClick={() => { void run(async () => {
        const state = useDocTabs.getState()
        const original = state.tabs.find(tab => tab.id === conflict.tabId)!
        const id = state.createBackgroundTab({ title: original.title, content: original.content })
        state.updateTabContent(id, original.content)
        await drafts.flush(id)
        state.setActiveTab(id); requestDraftSave(id); setConflict(null)
      }) }}>另存为新文档</button>
      <button className="ink-btn" onClick={() => setConflict(null)}>关闭比较</button>
    </section>}
    {saveTabId && <div className="ink-draft-panel"><ConnectedSaveToPicker key={saveRequestId} initialTitle={tabs.find(tab => tab.id === saveTabId)?.title.replace(/\.md$/i, '') || '新文档'}
      initialParentPath={saveParentPath} onCancel={() => completeDraftSave(null, saveRequestId)} onConfirm={async selection => {
        const saved = await finalizeDraftTab(saveTabId, selection)
        completeDraftSave(saved.path, saveRequestId)
        return { ok: true, value: saved }
      }} /></div>}
  </div>
}
