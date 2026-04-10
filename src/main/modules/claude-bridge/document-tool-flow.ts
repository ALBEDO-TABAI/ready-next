export interface DocumentToolCompletionInput {
  forceDocumentTool: boolean
  executedMutatingDocActionCount: number
  executedSaveDocActionCount: number
  lastWidgetValidationError?: string | null
  toolResults: string[]
}

export interface DocumentToolProgressState {
  executedMutatingDocActionCount: number
  executedSaveDocActionCount: number
  toolResults: string[]
}

export interface DocumentToolInspection {
  isDocumentTool: boolean
  executedDocActionCount: number
  executedMutatingDocActionCount: number
  executedInspectionDocActionCount: number
  executedSaveDocActionCount: number
  clearInspectionResult: boolean
  inspectionResult: string | null
  widgetValidationError: string | null
}

const CONTENT_MUTATING_DOCUMENT_TOOL_NAMES = new Set([
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
])

const DOCUMENT_INSPECTION_TOOL_NAMES = new Set([
  'document_list_widgets',
])

function isQueuedPlaceholder(result: string): boolean {
  return /^Document (navigation|inspection|content mutation|save) queued:/i.test(result.trim())
}

export function shouldPreferDocumentInspectionResult(
  responseText: string | undefined,
  inspectionResult: string | null,
): boolean {
  if (!inspectionResult) return false
  const trimmed = (responseText || '').trim()
  if (!trimmed) return true
  if (trimmed.includes(inspectionResult)) return false
  return [
    /调用了\s*`?document_list_widgets`?/i,
    /这是一个查询操作/i,
    /任务已完成/i,
    /如果用户需要我执行其他文档修改操作/i,
  ].some((pattern) => pattern.test(trimmed))
}

export function inspectDocumentToolCall(
  toolName: string,
  result: string,
): DocumentToolInspection {
  const isDocumentTool = toolName.startsWith('document_')
  const executedMutatingDocActionCount = CONTENT_MUTATING_DOCUMENT_TOOL_NAMES.has(toolName) ? 1 : 0
  const executedInspectionDocActionCount = DOCUMENT_INSPECTION_TOOL_NAMES.has(toolName) ? 1 : 0
  return {
    isDocumentTool,
    executedDocActionCount: isDocumentTool ? 1 : 0,
    executedMutatingDocActionCount,
    executedInspectionDocActionCount,
    executedSaveDocActionCount: toolName === 'document_save_tab' ? 1 : 0,
    clearInspectionResult: executedMutatingDocActionCount > 0,
    inspectionResult: executedInspectionDocActionCount > 0 ? result : null,
    widgetValidationError:
      executedMutatingDocActionCount > 0 && /widget (写入已拒绝|更新失败|删除失败)/.test(result)
        ? result
        : null,
  }
}

export function accumulateDocumentToolProgress(
  previous: DocumentToolProgressState | null | undefined,
  next: Pick<DocumentToolProgressState, 'executedMutatingDocActionCount' | 'executedSaveDocActionCount' | 'toolResults'>,
): DocumentToolProgressState {
  return {
    executedMutatingDocActionCount: (previous?.executedMutatingDocActionCount || 0) + next.executedMutatingDocActionCount,
    executedSaveDocActionCount: (previous?.executedSaveDocActionCount || 0) + next.executedSaveDocActionCount,
    toolResults: [...(previous?.toolResults || []), ...next.toolResults],
  }
}

export function buildDocumentToolCompletionText(input: DocumentToolCompletionInput): string | null {
  if (!input.forceDocumentTool) return null
  if (input.lastWidgetValidationError) return null
  if (input.executedMutatingDocActionCount <= 0 || input.executedSaveDocActionCount <= 0) return null

  const meaningfulResults = input.toolResults
    .map((result) => result.trim())
    .filter((result) => result.length > 0 && !isQueuedPlaceholder(result))

  if (meaningfulResults.length === 0) return null

  return Array.from(new Set(meaningfulResults)).join('\n')
}
