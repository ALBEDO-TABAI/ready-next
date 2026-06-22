import { z } from 'zod'

import type { AgentRegistryRecord } from '../../repositories/agent-registry-repository'
import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintAdmissionVerdict,
  SpecialistBlueprintKnowledgeSeed,
  SpecialistBlueprintSourceMessageUnavailableReason,
  SpecialistBlueprintStatus,
  SpecialistBlueprintToolBoundaries,
} from '../../../../shared/agent-specialist-blueprint'
import {
  buildSpecialistBlueprintClarificationContract,
  buildSpecialistBlueprintProfessionalInterviewContract,
  renderSpecialistBlueprintClarificationInstruction,
  renderSpecialistBlueprintProfessionalInterviewInstruction,
  type SpecialistBlueprintClarificationContract,
  type SpecialistBlueprintProfessionalInterviewContract,
} from '../../../../shared/agent-specialist-blueprint-clarification'
import { renderSpecialistFoundationMarkdown } from '../../agent-control/agents/specialist-blueprint-quality'
import { materializeSpecialistBlueprintForReview } from '../../agent-control/agents/specialist-blueprint-review-content'
import {
  runSpecialistFoundationSemanticReview,
  type SpecialistFoundationSemanticReviewDeps,
} from '../../agent-control/agents/specialist-foundation-semantic-judge'
import {
  SPECIALIST_BLUEPRINT_ERROR_KINDS,
  type SpecialistBlueprintErrorKind,
} from '../../agent-control/contracts/error-kinds'
import type { SpecialistBlueprintStore } from '../../agent-control/agents/specialist-blueprint-store'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'

const STRING_LIST_LIMIT = 8
const STRING_LIST = z.preprocess(
  (value) => Array.isArray(value) ? value.slice(0, STRING_LIST_LIMIT) : value,
  z.array(z.string().trim().min(1).max(200)).max(STRING_LIST_LIMIT),
)

const KNOWLEDGE_SEED_SCHEMA = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  evidence_refs: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
})

const TOOL_BOUNDARY_SCHEMA = z.object({
  mode: z.enum(['allow', 'deny', 'confirm']),
  notes: z.string().trim().min(1).max(800),
})

export const proposeSpecialistBlueprintSchema = z.object({
  specialist_id: z.string().trim().min(1).max(80)
    .describe('Lowercase slug for the proposed specialist agent, for example visual-researcher.'),
  display_name: z.string().trim().min(1).max(120),
  charter: z.string().trim().min(1).max(2000)
    .describe('The specialist scope and responsibility, specific enough to judge fit.'),
  intended_domain: z.string().trim().min(1).max(160),
  role_persona: z.string().trim().min(1).max(1600)
    .describe('Role, persona, judgment style, and working posture for this specialist.'),
  non_goals: STRING_LIST.describe('Explicit exclusions; prevents a broad all-purpose agent.'),
  recurring_tasks: STRING_LIST.describe('Recurring work this specialist is expected to handle.'),
  required_inputs: STRING_LIST.describe('Inputs the specialist needs from the user or context.'),
  expected_outputs: STRING_LIST.describe('Concrete outputs the specialist should return.'),
  suitable_task_examples: STRING_LIST.describe('Examples of tasks that should go to this specialist.'),
  unsuitable_task_examples: STRING_LIST.describe('Examples of tasks that should stay with the main agent or another specialist.'),
  main_vs_specialist_split: z.string().trim().min(1).max(1600),
  routing_triggers: STRING_LIST.describe('Up to 8 literal trigger phrases; they stay inactive until user confirmation.'),
  seed_rules_text: z.string().trim().min(1).max(4000),
  knowledge_seeds: z.array(KNOWLEDGE_SEED_SCHEMA).max(8).optional(),
  tool_boundaries: z.object({
    browser: TOOL_BOUNDARY_SCHEMA,
    write: TOOL_BOUNDARY_SCHEMA,
    external_send: TOOL_BOUNDARY_SCHEMA,
    long_memory: TOOL_BOUNDARY_SCHEMA,
  }),
  tool_safety_notes: z.string().trim().min(1).max(2000),
  memory_profile_policy: z.string().trim().min(1).max(1600),
  lifecycle_notes: z.string().trim().min(1).max(1600),
  user_request_verbatim: z.string().trim().min(1).max(2000)
    .describe('Exact user wording copied from the message. Do not summarize or rewrite.'),
})

export type ProposeSpecialistBlueprintArgs = z.infer<typeof proposeSpecialistBlueprintSchema>

export interface ProposeSpecialistBlueprintDeps {
  blueprintStore: SpecialistBlueprintStore
  registry: {
    get(id: string): AgentRegistryRecord | null
    list?(): AgentRegistryRecord[]
  }
  sessionId?: string | null
  runId?: string | null
  sourceMessageId?: string | null
  sourceMessageUnavailableReason?: SpecialistBlueprintSourceMessageUnavailableReason | null
  currentUserText?: string | null
  runSemanticFoundationJudge?: SpecialistFoundationSemanticReviewDeps['judge']
  semanticFoundationJudgeUnavailableReason?: string
  semanticFoundationJudgeTimeoutMs?: number
  now?: () => Date
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
}

function toKnowledgeSeeds(value: ProposeSpecialistBlueprintArgs['knowledge_seeds']): SpecialistBlueprintKnowledgeSeed[] {
  return (value || []).map((seed) => ({
    title: seed.title,
    body: seed.body,
    evidenceRefs: seed.evidence_refs ? [...seed.evidence_refs] : [],
  }))
}

function toToolBoundaries(value: ProposeSpecialistBlueprintArgs['tool_boundaries']): SpecialistBlueprintToolBoundaries {
  return {
    browser: { mode: value.browser.mode, notes: value.browser.notes },
    write: { mode: value.write.mode, notes: value.write.notes },
    externalSend: { mode: value.external_send.mode, notes: value.external_send.notes },
    longMemory: { mode: value.long_memory.mode, notes: value.long_memory.notes },
  }
}

function statusForVerdict(verdict: SpecialistBlueprintAdmissionVerdict): SpecialistBlueprintStatus {
  if (verdict.kind === 'admit') return 'staged'
  if (verdict.kind === 'clarify') return 'needs_clarification'
  return 'rejected'
}

type ProposeSpecialistClarification =
  | SpecialistBlueprintClarificationContract
  | SpecialistBlueprintProfessionalInterviewContract

const PROFESSIONAL_INTERVIEW_GAPS = new Set([
  'charter',
  'rolePersona',
  'nonGoals',
  'recurringTasks',
  'requiredInputs',
  'expectedOutputs',
  'taskExamples',
  'mainVsSpecialistSplit',
  'knowledgeSeeds',
  'toolBoundaries',
  'memoryProfilePolicy',
  'professionalSpecificity',
  'foundation_echoes_request',
])

function shouldUseProfessionalInterview(
  args: ProposeSpecialistBlueprintArgs,
  verdict: SpecialistBlueprintAdmissionVerdict,
): boolean {
  if (verdict.kind !== 'clarify') return false
  const broadGapCount = verdict.missing.filter((field) => PROFESSIONAL_INTERVIEW_GAPS.has(field)).length
  if (broadGapCount < 3) return false
  const request = args.user_request_verbatim
  return /(专项\s*agent|专门\s*agent|专项\s*智能体|agent|智能体)/i.test(request)
}

function isProfessionalInterviewContract(
  contract: ProposeSpecialistClarification,
): contract is SpecialistBlueprintProfessionalInterviewContract {
  return 'contractKind' in contract && contract.contractKind === 'professional_interview'
}

function buildBlueprint(
  args: ProposeSpecialistBlueprintArgs,
  deps: ProposeSpecialistBlueprintDeps,
): SpecialistAgentBlueprint {
  const slug = normalizeSlug(args.specialist_id)
  const createdAt = (deps.now ? deps.now() : new Date()).toISOString()
  const knowledgeSeeds = toKnowledgeSeeds(args.knowledge_seeds)
  const toolBoundaries = toToolBoundaries(args.tool_boundaries)
  const blueprint: SpecialistAgentBlueprint = {
    blueprintId: `bp-${slug || 'needs-slug'}`,
    status: 'draft',
    inferredScope: {
      slug,
      displayName: args.display_name,
      domain: args.intended_domain,
      routingTriggers: [...args.routing_triggers],
    },
    foundationDocs: {
      status: 'staged',
      charter: args.charter,
      rulesText: args.seed_rules_text,
      knowledgeSeeds,
      toolSafetyNotes: args.tool_safety_notes,
      foundationText: '',
    },
    provenance: {
      userRequestVerbatim: args.user_request_verbatim,
      sourceSessionId: deps.sessionId || null,
      sourceRunId: deps.runId || null,
      sourceMessageId: deps.sourceMessageId || null,
      sourceMessageUnavailableReason: deps.sourceMessageId
        ? null
        : deps.sourceMessageUnavailableReason || 'message_id_unavailable',
      createdAt,
    },
    confirmation: {
      tokenId: null,
      confirmedAt: null,
      usedAt: null,
    },
    rolePersona: args.role_persona,
    taskExamples: {
      suitable: [...args.suitable_task_examples],
      unsuitable: [...args.unsuitable_task_examples],
    },
    mainVsSpecialistSplit: args.main_vs_specialist_split,
    toolBoundaries,
    memoryProfilePolicy: args.memory_profile_policy,
    lifecycleNotes: args.lifecycle_notes,
    specialistId: slug,
    displayName: args.display_name,
    charter: args.charter,
    intendedDomain: args.intended_domain,
    nonGoals: [...args.non_goals],
    recurringTasks: [...args.recurring_tasks],
    requiredInputs: [...args.required_inputs],
    expectedOutputs: [...args.expected_outputs],
    routingTriggers: [...args.routing_triggers],
    routingActivateOnCreate: false,
    seedRulesText: args.seed_rules_text,
    knowledgeSeeds,
    migrationCandidates: [],
    toolSafetyNotes: args.tool_safety_notes,
    source: 'conversation',
    userRequestVerbatim: args.user_request_verbatim,
    clarificationAnswers: [],
    admissionVerdict: { kind: 'clarify', missing: ['admission_not_run'] },
    qualityChecks: [],
  }
  blueprint.foundationDocs.foundationText = renderSpecialistFoundationMarkdown(blueprint)
  return blueprint
}

function validateVerbatimSource(args: ProposeSpecialistBlueprintArgs, currentUserText?: string | null):
  | { ok: true }
  | { ok: false; errorKind: SpecialistBlueprintErrorKind } {
  const source = String(currentUserText || '').trim()
  if (!source) return { ok: false, errorKind: SPECIALIST_BLUEPRINT_ERROR_KINDS.verbatimSourceUnavailable.code }
  if (!source.includes(args.user_request_verbatim)) {
    return { ok: false, errorKind: SPECIALIST_BLUEPRINT_ERROR_KINDS.verbatimMismatch.code }
  }
  return { ok: true }
}

function resultText(
  status: SpecialistBlueprintStatus,
  verdict: SpecialistBlueprintAdmissionVerdict,
  clarification: ProposeSpecialistClarification | null,
): string {
  if (status === 'staged') {
    return '已草拟专项 agent 蓝图，并放入 Agent System Studio 等待用户确认。'
  }
  if (status === 'needs_clarification') {
    if (clarification) {
      if (isProfessionalInterviewContract(clarification)) {
        return renderSpecialistBlueprintProfessionalInterviewInstruction(clarification)
      }
      return renderSpecialistBlueprintClarificationInstruction(clarification)
    }
    return `专项 agent 蓝图还缺少关键信息：${verdict.kind === 'clarify' ? verdict.missing.join(', ') : 'unknown'}。`
  }
  return `专项 agent 蓝图未进入待确认：${verdict.kind}。`
}

export async function executeProposeSpecialistBlueprint(
  rawArgs: ProposeSpecialistBlueprintArgs,
  deps: ProposeSpecialistBlueprintDeps,
): Promise<ToolExecutionOutput> {
  const args = proposeSpecialistBlueprintSchema.parse(rawArgs)
  const verbatim = validateVerbatimSource(args, deps.currentUserText)
  if (!verbatim.ok) {
    return createToolExecutionOutput('专项 agent 蓝图未保存：user_request_verbatim 必须来自用户原话。', {
      shape: 'json',
      data: {
        errorKind: verbatim.errorKind,
        toolName: 'propose_specialist_blueprint',
      },
    })
  }

  const draft = buildBlueprint(args, deps)
  const current = deps.blueprintStore.get(draft.blueprintId)
  if (current?.status === 'confirmed') {
    return createToolExecutionOutput('专项 agent 蓝图未保存：已确认的蓝图不能被对话工具覆盖。', {
      shape: 'json',
      data: {
        errorKind: SPECIALIST_BLUEPRINT_ERROR_KINDS.confirmedBlueprintImmutable.code,
        blueprintId: draft.blueprintId,
      },
    })
  }

  const canonical = materializeSpecialistBlueprintForReview(deps.registry, draft)
  let status = statusForVerdict(canonical.admissionVerdict)
  let verdict = canonical.admissionVerdict
  let blueprintInput = canonical
  if (canonical.admissionVerdict.kind === 'admit') {
    const review = await runSpecialistFoundationSemanticReview(canonical, {
      registry: deps.registry,
      judge: deps.runSemanticFoundationJudge,
      unavailableReason: deps.semanticFoundationJudgeUnavailableReason,
      timeoutMs: deps.semanticFoundationJudgeTimeoutMs,
      now: deps.now,
    })
    blueprintInput = {
      ...review.blueprint,
      semanticReview: review.review,
    }
    if (review.review.status === 'blocked') {
      status = 'needs_clarification'
      verdict = {
        kind: 'clarify',
        missing: review.review.issues.map((issue) => issue.id),
      }
    }
  }
  const blueprint = deps.blueprintStore.upsert({
    ...blueprintInput,
    status,
    admissionVerdict: verdict,
  })
  const clarification = status === 'needs_clarification' && verdict.kind === 'clarify'
    ? shouldUseProfessionalInterview(args, verdict)
      ? buildSpecialistBlueprintProfessionalInterviewContract({ userRequestVerbatim: args.user_request_verbatim })
      : buildSpecialistBlueprintClarificationContract(blueprint, verdict.missing)
    : null

  return createToolExecutionOutput(resultText(status, verdict, clarification), {
    shape: 'json',
    data: {
      blueprint,
      blueprintId: blueprint.blueprintId,
      specialistId: blueprint.specialistId,
      status,
      verdict,
      missing: verdict.kind === 'clarify' ? verdict.missing : [],
      createdAgent: false,
      routingActivated: false,
      ...(clarification ? { clarification } : {}),
    },
    interactionHint: status === 'needs_clarification' ? 'awaiting_clarification' : null,
  })
}
