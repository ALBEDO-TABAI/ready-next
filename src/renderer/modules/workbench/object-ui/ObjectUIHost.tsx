import { useCallback, useEffect, useRef, useState } from 'react'
import { parseReadyUri } from '../../../../shared/ready-ref'
import { appShortcut, matchesAppShortcut } from '../../../../shared/app-shortcuts'
import { registerGlobalCommands } from '../commands/global-commands'
import { OPEN_QUICK_LOOK_EVENT, OPEN_QUICK_SWITCHER_EVENT, SHELL_ACTION_EVENT } from '../commands/shell-actions'
import { openObjectTarget } from './navigation'
import { QuickLook, MaskedObjectOverlay } from './QuickLook'
import { QuickSwitcher } from './QuickSwitcher'
import type { PreviewTarget } from './navigation'

/** Mount once in the workbench shell. The shell owns settings navigation. */
export function ObjectUIHost({ onSettings }: { onSettings: () => void }) {
  const [surface, setSurface] = useState<{ kind: 'switcher' } | { kind: 'preview'; target: PreviewTarget } | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const creating = useRef(false), createRequest = useRef<{ root: string; operationId: string } | null>(null)
  const close = useCallback(() => setSurface(null), [])
  const preview = useCallback((target: PreviewTarget) => setSurface({ kind: 'preview', target }), [])
  useEffect(registerGlobalCommands, [])
  useEffect(() => {
    // 新建页面 and 新建数据库 (W3 §4.4): at the library root, then open; a retry reuses the operation id.
    const createPage = async (database = false) => {
      if (creating.current) return
      creating.current = true
      try {
        const vault = await window.electronAPI.vault.get()
        if (vault.status !== 'ready') throw new Error('请先打开资料库')
        if (createRequest.current?.root !== vault.root) createRequest.current = { root: vault.root, operationId: crypto.randomUUID() }
        const result = await window.electronAPI.documentPages.operate({ type: 'create', ...createRequest.current, parentPath: vault.root, title: database ? '未命名数据库' : '新页面', content: '', ...(database ? { database: true } : {}) })
        if (!result.ok) throw new Error(result.message)
        if (mounted.current) await openObjectTarget({ kind: 'page', id: result.value.objectId })
        createRequest.current = null
      } catch (error) { if (mounted.current) setError(String(error)) }
      finally { creating.current = false }
    }
    const action = (event: WindowEventMap['ready:shell-action']) => {
      if (event.detail.action === 'open-settings') onSettings()
      if (event.detail.action === 'new-page') void createPage()
      if (event.detail.action === 'new-database') void createPage(true)
    }
    window.addEventListener(SHELL_ACTION_EVENT, action)
    return () => window.removeEventListener(SHELL_ACTION_EVENT, action)
  }, [onSettings])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (matchesAppShortcut(appShortcut('open-search'), event)) {
        event.preventDefault(); event.stopImmediatePropagation()
        setSurface(current => current?.kind === 'switcher' ? null : { kind: 'switcher' })
      }
    }
    const click = (event: MouseEvent) => {
      if (!event.altKey || !(event.target instanceof Element)) return
      const link = event.target.closest('a[href]')
      const parsed = parseReadyUri(link?.getAttribute('href') || '')
      if (!parsed.ok) return
      event.preventDefault(); event.stopImmediatePropagation(); preview(parsed.ref)
    }
    // The document sidebar's search field opens the same switcher; reference capsules ask for a quick look.
    const openSwitcher = () => setSurface({ kind: 'switcher' })
    const quickLook = (event: WindowEventMap['ready:open-quick-look']) => preview(event.detail.ref)
    window.addEventListener('keydown', key, true)
    window.addEventListener('click', click, true)
    window.addEventListener(OPEN_QUICK_SWITCHER_EVENT, openSwitcher)
    window.addEventListener(OPEN_QUICK_LOOK_EVENT, quickLook)
    return () => {
      window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true)
      window.removeEventListener(OPEN_QUICK_SWITCHER_EVENT, openSwitcher); window.removeEventListener(OPEN_QUICK_LOOK_EVENT, quickLook)
    }
  }, [preview])
  if (error) return <MaskedObjectOverlay onClose={() => setError('')}><p role="alert">{error}</p><button onClick={() => setError('')}>关闭</button></MaskedObjectOverlay>
  return surface?.kind === 'switcher' ? <QuickSwitcher onClose={close} onPreview={preview} />
    : surface?.kind === 'preview' ? <QuickLook reference={surface.target} onClose={close} /> : null
}
