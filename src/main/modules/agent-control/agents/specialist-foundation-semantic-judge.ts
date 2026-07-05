import type {
  SpecialistAgentBlueprint,
  SpecialistFoundationSemanticIssue,
  SpecialistFoundationSemanticIssueId,
  SpecialistFoundationSemanticReview,
} from '../../../../shared/agent-specialist-blueprint'
import {
  isSpecialistFoundationSemanticIssueId,
} from '../../../../shared/agent-specialist-blueprint'
import {
  hashSpecialistBlueprintReviewContent,
  materializeSpecialistBlueprintForReview,
  type SpecialistBlueprintReviewRegistry,
} from './specialist-blueprint-review-content'

const MAX_ISSUES = 8
const MAX_MESSAGE = 240
const MAX_QUESTIONS = 3
const DEFAULT_TIMEOUT_MS = 8_000

export interface SpecialistFoundationSemanticJudgeInput {
  contentHash: string
  blueprintId: string
  specialistId: string
  displayName: string
  userRequestVerbatim: string
  foundationText: string
  blueprint: SpecialistAgentBlueprint
}

export interface SpecialistFoundationSemanticJudgeRawIssue {
  id: string
  message?: string
  clarificationQuestion?: string
}

export interface SpecialistFoundationSemanticJudgeRawOutput {
  issues?: SpecialistFoundationSemanticJudgeRawIssue[]
}

export interface SpecialistFoundationSemanticReviewDeps {
  registry: SpecialistBlueprintReviewRegistry
  judge?: (
    input: SpecialistFoundationSemanticJudgeInput,
    signal: AbortSignal,
  ) => Promise<SpecialistFoundationSemanticJudgeRawOutput | string | null | undefined>
  unavailableReason?: string
  now?: () => Date
  timeoutMs?: number
}

export interface SpecialistFoundationSemanticReviewResult {
  blueprint: SpecialistAgentBlueprint
  review: SpecialistFoundationSemanticReview
}

export const SPECIALIST_FOUNDATION_SEMANTIC_ISSUE_MESSAGES: Record<SpecialistFoundationSemanticIssueId, string> = {
  scope_too_generic: '职责范围仍然过泛，需要明确长期负责的具体工作边界。',
  role_not_operational: '角色描述还不像可执行的工作角色，需要写清判断口径。',
  main_split_unclear: '主 agent 和专项 agent 的分工仍不清楚。',
  weak_non_goals: '不做事项不足以防止职责膨胀。',
  weak_task_examples: '适合/不适合任务例子不足以支撑路由判断。',
  weak_inputs_outputs: '输入或输出定义不够具体。',
  tool_boundary_underexplained: '工具边界说明不足，无法判断何时需要确认或拒绝。',
  memory_policy_unclear: '长期记忆或用户画像使用策略不清楚。',
  knowledge_lacks_evidence: '知识种子缺少可追溯证据。',
  foundation_echoes_request: '基础文档仍像复述用户原话，而不是专业化定义。',
  lifecycle_unclear: '维护、合并或退休条件不清楚。',
}

function clip(value: unknown, limit: number): string {
  return String(value || '').trim().slice(0, limit)
}

function parseRawOutput(raw: SpecialistFoundationSemanticJudgeRawOutput | string | null | undefined): SpecialistFoundationSemanticJudgeRawOutput | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  if (!trimmed) return null
  return JSON.parse(trimmed) as SpecialistFoundationSemanticJudgeRawOutput
}

function unavailable(contentHash: string, reason: string, now: Date): SpecialistFoundationSemanticReview {
  return {
    status: 'unavailable',
    contentHash,
    reviewedAt: now.toISOString(),
    issues: [],
    unavailableReason: reason,
    source: 'not_available',
  }
}

function normalizeIssue(raw: SpecialistFoundationSemanticJudgeRawIssue): SpecialistFoundationSemanticIssue | null {
  if (!isSpecialistFoundationSemanticIssueId(raw.id)) return null
  return {
    id: raw.id,
    message: clip(raw.message || SPECIALIST_FOUNDATION_SEMANTIC_ISSUE_MESSAGES[raw.id], MAX_MESSAGE)
      || SPECIALIST_FOUNDATION_SEMANTIC_ISSUE_MESSAGES[raw.id],
    ...(raw.clarificationQuestion
      ? { clarificationQuestion: clip(raw.clarificationQuestion, MAX_MESSAGE) }
      : {}),
  }
}

function normalizeRawReview(
  raw: SpecialistFoundationSemanticJudgeRawOutput | string | null | undefined,
  contentHash: string,
  now: Date,
): SpecialistFoundationSemanticReview {
  let parsed: SpecialistFoundationSemanticJudgeRawOutput | null
  try {
    parsed = parseRawOutput(raw)
  } catch {
    // silent-catch: unparseable judge output degrades to the structured invalid_json review
    return unavailable(contentHash, 'invalid_json', now)
  }
  if (!parsed || !Array.isArray(parsed.issues)) {
    return unavailable(contentHash, 'empty_or_malformed_output', now)
  }

  const rawIssues = parsed.issues.slice(0, MAX_ISSUES)
  const issues: SpecialistFoundationSemanticIssue[] = []
  let questionCount = 0
  for (const rawIssue of rawIssues) {
    const issue = normalizeIssue(rawIssue)
    if (!issue) return unavailable(contentHash, 'unknown_issue_id', now)
    if (issue.clarificationQuestion) {
      questionCount += 1
      if (questionCount > MAX_QUESTIONS) delete issue.clarificationQuestion
    }
    issues.push(issue)
  }

  return {
    status: issues.length > 0 ? 'blocked' : 'passed',
    contentHash,
    reviewedAt: now.toISOString(),
    issues,
    source: 'semantic_judge',
  }
}

function timeoutPromise(ms: number, controller: AbortController): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error('semantic judge timeout'))
    }, ms)
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })
}

export async function runSpecialistFoundationSemanticReview(
  blueprint: SpecialistAgentBlueprint,
  deps: SpecialistFoundationSemanticReviewDeps,
): Promise<SpecialistFoundationSemanticReviewResult> {
  const now = deps.now?.() ?? new Date()
  const canonical = materializeSpecialistBlueprintForReview(deps.registry, blueprint)
  const contentHash = hashSpecialistBlueprintReviewContent(canonical)

  if (!deps.judge) {
    return { blueprint: canonical, review: unavailable(contentHash, deps.unavailableReason || 'judge_unavailable', now) }
  }

  const controller = new AbortController()
  const input: SpecialistFoundationSemanticJudgeInput = {
    contentHash,
    blueprintId: canonical.blueprintId,
    specialistId: canonical.specialistId,
    displayName: canonical.displayName,
    userRequestVerbatim: canonical.userRequestVerbatim || canonical.provenance.userRequestVerbatim,
    foundationText: canonical.foundationDocs.foundationText,
    blueprint: canonical,
  }

  try {
    const raw = await Promise.race([
      deps.judge(input, controller.signal),
      timeoutPromise(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, controller),
    ])
    controller.abort()
    return {
      blueprint: canonical,
      review: normalizeRawReview(raw, contentHash, now),
    }
  } catch (error) {
    // silent-catch: judge failure degrades to the structured unavailable review carrying the reason
    controller.abort()
    return {
      blueprint: canonical,
      review: unavailable(contentHash, error instanceof Error ? error.message : 'judge_failed', now),
    }
  }
}
