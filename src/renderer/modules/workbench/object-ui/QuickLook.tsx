import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import { toReadyUri } from '../../../../shared/ready-ref'
import { useDocTabs } from '../../../stores/useDocTabs'
import { beginBrowserMask, endPersistentBrowserMask } from '../../overlay/browserViewMask'
import { openObjectTarget, type PreviewTarget } from './navigation'
import { loadObjectPreview, type ObjectPreview } from './preview'

/** The children are never mounted until native hide has been acknowledged. */
export function MaskedObjectOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false, acquired = false
    void beginBrowserMask({ persistent: true, requireAck: true }).then(confirmed => {
      if (disposed) { if (confirmed) void endPersistentBrowserMask(); return }
      acquired = confirmed
      if (confirmed) setReady(true)
      else setError('网页层未确认隐藏，请关闭后重试')
    })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', escape, true)
    return () => { disposed = true; window.removeEventListener('keydown', escape, true); if (acquired) void endPersistentBrowserMask() }
  }, [onClose])
  if (error) return createPortal(<div role="alert" className="rn-object-ui"><p>{error}</p><button onClick={onClose}>关闭</button></div>, document.body)
  return ready ? createPortal(<div className="rn-object-ui fixed inset-0 z-[200] flex items-start justify-center bg-black/20 pt-[12vh]" onClick={onClose}>
    <section role="dialog" aria-modal="true" className="w-[min(680px,90vw)] max-h-[75vh] overflow-auto rounded-xl bg-[var(--bg-editor)] p-5 text-[var(--text-primary)] shadow-xl" onClick={event => event.stopPropagation()}>
      {children}
    </section>
  </div>, document.body) : null
}

export function QuickLook({ reference, onClose }: { reference: PreviewTarget; onClose: () => void }) {
  const tabs = useDocTabs(state => state.tabs)
  const [value, setValue] = useState<{ key: string; preview: ObjectPreview } | null>(null)
  const [error, setError] = useState('')
  const key = reference.kind === 'draft' ? `draft:${reference.tabId}` : toReadyUri(reference)
  useEffect(() => {
    let active = true
    let revision = 0
    const read = () => {
      const current = ++revision
      const tab = reference.kind === 'draft' ? useDocTabs.getState().tabs.find(tab => tab.id === reference.tabId) : undefined
      const result: Promise<ObjectPreview> = reference.kind !== 'draft' ? loadObjectPreview(reference) : Promise.resolve(tab
        ? { state: 'ready', title: tab.title, body: tab.content, markdown: true, unsaved: !tab.path || tab.isDirty }
        : { state: 'invalid', title: '草稿已失效', message: '草稿已关闭' })
      void result.then(preview => { if (active && current === revision) setValue({ key, preview }) }, error => { if (active && current === revision) setValue({ key, preview: { state: 'unavailable', title: '无法速览', message: String(error) } }) })
    }
    read()
    const off = window.electronAPI.documentPages?.onChanged(read)
    return () => { active = false; off?.() }
  }, [reference, key, tabs])
  const preview = value?.key === key ? value.preview : null
  const open = async () => { try { await openObjectTarget(reference); onClose() } catch (error) { setError(String(error)) } }
  return <MaskedObjectOverlay onClose={onClose}>
    <header className="flex justify-between gap-3"><h2>{preview?.title || '正在读取…'}</h2><button onClick={onClose}>关闭</button></header>
    {preview?.state === 'ready' ? <>
      {preview.unsaved && <p role="status">未保存</p>}
      <div className="my-4 whitespace-pre-wrap">{preview.markdown ? <ReactMarkdown>{preview.body}</ReactMarkdown> : preview.body}</div>
      <button onClick={() => void open()}>打开</button>
    </> : preview && <p role="status">{preview.message}</p>}
    {error && <p role="alert">{error}</p>}
  </MaskedObjectOverlay>
}
