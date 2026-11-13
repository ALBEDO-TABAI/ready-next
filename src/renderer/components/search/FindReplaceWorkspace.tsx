import { X } from 'lucide-react'
import { useEffect } from 'react'
import GlobalSearchPanel from '../layout/GlobalSearchPanel'
import { IconButton } from '../ui'
import { beginPersistentBrowserMask, endPersistentBrowserMask } from '../../modules/overlay/browserViewMask'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
} from '../../modules/workbench/chrome'
import './find-replace-workspace.css'

// The box of the mode panel it stands in for (V19): the same inset a mode root gives its canvas shell.
const PANEL_INSET = `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`

// "Find and replace in the library" as a full-size view over the content (W2-T6). Finding an object is
// ⌘K; this is for searching text across the library and replacing it. It opens from the document
// navigator and ⌘K. (The plan's system tab waits for W6, which generalises system tabs with 今日.)
// While open it is the mode's panel (V19): the same box and the panel material, no float or drop shadow.
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
    <div className="find-replace-workspace" data-find-replace-workspace="true" style={{ inset: PANEL_INSET }}>
      <section className="find-replace-workspace__panel rn-panel" role="dialog" aria-modal="true" aria-label="在资料库中查找与替换">
        <GlobalSearchPanel>
          {({ header, body }) => (
            <>
              <div className="find-replace-workspace__head rn-panel__head">
                <div className="find-replace-workspace__head-slot">{header}</div>
                <IconButton icon={<X />} title="关闭查找与替换" onClick={onClose} />
              </div>
              <div className="find-replace-workspace__body rn-panel__body">{body}</div>
            </>
          )}
        </GlobalSearchPanel>
      </section>
    </div>
  )
}
