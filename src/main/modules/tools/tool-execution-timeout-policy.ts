import type { ToolTimeoutProfile } from '../agent-control/tools-runtime/tool-definition'
import { getToolResourceTag } from '../agent-control/tools-runtime/tool-parallelism-policy'
import { IMAGE_GENERATION_REQUEST_TIMEOUT_MS } from '../../../shared/image-generation'

export const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 15_000
export const DOCUMENT_WRITE_TOOL_TIMEOUT_MS = 30_000
export const BROWSER_INTERACTIVE_TOOL_TIMEOUT_MS = 60_000
export const SKILL_TOOL_TIMEOUT_MS = 120_000
export const SKILL_LONG_TOOL_TIMEOUT_MS = 600_000
export const FEISHU_TOOL_TIMEOUT_MS = 30_000
export const IMAGE_GENERATION_TOOL_TIMEOUT_MS = IMAGE_GENERATION_REQUEST_TIMEOUT_MS + 5_000
export const MAP_TOOL_TIMEOUT_MS = 60_000

export function resolveToolExecutionTimeoutMsForProfile(profile: ToolTimeoutProfile): number {
  switch (profile) {
    case 'browser_interactive':
      return BROWSER_INTERACTIVE_TOOL_TIMEOUT_MS
    case 'document_write':
      return DOCUMENT_WRITE_TOOL_TIMEOUT_MS
    case 'skill':
      return SKILL_TOOL_TIMEOUT_MS
    case 'skill_long':
      return SKILL_LONG_TOOL_TIMEOUT_MS
    case 'feishu':
      return FEISHU_TOOL_TIMEOUT_MS
    case 'image_generation':
      return IMAGE_GENERATION_TOOL_TIMEOUT_MS
    case 'map':
      return MAP_TOOL_TIMEOUT_MS
    default:
      return DEFAULT_TOOL_EXECUTION_TIMEOUT_MS
  }
}

export function resolveToolExecutionTimeoutMs(toolName: string): number {
  const tag = getToolResourceTag(toolName)

  if (tag.domain === 'browser') {
    return resolveToolExecutionTimeoutMsForProfile('browser_interactive')
  }
  if (tag.domain === 'document' && tag.accessMode === 'write') {
    return resolveToolExecutionTimeoutMsForProfile('document_write')
  }
  if (tag.domain === 'skill') {
    if (toolName === 'skill_run_shell') {
      return resolveToolExecutionTimeoutMsForProfile('skill_long')
    }
    return resolveToolExecutionTimeoutMsForProfile('skill')
  }
  if (tag.domain === 'feishu') {
    return resolveToolExecutionTimeoutMsForProfile('feishu')
  }
  if (tag.domain === 'image_generation') {
    return resolveToolExecutionTimeoutMsForProfile('image_generation')
  }
  if (tag.domain === 'map') {
    return resolveToolExecutionTimeoutMsForProfile('map')
  }
  return resolveToolExecutionTimeoutMsForProfile('default')
}

export async function withToolExecutionTimeout<T>(
  toolName: string,
  operation: () => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = Math.max(1, options?.timeoutMs ?? resolveToolExecutionTimeoutMs(toolName))

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms (${toolName})`))
    }, timeoutMs)

    void operation()
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}
