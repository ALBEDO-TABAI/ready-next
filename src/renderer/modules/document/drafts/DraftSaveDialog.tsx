import { useEffect } from 'react'
import { closeFloat, openFloat } from '../../../components/ui'
import { useDocTabs } from '../../../stores/useDocTabs'
import { ConnectedSaveToPicker } from '../page-ui/ConnectedSaveToPicker'
import { completeDraftSave, useDraftUI } from './runtime'
import { finalizeDraftTab } from './save'

/**
 * A save requested away from the document topbar (the assistant's 存为页面) shows the same Save To picker as a dialog
 * where the person is, and finalizes the same durable draft. Mounted once for the app.
 */
export function DraftSaveDialogHost() {
  const { saveTabId, saveRequestId, saveParentPath, saveHost } = useDraftUI()
  useEffect(() => {
    if (!saveTabId || !saveRequestId || saveHost !== 'dialog') return
    const title = useDocTabs.getState().tabs.find(tab => tab.id === saveTabId)?.title.replace(/\.md$/i, '') || '新文档'
    // The picker is the dialog (named 保存到…); the float only places it over a dimmed page.
    const id = openFloat({
      anchor: { left: 0, top: 0, right: 0, bottom: 0 }, placement: 'center', modal: true, className: 'rn-dialog rn-save-dialog',
      onClose: () => completeDraftSave(null, saveRequestId),
      render: close => <ConnectedSaveToPicker initialTitle={title} initialParentPath={saveParentPath} onCancel={close}
        onConfirm={async selection => {
          const saved = await finalizeDraftTab(saveTabId, selection)
          completeDraftSave(saved.path, saveRequestId)
          return { ok: true, value: saved }
        }} />,
    })
    return () => closeFloat(id, true)
  }, [saveTabId, saveRequestId, saveParentPath, saveHost])
  return null
}
