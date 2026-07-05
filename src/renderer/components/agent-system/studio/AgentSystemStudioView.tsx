import { useEffect, useMemo, useState } from 'react'
import { Bot, Brain, CheckCircle2, ClipboardList, FileText, GitBranch, History, Pencil, Plus, RefreshCw, Route, Save, Trash2, XCircle } from 'lucide-react'
import type {
  AgentSystemStudioAgent,
  AgentSystemStudioContentEditTargetKind,
  AgentSystemStudioRoutingCard,
  AgentSystemStudioRoutingDisabledReason,
  AgentSystemStudioRoutingSimulation,
  AgentSystemStudioRoutingSimulationAction,
  AgentSystemStudioSnapshot,
} from '../../../../shared/agent-system-studio'
import type { SpecialistAgentBlueprint } from '../../../../shared/agent-specialist-blueprint'
import { buildSpecialistBlueprintClarificationContract } from '../../../../shared/agent-specialist-blueprint-clarification'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_FLAT_CHIP_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../settings/settings-theme'
import { AgentListItem, RoutingActionChoice } from './agent-list'
import {
  boundaryLabel,
  blueprintStatusBadge,
  Chip,
  EmptyLine,
  Field,
  RouteStateText,
  Section,
  StatusBadge,
} from './primitives'

const prerouteEffectLabel: Record<AgentSystemStudioRoutingSimulation['effect'], string> = {
  none: '不会分派',
  suggest: '建议选择',
  route: '自动进入',
}

const prerouteTierLabel: Record<AgentSystemStudioRoutingSimulation['decisionTier'], string> = {
  state: '续接任务',
  precedent: '命中路由',
  fallback: '主 agent',
}

const prerouteReasonLabel: Record<AgentSystemStudioRoutingSimulation['reasons'][number], string> = {
  routing_off: '路由关闭',
  suggest_only: '建议模式',
  card_staged: '有待确认路由卡',
  missing_triggers: '有卡片缺触发词',
  target_inactive: '有目标不可用',
  no_keyword_match: '未命中触发词',
  precedent_conflict: '触发词冲突',
  state_owner_inactive: '原 agent 不可用',
}

interface BlueprintSeedDraft {
  id: string
  title: string
  body: string
  evidenceRefsText: string
}

interface BlueprintEditorDraft {
  displayName: string
  specialistId: string
  intendedDomain: string
  rolePersona: string
  charter: string
  nonGoalsText: string
  recurringTasksText: string
  requiredInputsText: string
  expectedOutputsText: string
  suitableTaskExamplesText: string
  unsuitableTaskExamplesText: string
  mainVsSpecialistSplit: string
  routingTriggersText: string
  seedRulesText: string
  browserBoundaryNotes: string
  writeBoundaryNotes: string
  externalSendBoundaryNotes: string
  longMemoryBoundaryNotes: string
  toolSafetyNotes: string
  memoryProfilePolicy: string
  lifecycleNotes: string
  knowledgeSeeds: BlueprintSeedDraft[]
}

interface ContentEditDraft {
  targetKind: AgentSystemStudioContentEditTargetKind
  targetRelPath: string
  label: string
  content: string
}

function listToText(values: readonly string[]): string {
  return values.join('\n')
}

function textToList(value: string, limit?: number): string[] {
  const items = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
  return typeof limit === 'number' ? items.slice(0, limit) : items
}

function draftFromBlueprint(blueprint: SpecialistAgentBlueprint): BlueprintEditorDraft {
  return {
    displayName: blueprint.displayName,
    specialistId: blueprint.specialistId,
    intendedDomain: blueprint.intendedDomain,
    rolePersona: blueprint.rolePersona,
    charter: blueprint.charter,
    nonGoalsText: listToText(blueprint.nonGoals),
    recurringTasksText: listToText(blueprint.recurringTasks),
    requiredInputsText: listToText(blueprint.requiredInputs),
    expectedOutputsText: listToText(blueprint.expectedOutputs),
    suitableTaskExamplesText: listToText(blueprint.taskExamples.suitable),
    unsuitableTaskExamplesText: listToText(blueprint.taskExamples.unsuitable),
    mainVsSpecialistSplit: blueprint.mainVsSpecialistSplit,
    routingTriggersText: listToText(blueprint.routingTriggers),
    seedRulesText: blueprint.seedRulesText,
    browserBoundaryNotes: blueprint.toolBoundaries.browser.notes,
    writeBoundaryNotes: blueprint.toolBoundaries.write.notes,
    externalSendBoundaryNotes: blueprint.toolBoundaries.externalSend.notes,
    longMemoryBoundaryNotes: blueprint.toolBoundaries.longMemory.notes,
    toolSafetyNotes: blueprint.toolSafetyNotes,
    memoryProfilePolicy: blueprint.memoryProfilePolicy,
    lifecycleNotes: blueprint.lifecycleNotes,
    knowledgeSeeds: blueprint.knowledgeSeeds.map((seed, index) => ({
      id: `${blueprint.blueprintId}:seed:${index}`,
      title: seed.title,
      body: seed.body,
      evidenceRefsText: listToText(seed.evidenceRefs),
    })),
  }
}

function blueprintFromDraft(blueprint: SpecialistAgentBlueprint, draft: BlueprintEditorDraft): SpecialistAgentBlueprint {
  const specialistId = draft.specialistId.trim()
  const displayName = draft.displayName.trim()
  const intendedDomain = draft.intendedDomain.trim()
  const charter = draft.charter.trim()
  const seedRulesText = draft.seedRulesText.trim()
  const toolSafetyNotes = draft.toolSafetyNotes.trim()
  const rolePersona = draft.rolePersona.trim()
  const mainVsSpecialistSplit = draft.mainVsSpecialistSplit.trim()
  const memoryProfilePolicy = draft.memoryProfilePolicy.trim()
  const lifecycleNotes = draft.lifecycleNotes.trim()
  const routingTriggers = textToList(draft.routingTriggersText, 8)
  const knowledgeSeeds = draft.knowledgeSeeds
    .map((seed) => ({
      title: seed.title.trim(),
      body: seed.body.trim(),
      evidenceRefs: textToList(seed.evidenceRefsText),
    }))
    .filter((seed) => seed.title && seed.body)
  return {
    ...blueprint,
    specialistId,
    displayName,
    charter,
    intendedDomain,
    rolePersona,
    nonGoals: textToList(draft.nonGoalsText),
    recurringTasks: textToList(draft.recurringTasksText),
    requiredInputs: textToList(draft.requiredInputsText),
    expectedOutputs: textToList(draft.expectedOutputsText),
    taskExamples: {
      suitable: textToList(draft.suitableTaskExamplesText),
      unsuitable: textToList(draft.unsuitableTaskExamplesText),
    },
    mainVsSpecialistSplit,
    routingTriggers,
    seedRulesText,
    knowledgeSeeds,
    toolBoundaries: {
      browser: { ...blueprint.toolBoundaries.browser, notes: draft.browserBoundaryNotes.trim() },
      write: { ...blueprint.toolBoundaries.write, notes: draft.writeBoundaryNotes.trim() },
      externalSend: { ...blueprint.toolBoundaries.externalSend, notes: draft.externalSendBoundaryNotes.trim() },
      longMemory: { ...blueprint.toolBoundaries.longMemory, notes: draft.longMemoryBoundaryNotes.trim() },
    },
    toolSafetyNotes,
    memoryProfilePolicy,
    lifecycleNotes,
    inferredScope: {
      ...blueprint.inferredScope,
      slug: specialistId,
      displayName,
      domain: intendedDomain,
      routingTriggers,
    },
    foundationDocs: {
      ...blueprint.foundationDocs,
      charter,
      rulesText: seedRulesText,
      knowledgeSeeds,
      toolSafetyNotes,
      foundationText: blueprint.foundationDocs.foundationText,
    },
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function contentTargetLabel(kind: AgentSystemStudioContentEditTargetKind): string {
  if (kind === 'rules') return 'RULES'
  if (kind === 'foundation') return 'FOUNDATION'
  return '知识卡'
}

function proposalSourceLabel(source: string): string {
  return source === 'task_evolution' ? '任务演进' : '手动编辑'
}

function canApproveRoutingCard(card: AgentSystemStudioRoutingCard): boolean {
  return card.status === 'staged'
    && card.targetStatus === 'active'
    && Boolean(card.triggers?.length)
}

export default function AgentSystemStudio() {
  const [snapshot, setSnapshot] = useState<AgentSystemStudioSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string>('butler')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blueprintActionId, setBlueprintActionId] = useState<string | null>(null)
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string | null>(null)
  const [blueprintDraft, setBlueprintDraft] = useState<BlueprintEditorDraft | null>(null)
  const [blueprintEditorDirty, setBlueprintEditorDirty] = useState(false)
  const [blueprintEditorSaving, setBlueprintEditorSaving] = useState(false)
  const [blueprintEditorError, setBlueprintEditorError] = useState<string | null>(null)
  const [selectedMigrationRelPaths, setSelectedMigrationRelPaths] = useState<string[]>([])
  const [unverifiedSemanticAck, setUnverifiedSemanticAck] = useState(false)
  const [routingProbeText, setRoutingProbeText] = useState('我要写作专项帮我写一版大纲')
  const [routingProbeResult, setRoutingProbeResult] = useState<AgentSystemStudioRoutingSimulation | null>(null)
  const [routingProbeLoading, setRoutingProbeLoading] = useState(false)
  const [routingProbeError, setRoutingProbeError] = useState<string | null>(null)
  const [routingCardActionRelPath, setRoutingCardActionRelPath] = useState<string | null>(null)
  const [routingCardError, setRoutingCardError] = useState<string | null>(null)
  const [contentEditDraft, setContentEditDraft] = useState<ContentEditDraft | null>(null)
  const [contentEditSaving, setContentEditSaving] = useState(false)
  const [contentEditError, setContentEditError] = useState<string | null>(null)
  const [contentActionId, setContentActionId] = useState<string | null>(null)

  const load = async () => {
    if (!window.electronAPI?.agent?.getSystemStudioSnapshot) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.agent.getSystemStudioSnapshot()
      if (!result.success || !result.data) throw new Error(result.error || '读取 Agent 系统失败')
      setSnapshot(result.data)
      if (!result.data.agents.some((agent) => agent.id === selectedId)) {
        setSelectedId(result.data.agents[0]?.id || 'butler')
      }
      if (selectedBlueprintId && !result.data.stagedBlueprints.some((blueprint) => blueprint.blueprintId === selectedBlueprintId)) {
        setSelectedBlueprintId(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const selectedAgent = useMemo(
    () => snapshot?.agents.find((agent) => agent.id === selectedId) ?? snapshot?.agents[0] ?? null,
    [snapshot, selectedId],
  )

  useEffect(() => {
    setContentEditDraft(null)
    setContentEditError(null)
    setContentActionId(null)
  }, [selectedAgent?.id])

  const selectedBlueprint = useMemo(
    () => selectedBlueprintId
      ? snapshot?.stagedBlueprints.find((blueprint) => blueprint.blueprintId === selectedBlueprintId) ?? null
      : null,
    [snapshot, selectedBlueprintId],
  )

  useEffect(() => {
    if (!selectedBlueprint) {
      setBlueprintDraft(null)
      setBlueprintEditorDirty(false)
      return
    }
    setBlueprintDraft(draftFromBlueprint(selectedBlueprint))
    setBlueprintEditorDirty(false)
    setBlueprintEditorError(null)
    setSelectedMigrationRelPaths([])
    setUnverifiedSemanticAck(false)
  }, [selectedBlueprint])

  const updateBlueprintDraft = (patch: Partial<BlueprintEditorDraft>) => {
    setBlueprintDraft((current) => current ? { ...current, ...patch } : current)
    setBlueprintEditorDirty(true)
    setBlueprintEditorError(null)
    setUnverifiedSemanticAck(false)
  }

  const updateKnowledgeSeed = (seedId: string, patch: Partial<BlueprintSeedDraft>) => {
    setBlueprintDraft((current) => current ? {
      ...current,
      knowledgeSeeds: current.knowledgeSeeds.map((seed) => (
        seed.id === seedId ? { ...seed, ...patch } : seed
      )),
    } : current)
    setBlueprintEditorDirty(true)
    setBlueprintEditorError(null)
    setUnverifiedSemanticAck(false)
  }

  const handleAddKnowledgeSeed = () => {
    setBlueprintDraft((current) => current ? {
      ...current,
      knowledgeSeeds: [
        ...current.knowledgeSeeds,
        { id: `seed:${Date.now()}`, title: '', body: '', evidenceRefsText: '' },
      ],
    } : current)
    setBlueprintEditorDirty(true)
    setUnverifiedSemanticAck(false)
  }

  const handleRemoveKnowledgeSeed = (seedId: string) => {
    setBlueprintDraft((current) => current ? {
      ...current,
      knowledgeSeeds: current.knowledgeSeeds.filter((seed) => seed.id !== seedId),
    } : current)
    setBlueprintEditorDirty(true)
    setUnverifiedSemanticAck(false)
  }

  const toggleMigrationRelPath = (relPath: string) => {
    setSelectedMigrationRelPaths((current) => (
      current.includes(relPath)
        ? current.filter((item) => item !== relPath)
        : [...current, relPath]
    ))
  }

  const handleSaveBlueprint = async () => {
    if (!selectedBlueprint || !blueprintDraft || selectedBlueprint.status === 'confirmed') return
    if (!window.electronAPI?.agent?.runSpecialistBlueprintAdmission) return
    setBlueprintEditorSaving(true)
    setBlueprintEditorError(null)
    setError(null)
    try {
      const next = blueprintFromDraft(selectedBlueprint, blueprintDraft)
      const result = await window.electronAPI.agent.runSpecialistBlueprintAdmission({ blueprint: next })
      if (!result.success || !result.data) throw new Error(result.error || '保存 blueprint 失败')
      setSelectedBlueprintId(result.data.blueprint.blueprintId)
      setBlueprintEditorDirty(false)
      await load()
    } catch (err) {
      setBlueprintEditorError(err instanceof Error ? err.message : String(err))
    } finally {
      setBlueprintEditorSaving(false)
    }
  }

  const handleRefreshBlueprintSemanticReview = async (blueprint: SpecialistAgentBlueprint) => {
    if (!window.electronAPI?.agent?.runSpecialistBlueprintAdmission) return
    setBlueprintActionId(blueprint.blueprintId)
    setError(null)
    try {
      const result = await window.electronAPI.agent.runSpecialistBlueprintAdmission({
        blueprintId: blueprint.blueprintId,
      })
      if (!result.success || !result.data) throw new Error(result.error || '语义校验刷新失败')
      setSelectedBlueprintId(result.data.blueprint.blueprintId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBlueprintActionId(null)
    }
  }

  const handleRejectBlueprint = async (blueprint: SpecialistAgentBlueprint) => {
    if (!window.electronAPI?.agent?.rejectSpecialistBlueprint) return
    setBlueprintActionId(blueprint.blueprintId)
    setError(null)
    try {
      const result = await window.electronAPI.agent.rejectSpecialistBlueprint(blueprint.blueprintId)
      if (!result.success) throw new Error(result.error || '拒绝 blueprint 失败')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBlueprintActionId(null)
    }
  }

  const handleConfirmBlueprint = async (blueprint: SpecialistAgentBlueprint) => {
    if (!window.electronAPI?.agent?.requestSpecialistBlueprintConfirmation || !window.electronAPI?.agent?.confirmSpecialistDraftCreate) return
    setBlueprintActionId(blueprint.blueprintId)
    setError(null)
    try {
      const sessionId = `agent-system-studio:${blueprint.blueprintId}`
      let tokenId = blueprint.status === 'confirmed' && !blueprint.adoption
        ? blueprint.confirmation.tokenId
        : null
      const review = blueprint.semanticReview
      const needsUnverifiedAck = Boolean(
        review
          && review.status === 'unavailable'
          && review.source !== 'unverified_explicit',
      )
      if (!tokenId) {
        const token = await window.electronAPI.agent.requestSpecialistBlueprintConfirmation({
          blueprintId: blueprint.blueprintId,
          sessionId,
          ...(needsUnverifiedAck && unverifiedSemanticAck
            ? {
                unverifiedSemanticReviewAck: {
                  kind: 'unverified_semantic_review',
                  contentHash: review?.contentHash || '',
                },
              }
            : {}),
        })
        if (!token.success || !token.data) throw new Error(token.error || '确认 token 生成失败')
        tokenId = token.data.tokenId
      }
      const confirmed = await window.electronAPI.agent.confirmSpecialistDraftCreate({
        blueprintId: blueprint.blueprintId,
        sessionId,
        tokenId,
        migrateCardRelPaths: selectedMigrationRelPaths,
      })
      if (!confirmed.success) throw new Error(confirmed.error || '创建专项 Agent 失败')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await load()
    } finally {
      setBlueprintActionId(null)
    }
  }

  const handleRoutingProbe = async () => {
    if (!window.electronAPI?.agent?.simulateSystemStudioRouting) return
    const firstMessage = routingProbeText.trim()
    if (!firstMessage) {
      setRoutingProbeError('请输入一句样例请求')
      setRoutingProbeResult(null)
      return
    }
    setRoutingProbeLoading(true)
    setRoutingProbeError(null)
    try {
      const result = await window.electronAPI.agent.simulateSystemStudioRouting(firstMessage)
      if (!result.success || !result.data) throw new Error(result.error || '路由试算失败')
      setRoutingProbeResult(result.data)
    } catch (err) {
      setRoutingProbeError(err instanceof Error ? err.message : String(err))
      setRoutingProbeResult(null)
    } finally {
      setRoutingProbeLoading(false)
    }
  }

  const selectedAgentCanEditContent = Boolean(
    selectedAgent
      && selectedAgent.kind === 'specialist'
      && selectedAgent.status === 'active',
  )

  const beginContentEdit = (
    targetKind: AgentSystemStudioContentEditTargetKind,
    targetRelPath: string,
    label: string,
    content: string | null,
  ) => {
    if (!selectedAgentCanEditContent) return
    setContentEditDraft({
      targetKind,
      targetRelPath,
      label,
      content: content ?? '',
    })
    setContentEditError(null)
  }

  const handleStageContentEdit = async () => {
    if (!selectedAgent || !contentEditDraft || !window.electronAPI?.agent?.stageSystemStudioContentEdit) return
    setContentEditSaving(true)
    setContentEditError(null)
    try {
      const result = await window.electronAPI.agent.stageSystemStudioContentEdit({
        agentId: selectedAgent.id,
        targetKind: contentEditDraft.targetKind,
        targetRelPath: contentEditDraft.targetRelPath,
        proposedContent: contentEditDraft.content,
        sessionId: `agent-system-studio:${selectedAgent.id}`,
      })
      if (!result.success || !result.data) throw new Error(result.error || '保存内容提案失败')
      setContentEditDraft(null)
      await load()
    } catch (err) {
      setContentEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setContentEditSaving(false)
    }
  }

  const handleConfirmContentEdit = async (proposalId: string) => {
    if (!window.electronAPI?.agent?.confirmSystemStudioContentEdit) return
    setContentActionId(proposalId)
    setContentEditError(null)
    try {
      const result = await window.electronAPI.agent.confirmSystemStudioContentEdit(proposalId)
      if (!result.success || !result.data) throw new Error(result.error || '确认内容提案失败')
      await load()
    } catch (err) {
      setContentEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setContentActionId(null)
    }
  }

  const handleRejectContentEdit = async (proposalId: string) => {
    if (!window.electronAPI?.agent?.rejectSystemStudioContentEdit) return
    setContentActionId(proposalId)
    setContentEditError(null)
    try {
      const result = await window.electronAPI.agent.rejectSystemStudioContentEdit(proposalId)
      if (!result.success || !result.data) throw new Error(result.error || '拒绝内容提案失败')
      await load()
    } catch (err) {
      setContentEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setContentActionId(null)
    }
  }

  const handleRoutingCardTransition = async (card: AgentSystemStudioRoutingCard, action: 'approve' | 'reject') => {
    if (!window.electronAPI?.memoryCards?.transition) return
    setRoutingCardActionRelPath(card.relPath)
    setRoutingCardError(null)
    try {
      const result = await window.electronAPI.memoryCards.transition({
        relPath: card.relPath,
        action,
      })
      if (!result.success) throw new Error(result.error || '路由卡更新失败')
      await load()
    } catch (err) {
      setRoutingCardError(err instanceof Error ? err.message : String(err))
    } finally {
      setRoutingCardActionRelPath(null)
    }
  }

  const counts = useMemo(() => {
    const agents = snapshot?.agents ?? []
    return {
      specialists: agents.filter((agent) => agent.kind === 'specialist' && agent.status === 'active').length,
      routingDisabled: snapshot?.routingCards.filter((card) => card.disabledReason).length ?? 0,
      tasks: agents.reduce((sum, agent) => sum + agent.ownedTasks.length, 0),
      traces: snapshot?.recentPrerouteTraces.length ?? 0,
      blueprints: snapshot?.stagedBlueprints.length ?? 0,
    }
  }, [snapshot])

  const selectedBlueprintClarification = selectedBlueprint?.admissionVerdict.kind === 'clarify'
    ? buildSpecialistBlueprintClarificationContract(selectedBlueprint, selectedBlueprint.admissionVerdict.missing)
    : null
  const selectedBlueprintFailedQualityChecks = (selectedBlueprint?.qualityChecks ?? [])
    .filter((check) => check.pass === false && check.blocking !== false)
  const selectedBlueprintHasQualityPass = Boolean(
    selectedBlueprint
      && selectedBlueprint.qualityChecks.length > 0
      && selectedBlueprintFailedQualityChecks.length === 0,
  )
  const selectedBlueprintCanEdit = Boolean(selectedBlueprint && selectedBlueprint.status !== 'confirmed')
  const selectedBlueprintSemanticReview = selectedBlueprint?.semanticReview ?? null
  const selectedBlueprintSemanticMissing = Boolean(selectedBlueprint && !selectedBlueprintSemanticReview)
  const selectedBlueprintSemanticPassed = Boolean(
    selectedBlueprintSemanticReview?.status === 'passed'
      && selectedBlueprintSemanticReview.source === 'semantic_judge',
  )
  const selectedBlueprintSemanticAcknowledged = Boolean(
    selectedBlueprintSemanticReview?.status === 'unavailable'
      && selectedBlueprintSemanticReview.source === 'unverified_explicit',
  )
  const selectedBlueprintSemanticBlocked = Boolean(selectedBlueprintSemanticReview?.status === 'blocked')
  const selectedBlueprintNeedsUnverifiedAck = Boolean(
    selectedBlueprintSemanticReview
      && selectedBlueprintSemanticReview.status === 'unavailable'
      && selectedBlueprintSemanticReview.source !== 'unverified_explicit',
  )
  const selectedBlueprintSemanticAccepted = selectedBlueprintSemanticPassed
    || selectedBlueprintSemanticAcknowledged
    || (selectedBlueprintNeedsUnverifiedAck && unverifiedSemanticAck)
  const selectedBlueprintNeedsSemanticRefresh = Boolean(
    selectedBlueprint
      && selectedBlueprintSemanticMissing
      && selectedBlueprint.status === 'staged'
      && selectedBlueprint.admissionVerdict.kind === 'admit'
      && selectedBlueprintHasQualityPass
      && !blueprintEditorDirty,
  )
  const selectedBlueprintCanConfirm = Boolean(
    selectedBlueprint
      && (
        selectedBlueprint.status === 'staged'
        || (selectedBlueprint.status === 'confirmed' && !selectedBlueprint.adoption && Boolean(selectedBlueprint.confirmation.tokenId))
      )
      && selectedBlueprint.admissionVerdict.kind === 'admit'
      && selectedBlueprintHasQualityPass
      && selectedBlueprintSemanticAccepted
      && !blueprintEditorDirty,
  )

  return (
    <section className="glass-surface-card border" style={{ ...SETTINGS_CARD_STYLE, padding: '20px 22px' }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)', margin: 0 }}>
            Agent System Studio
          </h3>
          <div className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
            主 agent、专项 agent、路由卡、任务归属和最近分派原因。
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
          style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      {error && <div className="mt-4 text-[13px]" style={{ color: 'var(--color-red)' }}>{error}</div>}

      <div className="mt-5 grid gap-3 md:grid-cols-5">
        <Section icon={<Bot className="h-4 w-4" />} title="专项">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-title)' }}>{counts.specialists}</div>
        </Section>
        <Section icon={<FileText className="h-4 w-4" />} title="蓝图">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-title)' }}>{counts.blueprints}</div>
        </Section>
        <Section icon={<Route className="h-4 w-4" />} title="路由待处理">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-title)' }}>{counts.routingDisabled}</div>
        </Section>
        <Section icon={<ClipboardList className="h-4 w-4" />} title="归属任务">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-title)' }}>{counts.tasks}</div>
        </Section>
        <Section icon={<History className="h-4 w-4" />} title="最近 trace">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-title)' }}>{counts.traces}</div>
        </Section>
      </div>

      {loading && !snapshot && <div className="mt-5 text-[13px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>}

      {snapshot && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            {snapshot.agents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedAgent?.id}
                onSelect={() => setSelectedId(agent.id)}
              />
            ))}
          </div>

          <div className="min-w-0 space-y-4">
            {selectedAgent && (
              <Section icon={<Bot className="h-4 w-4" />} title={selectedAgent.name}>
                <div className="flex flex-wrap gap-2">
                  <Chip>{selectedAgent.id}</Chip>
                  <Chip>{selectedAgent.kind === 'main' ? '主 agent' : selectedAgent.status}</Chip>
                  {selectedAgent.parentAgentId && <Chip>来源 {selectedAgent.parentAgentId}</Chip>}
                  {selectedAgent.mergedIntoAgentId && <Chip>并入 {selectedAgent.mergedIntoAgentId}</Chip>}
                  <Chip>知识 {selectedAgent.contentSummary.knowledgeCards}</Chip>
                  <Chip>路由 {selectedAgent.contentSummary.routingCards}</Chip>
                  <Chip>任务 {selectedAgent.contentSummary.ownedTasks}</Chip>
                  <Chip>待确认修改 {selectedAgent.contentSummary.stagedContentEdits}</Chip>
                </div>
                <div className="mt-3 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                  {selectedAgent.charter || '未填写职责'}
                </div>
              </Section>
            )}

            {selectedAgent && (
              <div className="grid gap-4 xl:grid-cols-2">
                <Section icon={<FileText className="h-4 w-4" />} title="RULES">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {selectedAgent.rules.exists
                        ? <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>{selectedAgent.rules.content}</pre>
                        : <EmptyLine text="还没有 RULES.md。" />}
                    </div>
                    {selectedAgentCanEditContent && (
                      <button
                        type="button"
                        onClick={() => beginContentEdit('rules', selectedAgent.rules.relPath, 'RULES', selectedAgent.rules.content)}
                        className="border rounded-lg inline-flex items-center gap-1.5 text-[11px]"
                        style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '7px 9px' }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
                      </button>
                    )}
                  </div>
                </Section>

                <Section icon={<FileText className="h-4 w-4" />} title="FOUNDATION">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {selectedAgent.foundation.exists
                        ? <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>{selectedAgent.foundation.content}</pre>
                        : <EmptyLine text="还没有 FOUNDATION.md。" />}
                    </div>
                    {selectedAgentCanEditContent && (
                      <button
                        type="button"
                        onClick={() => beginContentEdit('foundation', selectedAgent.foundation.relPath, 'FOUNDATION', selectedAgent.foundation.content)}
                        className="border rounded-lg inline-flex items-center gap-1.5 text-[11px]"
                        style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '7px 9px' }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
                      </button>
                    )}
                  </div>
                </Section>

                <Section icon={<Brain className="h-4 w-4" />} title="知识">
                  {selectedAgent.knowledgeCards.length === 0 && <EmptyLine text="暂无知识卡。" />}
                  <div className="flex flex-col gap-2">
                    {selectedAgent.knowledgeCards.slice(0, 8).map((card) => (
                      <div key={card.relPath} className="min-w-0 border-b pb-2 last:border-b-0 last:pb-0" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 12%, transparent)' }}>
                        <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>{card.title}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <Chip>{card.status}</Chip>
                          {card.tag && <Chip>{card.tag}</Chip>}
                          <Chip>{card.scopeId}</Chip>
                        </div>
                        <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>{card.relPath}</div>
                        {card.description && (
                          <div className="mt-1 line-clamp-2 text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
                            {card.description}
                          </div>
                        )}
                        <pre className="mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
                          {card.body}
                        </pre>
                        {selectedAgentCanEditContent && (
                          <button
                            type="button"
                            onClick={() => beginContentEdit('knowledge_card', card.relPath, card.title, card.body)}
                            className="mt-2 border rounded-lg inline-flex items-center gap-1.5 text-[11px]"
                            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 8px' }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            编辑
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>

                <Section icon={<Route className="h-4 w-4" />} title="路由">
                  {selectedAgent.routingCards.length === 0 && <EmptyLine text="没有指向它的路由卡。" />}
                  {routingCardError && (
                    <div className="mb-3 text-[12px]" style={{ color: 'var(--color-red)' }}>{routingCardError}</div>
                  )}
                  <div className="flex flex-col gap-2">
                    {selectedAgent.routingCards.map((card) => (
                      <div key={card.relPath} className="min-w-0 border-b pb-2 last:border-b-0 last:pb-0" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 12%, transparent)' }}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>{card.title}</div>
                          <RouteStateText card={card} />
                        </div>
                        <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
                          {(card.triggers ?? []).join(' / ') || '无触发词'}
                        </div>
                        {card.status === 'staged' && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {canApproveRoutingCard(card) ? (
                              <button
                                type="button"
                                onClick={() => void handleRoutingCardTransition(card, 'approve')}
                                disabled={routingCardActionRelPath === card.relPath}
                                className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
                                style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 8px' }}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                启用路由
                              </button>
                            ) : (
                              <span className="text-[11px]" style={{ color: 'var(--text-light)' }}>
                                目标不可用或缺触发词，不能启用。
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleRoutingCardTransition(card, 'reject')}
                              disabled={routingCardActionRelPath === card.relPath}
                              className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
                              style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 8px' }}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              拒绝
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>

                <Section icon={<ClipboardList className="h-4 w-4" />} title="任务">
                  {selectedAgent.ownedTasks.length === 0 && <EmptyLine text="暂无归属任务。" />}
                  <div className="flex flex-col gap-2">
                    {selectedAgent.ownedTasks.map((task) => (
                      <div key={task.taskId} className="min-w-0 border-b pb-2 last:border-b-0 last:pb-0" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 12%, transparent)' }}>
                        <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>{task.title || task.taskId}</div>
                        <div className="mt-1 text-[11px]" style={{ color: 'var(--text-light)' }}>
                          {task.status} · {formatDate(task.updatedAt)}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              </div>
            )}

            {selectedAgent && contentEditDraft && (
              <Section icon={<Pencil className="h-4 w-4" />} title="内容修改草稿">
                <div className="flex flex-wrap gap-2">
                  <Chip>{selectedAgent.name}</Chip>
                  <Chip>{contentTargetLabel(contentEditDraft.targetKind)}</Chip>
                  <Chip>{contentEditDraft.targetRelPath}</Chip>
                </div>
                <div className="mt-3">
                  <Field
                    label={`修改内容：${contentEditDraft.label}`}
                    value={contentEditDraft.content}
                    multiline
                    rows={10}
                    onChange={(content) => setContentEditDraft((current) => current ? { ...current, content } : current)}
                  />
                </div>
                {contentEditError && (
                  <div className="mt-3 text-[12px]" style={{ color: 'var(--color-red)' }}>{contentEditError}</div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleStageContentEdit()}
                    disabled={contentEditSaving || !contentEditDraft.content.trim()}
                    className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
                    style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
                  >
                    <Save className="h-3.5 w-3.5" />
                    保存为提案
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setContentEditDraft(null)
                      setContentEditError(null)
                    }}
                    disabled={contentEditSaving}
                    className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
                    style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    取消
                  </button>
                </div>
              </Section>
            )}

            {selectedAgent && (
              <Section icon={<History className="h-4 w-4" />} title="内容修改提案">
                {contentEditError && !contentEditDraft && (
                  <div className="mb-3 text-[12px]" style={{ color: 'var(--color-red)' }}>{contentEditError}</div>
                )}
                {selectedAgent.contentEditProposals.length === 0 && <EmptyLine text="暂无内容修改提案。" />}
                <div className="flex flex-col gap-3">
                  {selectedAgent.contentEditProposals.map((proposal) => (
                    <div
                      key={proposal.proposalId}
                      className="rounded-lg border"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
                        padding: '10px 12px',
                        background: 'color-mix(in srgb, var(--surface-panel-bg) 38%, transparent)',
                      }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>
                            {contentTargetLabel(proposal.targetKind)} · {proposal.targetRelPath}
                          </div>
                          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-light)' }}>
                            {proposal.proposalId} · {formatDate(proposal.updatedAt)}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Chip>{proposalSourceLabel(proposal.provenance.source)}</Chip>
                          <Chip>{proposal.status}</Chip>
                        </div>
                      </div>
                      {proposal.provenance.taskId && (
                        <div className="mt-2 text-[11px]" style={{ color: 'var(--text-light)' }}>
                          来源任务 {proposal.provenance.taskId}
                        </div>
                      )}
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div>
                          <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--text-light)' }}>当前基线</div>
                          <pre className="max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-[11px] leading-4" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
                            {proposal.baseContent || '空'}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--text-light)' }}>拟应用内容</div>
                          <pre className="max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-[11px] leading-4" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
                            {proposal.proposedContent}
                          </pre>
                        </div>
                      </div>
                      {proposal.status === 'staged' && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void handleConfirmContentEdit(proposal.proposalId)}
                            disabled={contentActionId === proposal.proposalId}
                            className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
                            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            确认应用
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRejectContentEdit(proposal.proposalId)}
                            disabled={contentActionId === proposal.proposalId}
                            className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
                            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            拒绝
                          </button>
                        </div>
                      )}
                      {proposal.status === 'conflict' && (
                        <div className="mt-2 text-[11px]" style={{ color: 'var(--color-red)' }}>
                          目标内容已变化，请重新打开内容后再提交。
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section icon={<GitBranch className="h-4 w-4" />} title="候选与蓝图">
              <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>涌现候选</div>
              {snapshot.derivationCandidates.length === 0 ? (
                <EmptyLine text="暂无候选。" />
              ) : (
                <div className="flex flex-col gap-2">
                  {snapshot.derivationCandidates.map((candidate) => (
                    <div key={candidate.candidateRelPath} className="min-w-0">
                      <div className="truncate text-[12px]" style={{ color: 'var(--text-title)' }}>{candidate.defaultName}</div>
                      <div className="truncate text-[11px]" style={{ color: 'var(--text-light)' }}>{candidate.candidateRelPath}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-6 mb-2 text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>蓝图草案</div>
              {snapshot.stagedBlueprints.length === 0 && <EmptyLine text="暂无蓝图草案。" />}
              {snapshot.stagedBlueprints.length > 0 && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start gap-2">
                    {snapshot.stagedBlueprints.map((blueprint) => {
                      const badge = blueprintStatusBadge(blueprint)
                      const active = blueprint.blueprintId === selectedBlueprintId
                      return (
                        <button
                          type="button"
                          key={blueprint.blueprintId}
                          onClick={() => setSelectedBlueprintId(active ? null : blueprint.blueprintId)}
                          className="min-w-[196px] max-w-[280px] flex-1 rounded-lg border text-left transition-[border-color,background-color]"
                          style={{
                            borderColor: active
                              ? 'color-mix(in srgb, var(--color-blue) 48%, transparent)'
                              : 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
                            padding: '12px',
                            background: active
                              ? 'color-mix(in srgb, var(--color-blue) 9%, transparent)'
                              : 'color-mix(in srgb, var(--surface-panel-bg) 42%, transparent)',
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>
                              {blueprint.displayName}
                            </div>
                            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                          </div>
                          <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
                            {blueprint.blueprintId}
                          </div>
                          {blueprint.admissionVerdict.kind === 'clarify' && (() => {
                            const clarification = buildSpecialistBlueprintClarificationContract(blueprint, blueprint.admissionVerdict.missing)
                            return (
                              <div className="mt-2 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
                                <div className="truncate">待补齐：{blueprint.admissionVerdict.missing.join(' / ')}</div>
                                {clarification.questions[0] && (
                                  <div className="truncate">下一步：{clarification.questions[0].question}</div>
                                )}
                                <div className="mt-1" style={{ color: 'var(--color-orange)' }}>先补齐信息后可确认</div>
                              </div>
                            )
                          })()}
	                        </button>
	                      )
	                    })}
	                  </div>

                  {!selectedBlueprint && <EmptyLine text="点开蓝图查看详情、编辑或确认创建。" />}

                  {selectedBlueprint && blueprintDraft && (
                    <div
	                    className="min-w-0 rounded-lg border"
	                    style={{
	                      borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
                      padding: '16px',
                      background: 'color-mix(in srgb, var(--surface-panel-bg) 42%, transparent)',
	                    }}
	                  >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>
                              {selectedBlueprint.displayName}
                            </div>
                            <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
                              {selectedBlueprint.blueprintId} · {selectedBlueprint.intendedDomain}
                            </div>
                          </div>
                          <StatusBadge tone={blueprintStatusBadge(selectedBlueprint).tone}>
                            {blueprintStatusBadge(selectedBlueprint).label}
                          </StatusBadge>
                        </div>

                        {selectedBlueprint.routingTriggers.length > 0 && (
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <span className="text-[11px]" style={{ color: 'var(--text-light)' }}>触发词</span>
                            {selectedBlueprint.routingTriggers.map((trigger) => <Chip key={trigger}>{trigger}</Chip>)}
                          </div>
                        )}

                        {selectedBlueprint.admissionVerdict.kind === 'clarify' && (
                          <div className="mt-3 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
                            <div>待补齐：{selectedBlueprint.admissionVerdict.missing.join(' / ')}</div>
                            {selectedBlueprintClarification && selectedBlueprintClarification.questions.length > 0 && (
                              <div className="mt-1">
                                下一步：{selectedBlueprintClarification.questions.map((question) => question.question).join(' / ')}
                              </div>
                            )}
                          </div>
                        )}

                        <div
                          className="mt-4 rounded-lg border p-3 text-[11px] leading-5"
                          style={{
                            borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
                            background: 'color-mix(in srgb, var(--surface-panel-bg) 34%, transparent)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          <div className="mb-3 flex flex-wrap gap-2">
                            <Chip>{selectedBlueprintHasQualityPass ? '质量通过' : '质量需修正'}</Chip>
                            <Chip>{selectedBlueprint.foundationDocs.foundationText ? 'FOUNDATION 已预览' : 'FOUNDATION 待生成'}</Chip>
                            <Chip>
                              {selectedBlueprintSemanticPassed
                                ? '语义已校验'
                                : selectedBlueprintSemanticAcknowledged
                                  ? '语义未校验已确认'
                                  : selectedBlueprintSemanticBlocked
                                    ? '语义需修正'
                                    : '语义未校验'}
                            </Chip>
                            <Chip>浏览器 {boundaryLabel(selectedBlueprint.toolBoundaries.browser.mode)}</Chip>
                            <Chip>写入 {boundaryLabel(selectedBlueprint.toolBoundaries.write.mode)}</Chip>
                            <Chip>外发 {boundaryLabel(selectedBlueprint.toolBoundaries.externalSend.mode)}</Chip>
                            <Chip>长期记忆 {boundaryLabel(selectedBlueprint.toolBoundaries.longMemory.mode)}</Chip>
                          </div>
                          {selectedBlueprintFailedQualityChecks.length > 0 ? (
                            <div>
                              <div className="font-medium" style={{ color: 'var(--text-title)' }}>质量缺口</div>
                              <div className="mt-1 flex flex-col gap-1">
                                {selectedBlueprintFailedQualityChecks.slice(0, 6).map((check) => (
                                  <div key={`${check.check}:${check.message || ''}`}>- {check.message || check.check}</div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div>蓝图包含职责、边界、样例、工具约束、记忆策略和生命周期说明。</div>
                          )}
                          {selectedBlueprintSemanticReview && selectedBlueprintSemanticReview.issues.length > 0 && (
                            <div className="mt-3">
                              <div className="font-medium" style={{ color: 'var(--text-title)' }}>语义缺口</div>
                              <div className="mt-1 flex flex-col gap-1">
                                {selectedBlueprintSemanticReview.issues.slice(0, 6).map((issue) => (
                                  <div key={issue.id}>- {issue.message}</div>
                                ))}
                              </div>
                            </div>
                          )}
                          {selectedBlueprintSemanticReview?.status === 'unavailable' && selectedBlueprintSemanticReview.source !== 'unverified_explicit' && (
                            <div className="mt-3">
                              FOUNDATION 尚未完成语义校验：{selectedBlueprintSemanticReview.unavailableReason || 'judge_unavailable'}。
                            </div>
                          )}
                          {selectedBlueprintSemanticMissing && selectedBlueprint.admissionVerdict.kind === 'admit' && (
                            <div className="mt-3">
                              FOUNDATION 还没有语义校验记录，请先刷新当前蓝图的校验状态。
                            </div>
                          )}
                        </div>

                        <div
                          className="mt-4 rounded-lg border p-3"
                          style={{
                            borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
                            background: 'color-mix(in srgb, var(--surface-panel-bg) 34%, transparent)',
                          }}
                        >
                          <div className="mb-2 text-[11px] font-medium" style={{ color: 'var(--text-light)' }}>FOUNDATION 预览</div>
                          <pre
                            className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-[11px] leading-5"
                            style={{
                              borderColor: 'color-mix(in srgb, var(--surface-border) 12%, transparent)',
                              background: 'color-mix(in srgb, var(--surface-panel-bg) 44%, transparent)',
                              color: 'var(--text-muted)',
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            }}
                          >
                            {selectedBlueprint.foundationDocs.foundationText || 'FOUNDATION 待生成。'}
                          </pre>
                        </div>

                        {selectedBlueprintNeedsUnverifiedAck && (
                          <label
                            className="mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]"
                            style={{
                              borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
                              background: 'color-mix(in srgb, var(--surface-panel-bg) 34%, transparent)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 h-3.5 w-3.5"
                              checked={unverifiedSemanticAck}
                              onChange={(event) => setUnverifiedSemanticAck(event.currentTarget.checked)}
                            />
                            <span>我已阅读完整 FOUNDATION，知道它尚未完成语义校验，仍要继续确认创建。</span>
                          </label>
                        )}

                        {blueprintEditorError && (
                          <div className="mt-3 text-[12px]" style={{ color: 'var(--color-red)' }}>{blueprintEditorError}</div>
                        )}

                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          <Field label="蓝图名称" value={blueprintDraft.displayName} disabled={!selectedBlueprintCanEdit} onChange={(displayName) => updateBlueprintDraft({ displayName })} />
                          <Field label="专项 ID" value={blueprintDraft.specialistId} disabled={!selectedBlueprintCanEdit} onChange={(specialistId) => updateBlueprintDraft({ specialistId })} />
                          <Field label="工作领域" value={blueprintDraft.intendedDomain} disabled={!selectedBlueprintCanEdit} onChange={(intendedDomain) => updateBlueprintDraft({ intendedDomain })} />
                          <Field label="角色与判断口径" value={blueprintDraft.rolePersona} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(rolePersona) => updateBlueprintDraft({ rolePersona })} />
                          <Field label="路由触发词" value={blueprintDraft.routingTriggersText} disabled={!selectedBlueprintCanEdit} multiline rows={3} onChange={(routingTriggersText) => updateBlueprintDraft({ routingTriggersText })} />
                          <Field label="职责范围" value={blueprintDraft.charter} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(charter) => updateBlueprintDraft({ charter })} />
                          <Field label="不做事项" value={blueprintDraft.nonGoalsText} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(nonGoalsText) => updateBlueprintDraft({ nonGoalsText })} />
                          <Field label="常规任务" value={blueprintDraft.recurringTasksText} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(recurringTasksText) => updateBlueprintDraft({ recurringTasksText })} />
                          <Field label="所需输入" value={blueprintDraft.requiredInputsText} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(requiredInputsText) => updateBlueprintDraft({ requiredInputsText })} />
                          <Field label="期望输出" value={blueprintDraft.expectedOutputsText} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(expectedOutputsText) => updateBlueprintDraft({ expectedOutputsText })} />
                          <Field label="适合任务例子" value={blueprintDraft.suitableTaskExamplesText} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(suitableTaskExamplesText) => updateBlueprintDraft({ suitableTaskExamplesText })} />
                          <Field label="不适合任务例子" value={blueprintDraft.unsuitableTaskExamplesText} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(unsuitableTaskExamplesText) => updateBlueprintDraft({ unsuitableTaskExamplesText })} />
                          <Field label="主/专项分工" value={blueprintDraft.mainVsSpecialistSplit} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(mainVsSpecialistSplit) => updateBlueprintDraft({ mainVsSpecialistSplit })} />
                          <Field label="安全说明" value={blueprintDraft.toolSafetyNotes} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(toolSafetyNotes) => updateBlueprintDraft({ toolSafetyNotes })} />
                          <Field label="浏览器边界" value={blueprintDraft.browserBoundaryNotes} disabled={!selectedBlueprintCanEdit} multiline rows={3} onChange={(browserBoundaryNotes) => updateBlueprintDraft({ browserBoundaryNotes })} />
                          <Field label="写入边界" value={blueprintDraft.writeBoundaryNotes} disabled={!selectedBlueprintCanEdit} multiline rows={3} onChange={(writeBoundaryNotes) => updateBlueprintDraft({ writeBoundaryNotes })} />
                          <Field label="外发边界" value={blueprintDraft.externalSendBoundaryNotes} disabled={!selectedBlueprintCanEdit} multiline rows={3} onChange={(externalSendBoundaryNotes) => updateBlueprintDraft({ externalSendBoundaryNotes })} />
                          <Field label="长期记忆边界" value={blueprintDraft.longMemoryBoundaryNotes} disabled={!selectedBlueprintCanEdit} multiline rows={3} onChange={(longMemoryBoundaryNotes) => updateBlueprintDraft({ longMemoryBoundaryNotes })} />
                          <Field label="记忆/画像策略" value={blueprintDraft.memoryProfilePolicy} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(memoryProfilePolicy) => updateBlueprintDraft({ memoryProfilePolicy })} />
                          <Field label="维护生命周期" value={blueprintDraft.lifecycleNotes} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(lifecycleNotes) => updateBlueprintDraft({ lifecycleNotes })} />
                        </div>

                        <div className="mt-4">
                          <Field label="RULES" value={blueprintDraft.seedRulesText} disabled={!selectedBlueprintCanEdit} multiline rows={7} onChange={(seedRulesText) => updateBlueprintDraft({ seedRulesText })} />
                        </div>

	                        <div className="mt-4">
	                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="text-[11px] font-medium" style={{ color: 'var(--text-light)' }}>知识种子</div>
                            {selectedBlueprintCanEdit && (
                              <button
                                type="button"
                                onClick={handleAddKnowledgeSeed}
                                className="border rounded-lg inline-flex items-center gap-1.5 text-[11px]"
                                style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '5px 8px' }}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                添加
                              </button>
                            )}
                          </div>
                          {blueprintDraft.knowledgeSeeds.length === 0 && <EmptyLine text="暂无知识种子。" />}
                          <div className="flex flex-col gap-3">
                            {blueprintDraft.knowledgeSeeds.map((seed) => (
                              <div key={seed.id} className="rounded-lg border p-3" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)' }}>
                                <div className="grid gap-3 md:grid-cols-2">
                                  <Field label="知识标题" value={seed.title} disabled={!selectedBlueprintCanEdit} onChange={(title) => updateKnowledgeSeed(seed.id, { title })} />
                                  <Field label="证据引用" value={seed.evidenceRefsText} disabled={!selectedBlueprintCanEdit} onChange={(evidenceRefsText) => updateKnowledgeSeed(seed.id, { evidenceRefsText })} />
                                </div>
                                <div className="mt-3">
                                  <Field label="知识内容" value={seed.body} disabled={!selectedBlueprintCanEdit} multiline rows={4} onChange={(body) => updateKnowledgeSeed(seed.id, { body })} />
                                </div>
                                {selectedBlueprintCanEdit && (
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveKnowledgeSeed(seed.id)}
                                    className="mt-2 border rounded-lg inline-flex items-center gap-1.5 text-[11px]"
                                    style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '5px 8px' }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    移除
                                  </button>
                                )}
                              </div>
                            ))}
	                          </div>
	                        </div>

	                        {selectedBlueprint.migrationCandidates.length > 0 && (
	                          <div className="mt-4">
	                            <div className="mb-2 text-[11px] font-medium" style={{ color: 'var(--text-light)' }}>采用时迁移的知识</div>
	                            <div className="flex flex-col gap-2">
	                              {selectedBlueprint.migrationCandidates.map((relPath) => {
	                                const checked = selectedMigrationRelPaths.includes(relPath)
	                                  || Boolean(selectedBlueprint.adoption?.migratedCards.some((card) => card.from === relPath))
	                                return (
	                                  <label
	                                    key={relPath}
	                                    className="flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-[12px]"
	                                    style={{
	                                      borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
	                                      background: 'color-mix(in srgb, var(--surface-panel-bg) 34%, transparent)',
	                                      color: 'var(--text-muted)',
	                                    }}
	                                  >
	                                    <input
	                                      type="checkbox"
	                                      className="mt-0.5 h-3.5 w-3.5"
	                                      disabled={!selectedBlueprintCanConfirm}
	                                      checked={checked}
	                                      onChange={() => toggleMigrationRelPath(relPath)}
	                                    />
	                                    <span className="min-w-0 break-words">{relPath}</span>
	                                  </label>
	                                )
	                              })}
	                            </div>
	                          </div>
	                        )}

	                        {selectedBlueprint.adoption && (
	                          <div
	                            className="mt-4 rounded-lg border p-3 text-[12px] leading-5"
	                            style={{
	                              borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
	                              background: 'color-mix(in srgb, var(--surface-panel-bg) 34%, transparent)',
	                              color: 'var(--text-muted)',
	                            }}
	                          >
	                            <div className="font-medium" style={{ color: 'var(--text-title)' }}>
	                              已采用为 {selectedBlueprint.adoption.createdAgentId}
	                            </div>
	                            <div className="mt-1">采用时间：{formatDate(selectedBlueprint.adoption.adoptedAt)}</div>
	                            <div>路由卡：{selectedBlueprint.adoption.routingCardRelPath}</div>
	                            <div>知识种子：{selectedBlueprint.adoption.seedRelPaths.length}</div>
	                            <div>迁移知识：{selectedBlueprint.adoption.migratedCards.length}</div>
	                          </div>
	                        )}

                        <div className="mt-4 flex flex-wrap gap-2">
                          {selectedBlueprintCanEdit && (
                            <button
                              type="button"
                              disabled={!blueprintEditorDirty || blueprintEditorSaving}
                              onClick={() => void handleSaveBlueprint()}
                              className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-45"
                              style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 9px' }}
                            >
                              <Save className="h-3.5 w-3.5" />
                              保存蓝图
                            </button>
                          )}
                          {selectedBlueprintNeedsSemanticRefresh && (
                            <button
                              type="button"
                              disabled={blueprintActionId === selectedBlueprint.blueprintId}
                              onClick={() => void handleRefreshBlueprintSemanticReview(selectedBlueprint)}
                              className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-45"
                              style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 9px' }}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              刷新语义校验
                            </button>
                          )}
                          {selectedBlueprintCanConfirm ? (
                            <button
                              type="button"
                              disabled={blueprintActionId === selectedBlueprint.blueprintId}
                              onClick={() => void handleConfirmBlueprint(selectedBlueprint)}
                              className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-45"
                              style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 9px' }}
                            >
	                              <CheckCircle2 className="h-3.5 w-3.5" />
	                              {selectedBlueprint.status === 'confirmed' ? '继续创建' : '确认创建'}
	                            </button>
                          ) : (
                            <span className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] opacity-60" style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 9px' }}>
                              <ClipboardList className="h-3.5 w-3.5" />
                              {blueprintEditorDirty && selectedBlueprint.status === 'staged' && selectedBlueprint.admissionVerdict.kind === 'admit'
                                ? '先保存'
                                : !selectedBlueprintHasQualityPass && selectedBlueprint.admissionVerdict.kind === 'admit'
                                  ? '先修质量'
                                : selectedBlueprintNeedsSemanticRefresh
                                  ? '先刷新语义'
                                : selectedBlueprintSemanticBlocked
                                  ? '先修语义'
                                : selectedBlueprintNeedsUnverifiedAck && !unverifiedSemanticAck
                                  ? '先确认未校验'
                                : selectedBlueprint.status === 'confirmed'
                                  ? '已确认'
                                  : '先补齐信息'}
                            </span>
                          )}
                          {selectedBlueprint.status !== 'confirmed' && (
                            <button
                              type="button"
                              disabled={blueprintActionId === selectedBlueprint.blueprintId}
                              onClick={() => void handleRejectBlueprint(selectedBlueprint)}
                              className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-45"
                              style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 9px' }}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              拒绝
                            </button>
                          )}
	                        </div>
	                    </div>
	                  )}
	                </div>
	              )}
            </Section>

            <Section icon={<Route className="h-4 w-4" />} title="全局路由清单">
              {snapshot.routingCards.length === 0 && <EmptyLine text="暂无路由卡。" />}
              {routingCardError && (
                <div className="mb-3 text-[12px]" style={{ color: 'var(--color-red)' }}>{routingCardError}</div>
              )}
              <div className="flex flex-col gap-2">
                {snapshot.routingCards.map((card) => (
                  <div key={card.relPath} className="min-w-0 border-b pb-2 last:border-b-0 last:pb-0" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 12%, transparent)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>{card.title}</div>
                      <RouteStateText card={card} />
                    </div>
                    <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
                      {card.targetAgentId} · {(card.triggers ?? []).join(' / ') || '无触发词'}
                    </div>
                    {card.status === 'staged' && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {canApproveRoutingCard(card) ? (
                          <button
                            type="button"
                            onClick={() => void handleRoutingCardTransition(card, 'approve')}
                            disabled={routingCardActionRelPath === card.relPath}
                            className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
                            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 8px' }}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            启用路由
                          </button>
                        ) : (
                          <span className="text-[11px]" style={{ color: 'var(--text-light)' }}>
                            目标不可用或缺触发词，不能启用。
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleRoutingCardTransition(card, 'reject')}
                          disabled={routingCardActionRelPath === card.relPath}
                          className="border rounded-lg inline-flex items-center gap-1.5 text-[11px] disabled:opacity-50"
                          style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '6px 8px' }}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          拒绝
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            <Section icon={<Route className="h-4 w-4" />} title="路由试算">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                <Field
                  label="样例请求"
                  value={routingProbeText}
                  onChange={(value) => {
                    setRoutingProbeText(value)
                    setRoutingProbeError(null)
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleRoutingProbe()}
                  disabled={routingProbeLoading}
                  className="h-9 self-end border rounded-lg inline-flex items-center justify-center gap-1.5 text-[12px] disabled:opacity-50"
                  style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
                >
                  <Route className="h-3.5 w-3.5" />
                  试算路由
                </button>
              </div>

              {routingProbeError && <div className="mt-3 text-[12px]" style={{ color: 'var(--color-red)' }}>{routingProbeError}</div>}

              {routingProbeResult && (
                <div
                  className="mt-3 rounded-lg border p-3"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--surface-border) 14%, transparent)',
                    background: 'color-mix(in srgb, var(--surface-panel-bg) 34%, transparent)',
                  }}
                >
                  <div className="flex flex-wrap gap-1.5">
                    <Chip>{prerouteEffectLabel[routingProbeResult.effect]}</Chip>
                    <Chip>{prerouteTierLabel[routingProbeResult.decisionTier]}</Chip>
                    <Chip>{routingProbeResult.targetAgentName || routingProbeResult.targetAgentId}</Chip>
                    <Chip>{routingProbeResult.mode}</Chip>
                    {routingProbeResult.matchedKeywords.map((keyword) => <Chip key={keyword}>{keyword}</Chip>)}
                    {routingProbeResult.reasons.map((reason) => <Chip key={reason}>{prerouteReasonLabel[reason]}</Chip>)}
                    {routingProbeResult.fallbackReason && <Chip>{routingProbeResult.fallbackReason}</Chip>}
                  </div>
                  <div className="mt-3 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                    {routingProbeResult.cardRelPath
                      ? `路由卡：${routingProbeResult.cardRelPath}`
                      : routingProbeResult.conflicts.length > 0
                        ? `冲突卡：${routingProbeResult.conflicts.map((item) => item.cardRelPath).join(' / ')}`
                        : `目标：${routingProbeResult.targetAgentId}`}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {routingProbeResult.actions.map((action) => (
                      <RoutingActionChoice key={action.kind} action={action} />
                    ))}
                  </div>
                </div>
              )}
            </Section>

            <Section icon={<History className="h-4 w-4" />} title="最近分派 trace">
              {snapshot.recentPrerouteTraces.length === 0 && <EmptyLine text="暂无新会话分派记录。" />}
              <div className="flex flex-col gap-2">
                {snapshot.recentPrerouteTraces.map((trace) => (
                  <div key={trace.id} className="min-w-0 border-b pb-2 last:border-b-0 last:pb-0" style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 12%, transparent)' }}>
                    <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>{trace.firstMessagePreview || trace.id}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Chip>{trace.effect}</Chip>
                      <Chip>{trace.targetAgentId}</Chip>
                      {trace.reasons.map((reason) => <Chip key={reason}>{reason}</Chip>)}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        </div>
      )}
    </section>
  )
}
