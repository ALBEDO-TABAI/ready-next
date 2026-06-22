import { z } from 'zod'

import type { AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'

export const renameSpecialistAgentSchema = z.object({
  specialist_id: z.string().trim().min(1).max(120),
  display_name: z.string().trim().min(1).max(120),
  user_request_verbatim: z.string().trim().min(1).max(500),
})

export type RenameSpecialistAgentArgs = z.infer<typeof renameSpecialistAgentSchema>

export interface RenameSpecialistAgentDeps {
  registry: {
    updateName(id: string, name: string): AgentRegistryRecord
  }
  currentUserText?: string | null
}

export function executeRenameSpecialistAgent(
  rawArgs: RenameSpecialistAgentArgs,
  deps: RenameSpecialistAgentDeps,
): ToolExecutionOutput {
  const args = renameSpecialistAgentSchema.parse(rawArgs)
  const source = String(deps.currentUserText || '').trim()
  if (!source || !source.includes(args.user_request_verbatim) || !source.includes(args.display_name)) {
    return createToolExecutionOutput('专项 agent 未改名：改名请求必须来自用户当前原话。', {
      shape: 'json',
      data: {
        errorKind: 'rename_verbatim_mismatch',
        toolName: 'rename_specialist_agent',
        specialistId: args.specialist_id,
      },
    })
  }

  const agent = deps.registry.updateName(args.specialist_id, args.display_name)
  return createToolExecutionOutput(`已把专项 agent 改名为：${agent.name}。`, {
    shape: 'json',
    data: {
      specialistId: agent.id,
      displayName: agent.name,
      agent,
    },
  })
}
