import type { ToolContext } from '../../tools/tool-executor'
import type { HostShortcutDecision } from './run-capability-controller'
import { logAgentMetric } from '../metrics'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'

interface HostCapabilityDispatcherDeps {
  executeHostTool: (toolName: string, args: Record<string, unknown>, toolContext: ToolContext) => Promise<ToolExecutionOutput>
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
        outputText: result.text,
        toolUseText: `system_run_openclaw(${JSON.stringify({ command: params.decision.command }).slice(0, 120)})`,
      }
    }

    return {
      handled: false,
      outputText: null,
      toolUseText: null,
    }
  }
}
