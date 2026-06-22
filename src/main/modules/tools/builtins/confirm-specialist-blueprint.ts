import { z } from 'zod'

import {
  confirmAndCreateSpecialistBlueprint,
  type SpecialistBlueprintConfirmCreateDeps,
} from '../../agent-control/agents/specialist-blueprint-confirm-create'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'

const INTENT_CONFIRM_RE = /(确认|创建|采用|激活|同意|可以|继续|create|confirm|approve)/i
const INTENT_REJECT_RE = /(不创建|取消|拒绝|先别|不要|reject|cancel)/i

export const confirmSpecialistBlueprintSchema = z.object({
  action: z.enum(['confirm_create', 'reject']),
  blueprint_id: z.string().trim().min(1).max(160),
  confirmation_source: z.enum(['direct_user_message', 'ask_user_questions_card']),
  user_confirmation_verbatim: z.string().trim().min(1).max(500),
  confirmation_card_id: z.string().trim().min(1).max(120).optional(),
  allow_unverified_semantic_review: z.boolean().optional(),
  migrate_card_rel_paths: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
})

export type ConfirmSpecialistBlueprintArgs = z.infer<typeof confirmSpecialistBlueprintSchema>

export interface ConfirmSpecialistBlueprintDeps extends SpecialistBlueprintConfirmCreateDeps {
  sessionId?: string | null
  runId?: string | null
  currentUserText?: string | null
}

function validateConfirmationSource(args: ConfirmSpecialistBlueprintArgs, deps: ConfirmSpecialistBlueprintDeps):
  | { ok: true }
  | { ok: false; reason: string } {
  const source = String(deps.currentUserText || '').trim()
  const verbatim = String(args.user_confirmation_verbatim || '').trim()
  if (args.confirmation_source === 'ask_user_questions_card' && !args.confirmation_card_id) {
    return { ok: false, reason: 'confirmation_card_id_required' }
  }
  if (!source || !verbatim || !source.includes(verbatim)) {
    return { ok: false, reason: 'confirmation_verbatim_mismatch' }
  }
  const hasRejectIntent = INTENT_REJECT_RE.test(verbatim)
  const hasConfirmIntent = INTENT_CONFIRM_RE.test(verbatim)
  if (args.action === 'confirm_create' && (hasRejectIntent || !hasConfirmIntent)) {
    return { ok: false, reason: 'confirmation_intent_missing' }
  }
  if (args.action === 'reject' && !hasRejectIntent) {
    return { ok: false, reason: 'rejection_intent_missing' }
  }
  return { ok: true }
}

function acceptsUnverifiedSemanticReview(args: ConfirmSpecialistBlueprintArgs): boolean {
  if (!args.allow_unverified_semantic_review) return true
  const verbatim = String(args.user_confirmation_verbatim || '')
  return /(未校验|没有完成.*校验|语义校验.*不可用|接受.*未校验|确认.*未校验)/.test(verbatim)
}

export async function executeConfirmSpecialistBlueprint(
  rawArgs: ConfirmSpecialistBlueprintArgs,
  deps: ConfirmSpecialistBlueprintDeps,
): Promise<ToolExecutionOutput> {
  const args = confirmSpecialistBlueprintSchema.parse(rawArgs)
  const source = validateConfirmationSource(args, deps)
  if (!source.ok) {
    return createToolExecutionOutput('专项 agent 创建未执行：需要用户在当前对话里明确确认或拒绝。', {
      shape: 'json',
      data: {
        errorKind: source.reason,
        toolName: 'confirm_specialist_blueprint',
        blueprintId: args.blueprint_id,
      },
    })
  }

  if (args.action === 'reject') {
    const blueprint = deps.getBlueprintStore().patch(args.blueprint_id, { status: 'rejected' })
    return createToolExecutionOutput('已拒绝这份专项 agent 蓝图，未创建 agent。', {
      shape: 'json',
      data: {
        action: 'reject',
        blueprint,
        blueprintId: blueprint.blueprintId,
        createdAgent: false,
      },
    })
  }

  if (!acceptsUnverifiedSemanticReview(args)) {
    return createToolExecutionOutput('专项 agent 创建未执行：需要用户明确接受 FOUNDATION 尚未完成语义校验。', {
      shape: 'json',
      data: {
        errorKind: 'unverified_semantic_review_confirmation_missing',
        toolName: 'confirm_specialist_blueprint',
        blueprintId: args.blueprint_id,
      },
    })
  }

  const result = await confirmAndCreateSpecialistBlueprint(deps, {
    blueprintId: args.blueprint_id,
    sessionId: deps.sessionId || 'conversation',
    runId: deps.runId ?? null,
    allowUnverifiedSemanticReview: args.allow_unverified_semantic_review,
    migrateCardRelPaths: args.migrate_card_rel_paths || [],
  })

  return createToolExecutionOutput(`已创建专项 agent：${result.result.agent.name}。`, {
    shape: 'json',
    data: {
      action: 'confirm_create',
      blueprint: result.blueprint,
      blueprintId: result.blueprint.blueprintId,
      createdAgent: true,
      agentId: result.result.agent.id,
      agentName: result.result.agent.name,
      routingActivated: false,
      routingStatus: 'staged',
    },
  })
}
