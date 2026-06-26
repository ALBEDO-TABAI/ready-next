import { filterBrowserLocalMediaUploadPaths } from '../../../shared/browser-local-media-upload'
import { getDroppedFilesFromDataTransfer } from '../../utils/dragDrop'
import { useMode } from '../../stores/useMode'

interface BrowserLocalMediaDragEvent {
  dataTransfer: DataTransfer
  preventDefault: () => void
}

export function startBrowserLocalMediaNativeFileDrag(event: BrowserLocalMediaDragEvent): boolean {
  const dataTransfer = event.dataTransfer
  const paths = filterBrowserLocalMediaUploadPaths(getDroppedFilesFromDataTransfer(dataTransfer))
  if (paths.length === 0 || typeof window === 'undefined') return false
  const mode = useMode.getState()
  if (mode.workbenchMode !== 'browser' && mode.splitMode !== 'browser') return false
  const startNativeFileDrag = window.electronAPI?.startNativeFileDrag
  if (typeof startNativeFileDrag !== 'function') return false
  event.preventDefault()
  startNativeFileDrag(paths)
  return true
}
