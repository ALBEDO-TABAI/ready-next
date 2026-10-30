import type { CanvasCompositionAPI } from '../../../../shared/document-drafts'
import type { DocumentPreviewSource } from '../../../components/canvas/cards'

export function canvasDocumentPreview(api: CanvasCompositionAPI, objectId: string): DocumentPreviewSource {
  return {
    async read(node) {
      const result = await api.preview({ objectId, nodeId: node.id })
      if (!result.ok) throw new Error(result.message)
      return result.value
    },
    subscribe(changed) {
      const api = window.electronAPI
      const stopIndex = api.document.onIndexChanged(changed)
      const stopMove = api.objects.onMoved(changed)
      const stopPages = api.documentPages.onChanged(changed)
      return () => { stopIndex(); stopMove(); stopPages() }
    },
  }
}
