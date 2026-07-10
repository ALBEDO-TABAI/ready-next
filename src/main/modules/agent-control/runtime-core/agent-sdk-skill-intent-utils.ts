import { existsSync } from 'fs'
import { join } from 'path'
import {
  classifyFollowupIntent,
  followupConsultsRecalledContext,
  hasContinuableTaskRef,
  type FollowupTaskRef
} from '../../../../shared/agent-followup-intent'
import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import {
  resolveBrowserBatchCollectionIntent,
  resolveBrowserCollectionIntent
} from '../../../../shared/browser-collection-intent'
import {
  isBrowserTransactionIntent,
  resolveBrowserWorkflowIntent
} from '../../../../shared/browser-workflow-intent'
import {
  hasExplicitDocumentWidgetCreateIntent,
  inferDocumentWidgetTaskKind
} from '../../claude-bridge/tool-policy-heuristics'
import { PRIMITIVE_TOOL_DEFS } from '../../tools/skill-primitives/tool-defs'
import {} from '../compaction/compact-agent-input'
import { buildRequestEnvelope } from '../contracts/request-envelope'
import type { RunMessage } from '../contracts/run-contracts'
import { resolveIntentCapabilityGroupModes } from '../execution-intent-resolver'
import { classifyIntent } from '../intent-classifier'
import {
  applyMapSemanticIntentToIntentClassification,
  classifyMapSemanticIntentFallback
} from '../map-semantic-intent'
import { shouldDisplayReferenceSkillHintForLatestUserText } from '../reference-skill-hint-display'
import { peekLastReferenceSkill } from '../skills/skill-reference-hints'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type {
  AgentSdkBudgetCheckpointRestore,
  SkillContextOrchestratorLike
} from './agent-sdk-types'

import {
  messageToText,
  parseEnvelopeResourceReferences,
  primaryInstructionText,
  SDK_CONTEXT_MARKERS
} from './agent-sdk-input-context-utils'
import { asRecord, stringField } from './agent-sdk-model-message-utils'

// ── Group E: Skill context & intent helpers (lines 964-1359) ──

export function explicitReferenceSkillHasScripts(
  skill: { managedPath?: string } | null,
  typedActions: ReadonlyArray<string>
): boolean {
  if (!skill || typedActions.length > 0) return false
  const managedPath = typeof skill.managedPath === 'string' ? skill.managedPath : ''
  if (!managedPath) return false
  try {
    return existsSync(join(managedPath, 'scripts'))
  } catch {
    // silent-catch: an unreadable skill root cannot prove script availability.
    return false
  }
}

export function skillContextMessagesToInstruction(
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
): string {
  const sections = messages
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content
            .map((item) => {
              if (typeof item.text === 'string') return item.text
              return JSON.stringify(item)
            })
            .join('\n')
        : message.content
      const text = String(content || '').trim()
      if (!text) return ''
      return `【skill context / ${message.role || 'system'}】\n${text}`
    })
    .filter(Boolean)
  return sections.join('\n\n')
}

export function allowedPrimitiveToolsForSdkSkillTurn(
  options: {
    allowRunShell?: boolean
    allowAskUser?: boolean
  } = {}
): string[] {
  const safeSkillPrimitives = new Set([
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_export_artifact',
    'skill_inspect_run_state'
  ])
  if (options.allowAskUser !== false) {
    safeSkillPrimitives.add('skill_ask_user')
  }
  if (options.allowRunShell) {
    safeSkillPrimitives.add('skill_run_shell')
  }
  return PRIMITIVE_TOOL_DEFS.map((definition) => definition.name).filter((name) =>
    safeSkillPrimitives.has(name)
  )
}

export function shouldSuppressSkillAskUserForArtifactDelivery(textCandidates: string[]): boolean {
  const joined = textCandidates.join('\n')
  if (
    !/(?:输出到|保存到|写入|写到|导出到|存到|落到|文件名|(?:相同|同一|当前|这个|该)?目录下|文件夹下|output\s+to|save\s+to|write\s+to|export\s+to|same\s+(?:dir|directory|folder))/i.test(
      joined
    )
  ) {
    return false
  }
  if (
    /(?:不要|不用|无需|不必|别|禁止).{0,8}(?:追问|问我|询问|提问|澄清|确认)|(?:直接|立刻|马上).{0,12}(?:生成|输出|保存|写入|完成)/i.test(
      joined
    )
  ) {
    return true
  }
  if (/(?:先问|追问|澄清|确认一下|问我|intake|clarify|ask\s+me)/i.test(joined)) {
    return false
  }
  return true
}

export function messageHasBrowserCollectionIntent(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  const fullText = messageToText(message)
  const envelopePrimary = parseEnvelopeResourceReferences(requestEnvelope).primaryInstruction
  const primary = envelopePrimary || primaryInstructionText(message)
  const hasActiveTaskContext = hasRecalledTaskContext(fullText)
  const primaryIntent = resolveBrowserWorkflowIntent(primary)
  const fullIntent = followupConsultsRecalledContext(primary, { hasActiveTaskContext })
    ? resolveBrowserWorkflowIntent(`${primary}\n${fullText}`)
    : primaryIntent
  if (isBrowserTransactionIntent(primaryIntent) || isBrowserTransactionIntent(fullIntent)) {
    return false
  }
  if (fullText.includes('### 浏览页面引用')) return true
  if (resolveBrowserCollectionIntent(primary)) {
    const negated = classifyFollowupIntent(primary, { hasActiveTaskContext })
    if (negated.negations.includes('collection')) return false
    return true
  }
  if (
    followupConsultsRecalledContext(primary, { hasActiveTaskContext }) &&
    resolveBrowserCollectionIntent(fullText)
  )
    return true
  return false
}

export function hasRecalledTaskContext(fullText: string): boolean {
  return fullText.includes('## 最近会话摘要') || fullText.includes('### 浏览页面引用')
}

export function messageHasBrowserBatchCollectionIntent(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  const fullText = messageToText(message)
  const envelopePrimary = parseEnvelopeResourceReferences(requestEnvelope).primaryInstruction
  const primary = envelopePrimary || primaryInstructionText(message)
  if (resolveBrowserBatchCollectionIntent(primary)) {
    const negated = classifyFollowupIntent(primary, {
      hasActiveTaskContext: hasRecalledTaskContext(fullText)
    })
    if (negated.negations.includes('collection')) return false
    return true
  }
  if (
    followupConsultsRecalledContext(primary, {
      hasActiveTaskContext: hasRecalledTaskContext(fullText)
    }) &&
    resolveBrowserBatchCollectionIntent(fullText)
  )
    return true
  return false
}

function extractRawExplicitMentionCandidate(rawUserText: string | null): string {
  if (!rawUserText || !/@\[[^\]]+\]/.test(rawUserText)) return ''
  const primary = primaryInstructionText(rawUserText).trim()
  if (/@\[[^\]]+\]/.test(primary)) return primary
  const mentionLine = rawUserText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(
      (line) =>
        /@\[[^\]]+\]/.test(line) && !SDK_CONTEXT_MARKERS.some((marker) => line.includes(marker))
    )
  return mentionLine || ''
}

export function skillAuthorizationTextCandidates(message: RunMessage, envelope: unknown): string[] {
  const record = asRecord(envelope)
  const rawUserText = stringField(record, 'rawUserText')
  const rawExplicitMention = extractRawExplicitMentionCandidate(rawUserText)
  const envelopeCandidates = [
    parseEnvelopeResourceReferences(envelope).primaryInstruction,
    stringField(record, 'primaryInstruction'),
    stringField(record, 'pureUserText'),
    rawExplicitMention
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  if (envelopeCandidates.length > 0) return Array.from(new Set(envelopeCandidates))

  if (rawUserText && !SDK_CONTEXT_MARKERS.some((marker) => rawUserText.includes(marker))) {
    return [rawUserText.trim()]
  }

  const fallback = primaryInstructionText(message).trim()
  return fallback ? [fallback] : []
}

/**
 * P1-2 — 从 envelope 读 typed `skill_reference` 资源的 name（去重、去空）。
 * envelope 保持哑数据：这里只提取，技能存在性由授权层的 findExplicitlyRequestedSkills 裁决。
 */
export function readSkillReferenceNames(envelope: unknown): string[] {
  const record = asRecord(envelope)
  const rawResources = record && Array.isArray(record.resources) ? record.resources : []
  const names: string[] = []
  const seen = new Set<string>()
  for (const resource of rawResources) {
    const entry = asRecord(resource)
    if (!entry || entry.kind !== 'skill_reference') continue
    const name = String(entry.name || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

interface SkillHintRelevanceDecision {
  relevant: boolean
  reason: string
}

export function resolveSkillHintRelevanceForTurn(params: {
  message: RunMessage
  requestEnvelope?: unknown
  sessionId?: string
  orchestrator: SkillContextOrchestratorLike | null
  localSendImIntent: boolean
  continuationIntent?: import('../contracts/continuation-state').ContinuationIntent | null
  continuationState?: import('../contracts/continuation-state').ContinuationState | null
  checkpointRestore?: AgentSdkBudgetCheckpointRestore | null
  taskRefs?: ReadonlyArray<FollowupTaskRef>
}): SkillHintRelevanceDecision {
  if (params.localSendImIntent) return { relevant: true, reason: 'local_send_im' }
  const userTextCandidates = skillAuthorizationTextCandidates(
    params.message,
    params.requestEnvelope
  )
  if (params.checkpointRestore || params.continuationIntent || params.continuationState) {
    return { relevant: true, reason: 'continuation' }
  }
  if (userTextCandidates.length === 0 || !params.orchestrator) {
    return { relevant: false, reason: 'no_skill_signal' }
  }
  for (const text of userTextCandidates) {
    const explicitSkills = params.orchestrator.findExplicitlyRequestedSkills?.(text) || []
    if (explicitSkills.some((skill) => skill?.id || skill?.skillId)) {
      return { relevant: true, reason: 'explicit_skill' }
    }
  }
  const referenceHint = resolveReferenceHintSnapshot(params.orchestrator, params.sessionId)
  if (!referenceHint) return { relevant: false, reason: 'no_reference_hint' }
  // P1 fix (2026-07-03, live regression) — a continuable task keeps the reduced
  // skill/collection continuation surface warm UNLESS the new turn starts its
  // OWN concrete browser action (a publish/upload/submit transaction or a
  // collection/download). Before, ANY turn with a reference hint + continuable
  // task hit continuable_task, so a fresh "把这条视频下载到X" after a paused
  // collection got the 12-tool skill set and lost
  // browser_media_download_advanced / browser_power_eval / resolve_video — the
  // agent then reported it "lacked the tools". A skill-resume follow-up with no
  // browser intent (e.g. "跑 finalize") still keeps the skill surface; genuine
  // resumes also come through the continuationIntent branch above.
  const startsFreshBrowserWork = userTextCandidates.some((text) => {
    const kind = resolveBrowserWorkflowIntent(text).kind
    return kind === 'transaction' || kind === 'collection'
  })
  if (params.taskRefs && hasContinuableTaskRef(params.taskRefs) && !startsFreshBrowserWork) {
    return { relevant: true, reason: 'continuable_task' }
  }
  for (const text of userTextCandidates) {
    if (
      shouldDisplayReferenceSkillHintForLatestUserText({
        latestUserText: text,
        skillId: referenceHint.id,
        skillName: referenceHint.name
      })
    ) {
      return { relevant: true, reason: 'reference_hint_text' }
    }
    if (looksLikeNaturalReferenceSkillFollowup(text)) {
      return { relevant: true, reason: 'natural_followup' }
    }
  }
  return { relevant: false, reason: 'unrelated_turn' }
}

function resolveReferenceHintSnapshot(
  orchestrator: SkillContextOrchestratorLike,
  sessionId?: string
): { id: string; name: string } | null {
  const fromOrchestrator = orchestrator.peekCurrentReferenceSkillHint?.(sessionId)
  if (fromOrchestrator?.id) return fromOrchestrator
  const hint = peekLastReferenceSkill(sessionId)
  return hint ? { id: hint.id, name: hint.name } : null
}

function looksLikeNaturalReferenceSkillFollowup(text: string): boolean {
  const normalized = String(text || '')
    .replace(/\s+/g, '')
    .trim()
  if (!normalized || normalized.length > 80) return false
  if (/[?？]/.test(normalized)) return false
  if (
    /^(?:那就|就按|按(?:这个|那个|第[一二三四五六七八九十0-9]+|第一|第二|第三)|开始吧|执行吧|推进吧)/i.test(
      normalized
    )
  ) {
    return true
  }
  if (
    !/^(?:好|好的|可以|行|嗯|对|没问题|ok|yes|sure)[，,。.!！、]?(?:那|就|按|继续|开始|推进|执行|做|跑|用|走|来|把|从)?/i.test(
      normalized
    )
  ) {
    return false
  }
  return /(?:按|照|这个|那个|第[一二三四五六七八九十0-9]+|方案|方向|推进|执行|做|开始|继续|跑|预算|面积|主推|产品)/i.test(
    normalized
  )
}

function isOpenConversationInvitationTurn(message: RunMessage, requestEnvelope?: unknown): boolean {
  const primary =
    parseEnvelopeResourceReferences(requestEnvelope).primaryInstruction ||
    primaryInstructionText(message)
  const text = String(primary || '').trim()
  if (!text) return false
  if (
    /(?:帮我|请|搜索|查询|查一下|打开|生成|制作|保存|写入|整理|分析(?:一下)?|下载|发给)/.test(text)
  ) {
    return false
  }
  return (
    /(?:让你(?:跟|和)我聊|陪我聊|(?:跟|和)我聊|聊聊|聊天).{0,24}(?:你会|怎么|如何|开头|开始|开场)/i.test(
      text
    ) || /^(?:hi|hello|hey|你好|嗨|哈喽)[，,\s].{0,40}(?:聊|哲学|怎么开头|你会怎么)/i.test(text)
  )
}

export function shouldSuppressAskUserQuestionsForOpenConversation(params: {
  message: RunMessage
  requestEnvelope?: unknown
  authorization: SkillToolAuthorization
}): boolean {
  if (params.authorization.mode === 'selected') return false
  return isOpenConversationInvitationTurn(params.message, params.requestEnvelope)
}

function resolveAuthorizationPreferredToolNames(
  authorization: SkillToolAuthorization
): string[] | null {
  if (authorization.mode !== 'selected') return null
  return Array.from(
    new Set([
      ...Array.from(authorization.allowedTypedActions),
      ...Array.from(authorization.allowedPrimitives)
    ])
  )
}

interface SdkDefaultIntentSurface {
  intentGroupModes: Partial<Record<CapabilityGroupId, boolean>>
  forceDocumentTool: boolean
  allowBrowserTools: boolean
  preferredSkillToolNames: string[] | null
  documentWidgetTaskKind: ReturnType<typeof inferDocumentWidgetTaskKind>
  explicitWidgetCreateIntent: boolean
}

export function resolveSdkDefaultIntentSurface(params: {
  message: RunMessage
  requestEnvelope?: unknown
  authorization: SkillToolAuthorization
  browserDecisionMode: import('../../../../shared/browser-agent-task').BrowserTaskDecisionMode
}): SdkDefaultIntentSurface {
  const envelopeRefs = parseEnvelopeResourceReferences(params.requestEnvelope)
  const userInstructionText =
    envelopeRefs.primaryInstruction || primaryInstructionText(params.message)
  const envelopeRecord = asRecord(params.requestEnvelope)
  const environmentHints = asRecord(envelopeRecord?.environmentHints)
  const rawUserText = stringField(envelopeRecord, 'rawUserText') || messageToText(params.message)
  const hasWidgetTargetContext =
    environmentHints?.hasWidgetTargetContext === true ||
    envelopeRefs.resources.some(
      (resource) => resource.kind === 'widget_target' || resource.source === 'widget_target'
    )
  const hasDocumentEnvironment =
    environmentHints?.hasDocumentContext === true ||
    rawUserText.includes('### 当前文档上下文') ||
    rawUserText.includes('### 文档引用') ||
    envelopeRefs.resources.some(
      (resource) =>
        resource.kind === 'document_context' ||
        resource.source === 'current_document' ||
        /\.(?:md|markdown|txt|docx?)$/i.test(`${resource.path || ''}\n${resource.name || ''}`)
    )
  const explicitWidgetCreateIntent = hasExplicitDocumentWidgetCreateIntent(userInstructionText)
  const documentWidgetTaskKind =
    hasWidgetTargetContext && !explicitWidgetCreateIntent
      ? 'update'
      : inferDocumentWidgetTaskKind(userInstructionText)
  const preferredSkillToolNames = resolveAuthorizationPreferredToolNames(params.authorization)
  const requestEnvelope = buildRequestEnvelope({ userText: rawUserText || userInstructionText })
  const mapSemanticIntent = classifyMapSemanticIntentFallback(userInstructionText)
  const intentClassification = applyMapSemanticIntentToIntentClassification(
    classifyIntent(requestEnvelope),
    mapSemanticIntent
  )

  const intentModes = resolveIntentCapabilityGroupModes({
    hasTools: true,
    capabilityProfile: 'local_chat',
    contextualUserInput: userInstructionText,
    userInstructionText,
    intentClassification,
    hasDocumentEnvironment:
      hasDocumentEnvironment ||
      (rawUserText.includes('## 环境信息') && rawUserText.includes('当前模式: 文档模式')),
    hasWidgetTargetContext,
    explicitWidgetCreateIntent,
    documentWidgetTaskKind,
    preferredSkillToolNames,
    mapSemanticIntent
  })

  return {
    intentGroupModes: intentModes.intentGroupModes,
    forceDocumentTool: intentModes.forceDocumentTool,
    allowBrowserTools:
      params.browserDecisionMode === 'browser_workflow' ||
      params.browserDecisionMode === 'browser_upload_workflow' ||
      intentModes.intentGroupModes.browser_interaction === true ||
      intentModes.intentGroupModes.browser_content_tasks === true,
    preferredSkillToolNames,
    documentWidgetTaskKind,
    explicitWidgetCreateIntent
  }
}
