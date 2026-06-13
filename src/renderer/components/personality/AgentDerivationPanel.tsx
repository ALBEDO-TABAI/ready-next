import { useEffect, useState } from 'react'
import { CheckCircle2, GitBranchPlus, RefreshCw, XCircle } from 'lucide-react'
import type { AgentDerivationCandidateData } from '../../types/electron'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_FLAT_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
} from '../settings/settings-theme'

type Draft = {
  specialistId: string
  name: string
  charter: string
  seedRulesText: string
  routingTriggersText: string
  activateRouting: boolean
  selectedMigrations: string[]
}

function draftFromCandidate(candidate: AgentDerivationCandidateData): Draft {
  return {
    specialistId: candidate.defaultSpecialistId,
    name: candidate.defaultName,
    charter: candidate.defaultCharter,
    seedRulesText: candidate.defaultSeedRulesText,
    routingTriggersText: candidate.defaultRoutingTriggers.join(', '),
    activateRouting: false,
    selectedMigrations: [],
  }
}

function parseTriggers(value: string): string[] {
  return value
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export default function AgentDerivationPanel() {
  const [candidates, setCandidates] = useState<AgentDerivationCandidateData[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(false)
  const [actionRunning, setActionRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadCandidates = async () => {
    if (!window.electronAPI?.agent?.listDerivationCandidates) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.agent.listDerivationCandidates()
      if (!result.success) throw new Error(result.error || '读取派生候选失败')
      const next = result.data || []
      setCandidates(next)
      setDrafts((current) => {
        const merged: Record<string, Draft> = {}
        for (const candidate of next) {
          merged[candidate.candidateRelPath] = current[candidate.candidateRelPath] || draftFromCandidate(candidate)
        }
        return merged
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCandidates()
  }, [])

  const updateDraft = (relPath: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({
      ...current,
      [relPath]: {
        ...(current[relPath] || draftFromCandidate(candidates.find((item) => item.candidateRelPath === relPath)!)),
        ...patch,
      },
    }))
  }

  const toggleMigration = (relPath: string, migrationRelPath: string, checked: boolean) => {
    const draft = drafts[relPath]
    if (!draft) return
    const selected = new Set(draft.selectedMigrations)
    if (checked) selected.add(migrationRelPath)
    else selected.delete(migrationRelPath)
    updateDraft(relPath, { selectedMigrations: [...selected] })
  }

  const confirmDerivation = async (candidate: AgentDerivationCandidateData) => {
    if (!window.electronAPI?.agent?.confirmDerivation) return
    const draft = drafts[candidate.candidateRelPath] || draftFromCandidate(candidate)
    if (!window.confirm(`确认创建 ${draft.name}？`)) return
    setActionRunning(candidate.candidateRelPath)
    setError(null)
    try {
      const result = await window.electronAPI.agent.confirmDerivation({
        candidateRelPath: candidate.candidateRelPath,
        specialistId: draft.specialistId,
        name: draft.name,
        charter: draft.charter,
        seedRulesText: draft.seedRulesText,
        routingTriggers: parseTriggers(draft.routingTriggersText),
        activateRouting: draft.activateRouting,
        migrateCardRelPaths: draft.selectedMigrations,
      })
      if (!result.success) throw new Error(result.error || '创建 Agent 失败')
      window.dispatchEvent(new CustomEvent('ready:agent-registry-changed'))
      await loadCandidates()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionRunning(null)
    }
  }

  const rejectDerivation = async (candidate: AgentDerivationCandidateData) => {
    if (!window.electronAPI?.agent?.rejectDerivation) return
    if (!window.confirm(`驳回 ${candidate.title}？`)) return
    setActionRunning(candidate.candidateRelPath)
    setError(null)
    try {
      const result = await window.electronAPI.agent.rejectDerivation(candidate.candidateRelPath)
      if (!result.success) throw new Error(result.error || '驳回派生候选失败')
      setCandidates(result.data || [])
      setDrafts((current) => {
        const next: Record<string, Draft> = {}
        for (const item of result.data || []) {
          next[item.candidateRelPath] = current[item.candidateRelPath] || draftFromCandidate(item)
        }
        return next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionRunning(null)
    }
  }

  return (
    <section className="glass-surface-card border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 22px' }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <GitBranchPlus className="w-4 h-4" style={{ color: 'var(--color-blue)' }} />
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)', margin: 0 }}>
              Agent 派生确认
            </h3>
          </div>
          <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}>
            满足证据门槛的候选卡可以在这里确认创建为专项 Agent。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadCandidates()}
          className="border rounded-lg inline-flex items-center gap-1.5 text-[12px]"
          style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          刷新
        </button>
      </div>

      {error && (
        <div className="mt-4 text-[13px]" style={{ color: 'var(--color-red)' }}>
          {error}
        </div>
      )}

      <div className="mt-5 flex flex-col gap-3">
        {loading && (
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            加载中...
          </div>
        )}
        {!loading && candidates.length === 0 && (
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            暂无可派生候选。
          </div>
        )}
        {candidates.map((candidate) => {
          const draft = drafts[candidate.candidateRelPath] || draftFromCandidate(candidate)
          const busy = actionRunning === candidate.candidateRelPath
          const canConfirm = draft.specialistId.trim() && draft.name.trim() && draft.seedRulesText.trim()
          return (
            <div
              key={candidate.candidateRelPath}
              className="border rounded-lg"
              style={{
                borderColor: 'var(--border-default)',
                padding: '14px',
                background: 'color-mix(in srgb, var(--surface-panel-bg) 50%, transparent)',
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
                    {candidate.title}
                  </div>
                  <div className="text-[12px] leading-5 mt-1" style={{ color: 'var(--text-muted)' }}>
                    {candidate.description}
                  </div>
                  <div className="text-[11px] leading-5 mt-2 break-all" style={{ color: 'var(--text-light)' }}>
                    {candidate.candidateRelPath}；证据 {candidate.evidenceDates.slice(0, 3).join(' / ')}
                  </div>
                </div>
	                <div className="flex shrink-0 items-center gap-2">
	                  <button
	                    type="button"
	                    disabled={busy}
	                    onClick={() => void rejectDerivation(candidate)}
	                    className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
	                    style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
	                  >
	                    <XCircle className="w-3.5 h-3.5" />
	                    驳回
	                  </button>
	                  <button
	                    type="button"
	                    disabled={!canConfirm || busy}
	                    onClick={() => void confirmDerivation(candidate)}
	                    className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
	                    style={{ ...SETTINGS_PRIMARY_BUTTON_STYLE, padding: '8px 11px' }}
	                  >
	                    <CheckCircle2 className="w-3.5 h-3.5" />
	                    创建
	                  </button>
	                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                <label className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  Agent ID
                  <input
                    value={draft.specialistId}
                    onChange={(event) => updateDraft(candidate.candidateRelPath, { specialistId: event.target.value })}
                    className="mt-1 w-full border rounded-lg text-[13px]"
                    style={{ ...SETTINGS_FLAT_INPUT_STYLE, padding: '8px 10px' }}
                  />
                </label>
                <label className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  名称
                  <input
                    value={draft.name}
                    onChange={(event) => updateDraft(candidate.candidateRelPath, { name: event.target.value })}
                    className="mt-1 w-full border rounded-lg text-[13px]"
                    style={{ ...SETTINGS_FLAT_INPUT_STYLE, padding: '8px 10px' }}
                  />
                </label>
              </div>

              <label className="block text-[12px] mt-3" style={{ color: 'var(--text-muted)' }}>
                职责
                <input
                  value={draft.charter}
                  onChange={(event) => updateDraft(candidate.candidateRelPath, { charter: event.target.value })}
                  className="mt-1 w-full border rounded-lg text-[13px]"
                  style={{ ...SETTINGS_FLAT_INPUT_STYLE, padding: '8px 10px' }}
                />
              </label>

              <label className="block text-[12px] mt-3" style={{ color: 'var(--text-muted)' }}>
                RULES.md
                <textarea
                  value={draft.seedRulesText}
                  onChange={(event) => updateDraft(candidate.candidateRelPath, { seedRulesText: event.target.value })}
                  className="mt-1 w-full border rounded-lg text-[12px] leading-5"
                  rows={6}
                  style={{ ...SETTINGS_FLAT_INPUT_STYLE, padding: '9px 10px', resize: 'vertical' }}
                />
              </label>

              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 mt-3">
                <label className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  路由触发词
                  <input
                    value={draft.routingTriggersText}
                    onChange={(event) => updateDraft(candidate.candidateRelPath, { routingTriggersText: event.target.value })}
                    className="mt-1 w-full border rounded-lg text-[13px]"
                    style={{ ...SETTINGS_FLAT_INPUT_STYLE, padding: '8px 10px' }}
                  />
                </label>
                <label className="inline-flex items-center gap-2 self-end text-[13px]" style={{ color: 'var(--text-body)' }}>
                  <input
                    type="checkbox"
                    checked={draft.activateRouting}
                    onChange={(event) => updateDraft(candidate.candidateRelPath, { activateRouting: event.target.checked })}
                  />
                  立即生效
                </label>
              </div>

              {candidate.migrationCandidates.length > 0 && (
                <div className="mt-4">
                  <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--text-title)' }}>
                    知识迁移清单
                  </div>
                  <div className="flex flex-col gap-2">
                    {candidate.migrationCandidates.map((item) => (
                      <label key={item.relPath} className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        <input
                          type="checkbox"
                          checked={draft.selectedMigrations.includes(item.relPath)}
                          onChange={(event) => toggleMigration(candidate.candidateRelPath, item.relPath, event.target.checked)}
                          className="mt-1"
                        />
                        <span className="min-w-0">
                          <span style={{ color: 'var(--text-title)' }}>{item.title}</span>
                          <span className="block break-all" style={{ color: 'var(--text-light)' }}>{item.relPath}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
