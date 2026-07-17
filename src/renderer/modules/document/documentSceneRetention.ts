export interface RetainableDocumentSceneTab {
  content: string
}

export interface RetainedDocumentEditorProps<TTab> {
  tab: TTab
  viewMode: 'edit' | 'preview'
  previewEditable?: boolean
  previewFocusWidgetTitle?: string | null
  onVisibleLineChange?: (line: number | null) => void
  onActivate?: () => void
  isFocused?: boolean
  isSceneVisible: boolean
}

const DOCUMENT_WIDGET_FENCE_MARKER = '```show-widget'

export function shouldRetainDocumentSceneWhileHidden(
  tab: RetainableDocumentSceneTab | null | undefined,
): boolean {
  return Boolean(tab?.content.includes(DOCUMENT_WIDGET_FENCE_MARKER))
}

export interface RetainedDocumentScene<TTab extends RetainableDocumentSceneTab> {
  activeTab: TTab | null
  splitTab: TTab | null
  retainActiveEditor: boolean
  retainSplitEditor: boolean
}

export function resolveRetainedDocumentScene<TTab extends RetainableDocumentSceneTab>(input: {
  isSceneVisible: boolean
  wasSceneVisible: boolean
  activeTab: TTab | null
  splitTab: TTab | null
  retained: RetainedDocumentScene<TTab>
}): RetainedDocumentScene<TTab> {
  if (input.isSceneVisible) {
    return {
      activeTab: input.activeTab,
      splitTab: input.splitTab,
      retainActiveEditor: true,
      retainSplitEditor: true,
    }
  }
  if (!input.wasSceneVisible) return input.retained

  const retainActiveEditor = shouldRetainDocumentSceneWhileHidden(input.retained.activeTab)
  const retainSplitEditor = shouldRetainDocumentSceneWhileHidden(input.retained.splitTab)
  if (!retainActiveEditor && !retainSplitEditor) {
    return {
      activeTab: null,
      splitTab: null,
      retainActiveEditor: false,
      retainSplitEditor: false,
    }
  }
  return {
    ...input.retained,
    retainActiveEditor,
    retainSplitEditor,
  }
}

export function areRetainedDocumentEditorPropsEqual<TTab>(
  previous: RetainedDocumentEditorProps<TTab>,
  next: RetainedDocumentEditorProps<TTab>,
): boolean {
  if (!next.isSceneVisible) return true
  return previous.tab === next.tab
    && previous.viewMode === next.viewMode
    && previous.previewEditable === next.previewEditable
    && previous.previewFocusWidgetTitle === next.previewFocusWidgetTitle
    && previous.onVisibleLineChange === next.onVisibleLineChange
    && previous.onActivate === next.onActivate
    && previous.isFocused === next.isFocused
}
