import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { toReadyUri } from '../../../../shared/ready-ref'
import { useDocTabs } from '../../../stores/useDocTabs'
import { Button, IconButton } from '../../../components/ui/Button'
import { REF_CAPSULE_KINDS, refCapsuleKind } from '../../../components/ui/ref-capsule-kinds'
import { beginBrowserMask, endPersistentBrowserMask } from '../../overlay/browserViewMask'
import { openObjectTarget, type PreviewTarget } from './navigation'
import { loadObjectPreview, type ObjectPreview } from './preview'
import { QuickLookBody } from './QuickLookContent'
import { LeavingDiv } from '../../../components/ui/Leaving'

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
  // Arrives like a dialog (scrim fades, panel pops) and fades out in place when closed (motion language M2).
  return ready ? createPortal(<LeavingDiv className="rn-object-ui rn-object-overlay" data-ready-native-overlay="" onClick={onClose}>
    <section role="dialog" aria-modal="true" className="rn-object-panel rn-float" data-float-motion="pop" onClick={event => event.stopPropagation()}>
      {children}
    </section>
  </LeavingDiv>, document.body) : null
}

export function QuickLook({ reference, onClose }: { reference: PreviewTarget; onClose: () => void }) {
  const tabs = useDocTabs(state => state.tabs)
  const [value, setValue] = useState<{ key: string; preview: ObjectPreview } | null>(null)
  const [error, setError] = useState('')
  const key = reference.kind === 'draft' && 'tabId' in reference ? `draft:${reference.tabId}` : toReadyUri(reference)
  useEffect(() => {
    let active = true
    let revision = 0
    const read = () => {
      const current = ++revision
      const tab = reference.kind === 'draft' && 'tabId' in reference ? useDocTabs.getState().tabs.find(tab => tab.id === reference.tabId) : undefined
      const result: Promise<ObjectPreview> = reference.kind !== 'draft' || 'id' in reference ? loadObjectPreview(reference) : Promise.resolve(tab
        ? { state: 'ready', title: tab.title, body: tab.content, markdown: true, unsaved: !tab.path || tab.isDirty }
        : { state: 'invalid', title: '草稿已失效', message: '草稿已关闭' })
      void result.then(preview => { if (active && current === revision) setValue({ key, preview }) }, error => { if (active && current === revision) setValue({ key, preview: { state: 'unavailable', title: '无法速览', message: String(error) } }) })
    }
    read()
    const off = window.electronAPI.documentPages?.onChanged(read)
    return () => { active = false; off?.() }
  }, [reference, key, tabs])
  const preview = value?.key === key ? value.preview : null
  const open = async (newTab = false) => { try { await openObjectTarget(reference, { newTab }); onClose() } catch (error) { setError(String(error)) } }
  const kind = reference.kind === 'draft' && 'tabId' in reference ? 'page' : refCapsuleKind(reference, preview?.state === 'ready' && preview.data?.kind === 'database' ? '数据库' : undefined)
  const Icon = REF_CAPSULE_KINDS[kind].icon
  // A capsule inside the quick look opens its object, so the look steps aside; ⌥-click looks at it here instead.
  return <MaskedObjectOverlay onClose={onClose}>
    <div className="rn-ql rn-ui" onClickCapture={event => { if (!event.altKey && event.target instanceof Element && event.target.closest('[data-ready-ref-capsule]')) window.setTimeout(onClose) }}>
      <header className="rn-ql__head">
        <span className="rn-ql__kind"><Icon aria-hidden />{REF_CAPSULE_KINDS[kind].label}</span>
        <IconButton size="sm" icon={<X />} title="关闭" onClick={onClose} />
      </header>
      <h2 className="rn-ql__title">{preview?.title || '正在读取…'}</h2>
      {preview?.state === 'ready' && preview.unsaved && <p className="rn-ql__badge" role="status">未保存</p>}
      <div className="rn-ql__body">
        {preview?.state === 'ready' ? <QuickLookBody preview={preview} reference={reference} /> : preview ? <p role="status" className="rn-ql-note">{preview.message}</p> : <div className="rn-ql__loading" aria-hidden />}
      </div>
      {preview?.state === 'ready' && <footer className="rn-ql__foot">
        <span>⌘ 点击在新标签打开 · Esc 关闭</span>
        <Button variant="primary" size="sm" onClick={event => void open(event.metaKey || event.ctrlKey)}>打开</Button>
      </footer>}
      {error && <p role="alert" className="rn-ql-note is-error">{error}</p>}
    </div>
  </MaskedObjectOverlay>
}
