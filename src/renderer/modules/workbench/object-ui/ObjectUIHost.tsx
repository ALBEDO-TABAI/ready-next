import { useCallback, useEffect, useState } from 'react'
import { parseReadyUri } from '../../../../shared/ready-ref'
import { QuickLook } from './QuickLook'
import { QuickSwitcher } from './QuickSwitcher'
import type { PreviewTarget } from './navigation'

/** Mount once in the workbench shell. The shell owns settings navigation. */
export function ObjectUIHost({ onSettings }: { onSettings: () => void }) {
  const [surface, setSurface] = useState<{ kind: 'switcher' } | { kind: 'preview'; target: PreviewTarget } | null>(null)
  const close = useCallback(() => setSurface(null), [])
  const preview = useCallback((target: PreviewTarget) => setSurface({ kind: 'preview', target }), [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.shiftKey) {
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
    window.addEventListener('ready:open-quick-switcher', openSwitcher)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true); window.removeEventListener('ready:open-quick-switcher', openSwitcher) }
  }, [preview])
  return surface?.kind === 'switcher' ? <QuickSwitcher onClose={close} onPreview={preview} onSettings={onSettings} />
    : surface?.kind === 'preview' ? <QuickLook reference={surface.target} onClose={close} /> : null
}
