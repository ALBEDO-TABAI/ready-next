import { useCallback, useEffect, useRef, useState } from 'react'
import { parseReadyUri } from '../../../../shared/ready-ref'
import { appShortcut, matchesAppShortcut } from '../../../../shared/app-shortcuts'
import { registerGlobalCommands } from '../commands/global-commands'
import { OPEN_QUICK_SWITCHER_EVENT, SHELL_ACTION_EVENT } from '../commands/shell-actions'
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
    const createPage = async () => {
      if (creating.current) return
      creating.current = true
      try {
        const vault = await window.electronAPI.vault.get()
        if (vault.status !== 'ready') throw new Error('请先打开资料库')
        if (createRequest.current?.root !== vault.root) createRequest.current = { root: vault.root, operationId: crypto.randomUUID() }
        const result = await window.electronAPI.documentPages.operate({ type: 'create', ...createRequest.current, parentPath: vault.root, title: '新页面', content: '' })
        if (!result.ok) throw new Error(result.message)
        if (mounted.current) await openObjectTarget({ kind: 'page', id: result.value.objectId })
        createRequest.current = null
      } catch (error) { if (mounted.current) setError(String(error)) }
      finally { creating.current = false }
    }
    const action = (event: WindowEventMap['ready:shell-action']) => {
      if (event.detail.action === 'open-settings') onSettings()
      if (event.detail.action === 'new-page') void createPage()
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
    // The document sidebar's search field opens the same switcher.
    const openSwitcher = () => setSurface({ kind: 'switcher' })
    window.addEventListener('keydown', key, true)
    window.addEventListener('click', click, true)
    window.addEventListener(OPEN_QUICK_SWITCHER_EVENT, openSwitcher)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true); window.removeEventListener(OPEN_QUICK_SWITCHER_EVENT, openSwitcher) }
  }, [preview])
  if (error) return <MaskedObjectOverlay onClose={() => setError('')}><p role="alert">{error}</p><button onClick={() => setError('')}>关闭</button></MaskedObjectOverlay>
  return surface?.kind === 'switcher' ? <QuickSwitcher onClose={close} onPreview={preview} />
    : surface?.kind === 'preview' ? <QuickLook reference={surface.target} onClose={close} /> : null
}
