import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { LibraryArchiveAPI, LibraryArchiveProgress, LibraryArchiveReport } from '../../../shared/library'
import type { BookSourcesAPI } from '../../../shared/library-sources'
import { Button, closeFloat, isFloatOpen, openFloat } from '../../components/ui'
import { confirmed } from '../../modules/library/access'
import { BookSourceSettingsPanel } from './BookSourceSettingsPanel'
import { SettingsCard, SettingsRow } from './settings-shared'

// Settings › 阅读: the book sources 找书 uses, and the one-time move from 藏书阁, which used to sit on the shelf (W4 §3).
export function ReadingSettingsPanel({ sources, archive = window.electronAPI?.libraryArchive }: { sources?: BookSourcesAPI; archive?: LibraryArchiveAPI }) {
  return (
    <div className="flex flex-col gap-4">
      <BookSourceSettingsPanel api={sources} />
      {archive && (
        <SettingsCard title="迁移">
          <SettingsRow label="从藏书阁导入" description="把桌面版藏书阁的书、阅读进度、书签和划线复制到当前资料库。只需做一次；原目录保持不变，已导入的书会跳过。">
            <ArchiveImport api={archive} />
          </SettingsRow>
        </SettingsCard>
      )}
    </div>
  )
}

const DIALOG = 'library-archive-import'
type View = { kind: 'idle' } | { kind: 'choose'; suggestion: string; error: string } |
  { kind: 'running'; progress: LibraryArchiveProgress | null } | { kind: 'report'; report: LibraryArchiveReport }
type Store = { get(): View; set(view: View): void; subscribe(listener: () => void): () => void }

// The row and its dialog (a float, drawn by the app's float host outside this tree) read the same state.
function createStore(): Store {
  let view: View = { kind: 'idle' }
  const listeners = new Set<() => void>()
  return {
    get: () => view,
    set: next => { view = next; listeners.forEach(listener => listener()) },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/**
 * Choose 藏书阁's data folder, watch the progress, read the report. The dialog is the shared W1 dialog float, so Esc
 * or a click outside closes it at any time: an import that is still running carries on, the button says so, and
 * its report (or the reason it failed) opens again when it ends.
 */
function ArchiveImport({ api }: { api: LibraryArchiveAPI }) {
  const [store] = useState(createStore)
  const view = useSyncExternalStore(store.subscribe, store.get)
  const trigger = useRef<HTMLButtonElement>(null), mounted = useRef(true)
  useEffect(() => api.onArchiveProgress(progress => {
    if (store.get().kind === 'running') store.set({ kind: 'running', progress })
  }), [api, store])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; closeFloat(DIALOG) } }, [])
  const show = () => openFloat({
    id: DIALOG, anchor: { left: 0, top: 0, right: 0, bottom: 0 }, placement: 'center', modal: true, role: 'dialog', label: '从藏书阁导入',
    className: 'rn-dialog', style: { maxHeight: '70vh', overflowY: 'auto' },
    onClose: () => { if (store.get().kind !== 'running') store.set({ kind: 'idle' }); trigger.current?.focus() },
    render: close => <ArchiveDialog store={store} onRun={run} onClose={close} />,
  })
  const open = async () => {
    let suggestion = '', error = ''
    try { suggestion = confirmed(await api.archiveSuggestion()) }
    catch (reason) { console.warn('[ReadingSettings] 藏书阁 suggestion failed:', reason); error = String(reason) }
    store.set({ kind: 'choose', suggestion, error }); show()
  }
  async function run() {
    const chooser = store.get()
    if (chooser.kind !== 'choose') return
    store.set({ kind: 'running', progress: null })
    let next: View
    try {
      const report = confirmed(await api.pickAndImportArchive())
      // No report: the folder or the confirmation was cancelled.
      next = report ? { kind: 'report', report } : isFloatOpen(DIALOG) ? { ...chooser, error: '' } : { kind: 'idle' }
    } catch (error) { console.warn('[ReadingSettings] 藏书阁 import failed:', error); next = { ...chooser, error: String(error) } }
    store.set(next)
    if (next.kind !== 'idle' && mounted.current && !isFloatOpen(DIALOG)) show()
  }
  return <Button ref={trigger} size="sm" disabled={view.kind === 'running'} onClick={() => void open()}>{view.kind === 'running' ? '正在导入…' : '导入…'}</Button>
}

const PATH: CSSProperties = { display: 'block', marginTop: 4, overflowWrap: 'anywhere', font: '400 var(--rn-fs-sm)/1.5 var(--rn-font-mono)', color: 'var(--rn-ink)' }
const TRACK: CSSProperties = { height: 4, marginTop: 10, borderRadius: 'var(--rn-r-pill)', background: 'var(--rn-fill-2)', overflow: 'hidden' }
const LIST: CSSProperties = { margin: '6px 0 0', paddingLeft: 18, listStyle: 'disc' }

function ArchiveDialog({ store, onRun, onClose }: { store: Store; onRun(): Promise<void>; onClose(): void }) {
  const view = useSyncExternalStore(store.subscribe, store.get)
  const progress = view.kind === 'running' ? view.progress : null
  return <>
    <h2 className="rn-dialog__title">从藏书阁导入</h2>
    <div className="rn-dialog__body">
      {view.kind === 'choose' && <>
        {view.error && <p role="alert" style={{ marginBottom: 8, color: 'var(--rn-bad)' }}>{view.error}</p>}
        <p>选择包含 library.json、files 和 covers 的数据目录。原目录保持不变。</p>
        {view.suggestion && <p style={{ marginTop: 8 }}>桌面版建议位置（不会自动读取）：<code style={PATH}>{view.suggestion}</code></p>}
      </>}
      {view.kind === 'running' && <div role="status">
        <p>{progress ? `正在导入 ${progress.completed} / ${progress.total}：${progress.title}` : '等待选择目录和确认…'}</p>
        {progress && <div role="progressbar" aria-label="藏书阁导入进度" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed} style={TRACK}>
          <div style={{ width: `${progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%`, height: '100%', borderRadius: 'inherit', background: 'var(--rn-ink-2)', transition: 'width var(--rn-d-2) var(--rn-ease-out)' }} />
        </div>}
      </div>}
      {view.kind === 'report' && <>
        <p role="status">导入结束：成功 {view.report.success.length} 本，跳过 {view.report.skipped.length} 本，失败 {view.report.failed.length} 本；未定位划线 {view.report.unlocated} 条。</p>
        {view.report.failed.length > 0 && <details style={{ marginTop: 8 }}><summary>查看失败项</summary><ul style={LIST}>{view.report.failed.map(item => <li key={item.id}>{item.title}：{item.reason}</li>)}</ul></details>}
        {view.report.skipped.length > 0 && <details style={{ marginTop: 8 }}><summary>查看跳过项</summary><ul style={LIST}>{view.report.skipped.map(item => <li key={item.id}>{item.title}：{item.reason}</li>)}</ul></details>}
      </>}
    </div>
    {view.kind === 'choose' && <div className="rn-dialog__actions">
      <Button variant="ghost" onClick={onClose}>取消</Button>
      <Button variant="primary" data-autofocus autoFocus onClick={() => void onRun()}>选择目录并导入</Button>
    </div>}
    {view.kind === 'report' && <div className="rn-dialog__actions"><Button variant="primary" data-autofocus autoFocus onClick={onClose}>关闭</Button></div>}
  </>
}
