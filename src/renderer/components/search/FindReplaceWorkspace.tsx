import { X } from 'lucide-react'
import { useEffect } from 'react'
import GlobalSearchPanel from '../layout/GlobalSearchPanel'
import { beginPersistentBrowserMask, endPersistentBrowserMask } from '../../modules/overlay/browserViewMask'
import './find-replace-workspace.css'

// "Find and replace in the library" as a full-size view over the content (W2-T6). Finding an object is
// ⌘K; this is for searching text across the library and replacing it. It opens from the document
// navigator and ⌘K. (The plan's system tab waits for W6, which generalises system tabs with 今日.)
export default function FindReplaceWorkspace({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    beginPersistentBrowserMask()
    return () => { void endPersistentBrowserMask() }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="find-replace-workspace" data-find-replace-workspace="true">
      <section className="find-replace-workspace__panel rn-float" role="dialog" aria-modal="true" aria-label="在资料库中查找与替换">
        <GlobalSearchPanel>
          {({ header, body }) => (
            <>
              <div className="find-replace-workspace__head">
                <div className="find-replace-workspace__head-slot">{header}</div>
                <button type="button" className="find-replace-workspace__close" onClick={onClose} aria-label="关闭查找与替换">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <div className="find-replace-workspace__body">{body}</div>
            </>
          )}
        </GlobalSearchPanel>
      </section>
    </div>
  )
}
