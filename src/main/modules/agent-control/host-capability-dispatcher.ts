import type { AIModelConfig, AIProviderDef } from '../../../shared/ai-providers'
import type { ToolContext } from '../tools/tool-executor'
import type { DocumentChatSessionLike } from './document-domain-helpers'
import type { HostShortcutDecision } from './run-capability-controller'
import { logAgentMetric } from './metrics'

interface HostCapabilityDispatcherDeps {
  executeHostTool: (toolName: string, args: Record<string, unknown>, toolContext: ToolContext) => Promise<string>
  tryDeterministicSectionFormatFlow: (params: {
    agentName: string
    userText: string
    toolContext: ToolContext
    onAssistantSummary: (summary: string) => void
  }) => Promise<boolean>
  tryDeterministicSectionRewriteFlow: (params: {
    agentName: string
    session: DocumentChatSessionLike
    config: AIModelConfig
    baseUrl: string
    provider: AIProviderDef | undefined
    signal: AbortSignal
    isKimi: boolean
    isKimiCoding: boolean
    useAnthropicProtocol: boolean
    userText: string
    toolContext: ToolContext
    onAssistantSummary: (summary: string) => void
  }) => Promise<boolean>
}

export interface HostCapabilityDispatchResult {
  handled: boolean
  outputText: string | null
  toolUseText?: string | null
}

export class HostCapabilityDispatcher {
  constructor(private readonly deps: HostCapabilityDispatcherDeps) {}

  async dispatch(params: {
    decision: HostShortcutDecision
    toolContext: ToolContext
    agentName?: string
    userText?: string
    session?: DocumentChatSessionLike
    config?: AIModelConfig
    baseUrl?: string
    provider?: AIProviderDef
    signal?: AbortSignal
    isKimi?: boolean
    isKimiCoding?: boolean
    useAnthropicProtocol?: boolean
    onAssistantSummary?: (summary: string) => void
  }): Promise<HostCapabilityDispatchResult> {
    if (params.decision.kind === 'none') {
      return {
        handled: false,
        outputText: null,
        toolUseText: null,
      }
    }

    if (params.decision.kind === 'openclaw' && params.decision.command) {
      if (params.decision.authorizationSource !== 'explicit_user_command' && params.decision.authorizationSource !== 'ui_action') {
        logAgentMetric('host_shortcut_reject_rate', {
          kind: params.decision.kind,
          reason: params.decision.reason,
          authorizationSource: params.decision.authorizationSource,
        })
        return {
          handled: false,
          outputText: null,
          toolUseText: null,
        }
      }
      const result = await this.deps.executeHostTool(
        'system_run_openclaw',
        { command: params.decision.command },
        {
          ...params.toolContext,
          allowedToolNames: ['system_run_openclaw'],
        },
      )
      return {
        handled: true,
        outputText: result,
        toolUseText: `system_run_openclaw(${JSON.stringify({ command: params.decision.command }).slice(0, 120)})`,
      }
    }

    const onAssistantSummary = params.onAssistantSummary || (() => undefined)

    if (
      params.decision.kind === 'document_format' &&
      params.agentName &&
      params.userText
    ) {
      const handled = await this.deps.tryDeterministicSectionFormatFlow({
        agentName: params.agentName,
        userText: params.userText,
        toolContext: params.toolContext,
        onAssistantSummary,
      })
      return {
        handled,
        outputText: null,
        toolUseText: null,
      }
    }

    if (
      params.decision.kind === 'document_rewrite' &&
      params.agentName &&
      params.session &&
      params.config &&
      params.baseUrl &&
      params.userText &&
      params.signal
    ) {
      const handled = await this.deps.tryDeterministicSectionRewriteFlow({
        agentName: params.agentName,
        session: params.session,
        config: params.config,
        baseUrl: params.baseUrl,
        provider: params.provider,
        signal: params.signal,
        isKimi: params.isKimi ?? false,
        isKimiCoding: params.isKimiCoding ?? false,
        useAnthropicProtocol: params.useAnthropicProtocol ?? false,
        userText: params.userText,
        toolContext: params.toolContext,
        onAssistantSummary,
      })
      return {
        handled,
        outputText: null,
        toolUseText: null,
      }
    }

    return {
      handled: false,
      outputText: null,
      toolUseText: null,
    }
  }
}
