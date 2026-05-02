import { TOOL_ERROR_METRICS } from './tool-error-metrics'

export type HookName = 'pre_tool_use' | 'post_tool_use' | 'user_prompt_submit' | 'stop'

export interface UserPromptSubmitPayload {
  userText: string
  sessionId: string | null
  timestamp: number
}

export interface PreToolUsePayload {
  toolName: string
  input: Record<string, unknown>
}

export interface PostToolUsePayload {
  toolName: string
  result: unknown
  success: boolean
}

export interface StopPayload {
  reason: string
}

export type HookPayloadFor<H extends HookName> =
  H extends 'user_prompt_submit' ? UserPromptSubmitPayload :
    H extends 'pre_tool_use' ? PreToolUsePayload :
      H extends 'post_tool_use' ? PostToolUsePayload :
        H extends 'stop' ? StopPayload :
          never

export interface HookHandler<P> {
  readonly name: string
  readonly fn: (payload: P) => Promise<void> | void
  readonly timeoutMs?: number
}

export interface HookRegistry {
  register<H extends HookName>(name: H, handler: HookHandler<HookPayloadFor<H>>): () => void
  fire<H extends HookName>(name: H, payload: HookPayloadFor<H>): Promise<void>
}

export const HOOK_REGISTRY_METRICS = {
  hookHandlerFailed: TOOL_ERROR_METRICS.hookHandlerFailed,
  hookHandlerTimeout: TOOL_ERROR_METRICS.hookHandlerTimeout,
} as const

export type HookRegistryMetricName =
  typeof HOOK_REGISTRY_METRICS[keyof typeof HOOK_REGISTRY_METRICS]

export interface HookRegistryOptions {
  readonly emitMetric?: (
    name: HookRegistryMetricName,
    payload: Record<string, unknown>,
  ) => void
}

const DEFAULT_HANDLER_TIMEOUT_MS = 5_000

interface HookEntry<H extends HookName> {
  readonly name: H
  readonly handler: HookHandler<HookPayloadFor<H>>
}

export function createHookRegistry(options: HookRegistryOptions = {}): HookRegistry {
  const entries: HookEntry<HookName>[] = []

  return {
    register(name, handler) {
      const entry: HookEntry<typeof name> = { name, handler }
      entries.push(entry as HookEntry<HookName>)

      return () => {
        const index = entries.indexOf(entry as HookEntry<HookName>)
        if (index >= 0) {
          entries.splice(index, 1)
        }
      }
    },

    async fire(name, payload) {
      const matchingEntries = entries.filter((entry) => entry.name === name)
      for (const entry of matchingEntries) {
        await fireHandler(name, entry.handler as HookHandler<typeof payload>, payload, options)
      }
    },
  }
}

async function fireHandler<P>(
  hookName: HookName,
  handler: HookHandler<P>,
  payload: P,
  options: HookRegistryOptions,
): Promise<void> {
  const timeoutMs = handler.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  try {
    const handlerPromise = Promise.resolve(handler.fn(payload))
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    const result = await Promise.race([handlerPromise, timeoutPromise])
    if (result === 'timeout') {
      options.emitMetric?.(HOOK_REGISTRY_METRICS.hookHandlerTimeout, {
        hookName,
        handlerName: handler.name,
        timeoutMs,
      })
      handlerPromise.catch(() => undefined)
    }
  } catch (error) {
    options.emitMetric?.(HOOK_REGISTRY_METRICS.hookHandlerFailed, {
      hookName,
      handlerName: handler.name,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}
