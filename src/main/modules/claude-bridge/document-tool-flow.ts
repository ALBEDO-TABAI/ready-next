export interface DocumentToolCompletionInput {
  forceDocumentTool: boolean
  executedMutatingDocActionCount: number
  executedSaveDocActionCount: number
  lastWidgetValidationError?: string | null
  toolResults: string[]
}

function isQueuedPlaceholder(result: string): boolean {
  return /^Document (navigation|inspection|content mutation|save) queued:/i.test(result.trim())
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
