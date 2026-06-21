import { useEffect, useMemo, useState } from 'react'
import { GitMerge, RefreshCw, UserX } from 'lucide-react'
import type { AgentRegistryKnowledgeCardData } from '../../types/electron'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
} from '../settings/settings-theme'

type AgentRegistryRecord = {
  id: string
  name: string
  charter: string | null
  status: 'active' | 'retired' | 'merged'
  parentAgentId: string | null
  derivationReason: string | null
  mergedIntoAgentId: string | null
  createdAt: string
}

type AgentRegistryKnowledgeCard = AgentRegistryKnowledgeCardData

const statusLabel: Record<AgentRegistryRecord['status'], string> = {
  active: '使用中',
  retired: '已退休',
  merged: '已合并',
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

export default function AgentRegistryPanel() {
  const [agents, setAgents] = useState<AgentRegistryRecord[]>([])
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({})
  const [migrationSelections, setMigrationSelections] = useState<Record<string, string[]>>({})
  const [knowledgeByAgent, setKnowledgeByAgent] = useState<Record<string, AgentRegistryKnowledgeCard[]>>({})
  const [loading, setLoading] = useState(false)
  const [actionRunning, setActionRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status === 'active'),
    [agents],
  )

  const loadAgents = async () => {
    if (!window.electronAPI?.agent?.listRegistry) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.agent.listRegistry()
      if (!result.success) throw new Error(result.error || '读取 Agent 列表失败')
      const next = result.data || []
      const nextKnowledgeByAgent: Record<string, AgentRegistryKnowledgeCard[]> = {}
      if (window.electronAPI?.agent?.listRegistryKnowledge) {
        await Promise.all(next
          .filter((agent) => agent.id !== 'butler' && agent.status === 'active')
          .map(async (agent) => {
            const cards = await window.electronAPI.agent.listRegistryKnowledge(agent.id)
            if (!cards.success) throw new Error(cards.error || `读取 ${agent.name} 的知识卡失败`)
            nextKnowledgeByAgent[agent.id] = cards.data || []
          }))
      }
      setAgents(next)
      setKnowledgeByAgent(nextKnowledgeByAgent)
    } catch (err) {
      setAgents([])
      setKnowledgeByAgent({})
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAgents()
  }, [])

  useEffect(() => {
    const onRegistryChanged = () => void loadAgents()
    window.addEventListener('ready:agent-registry-changed', onRegistryChanged)
    return () => window.removeEventListener('ready:agent-registry-changed', onRegistryChanged)
  }, [])

  const toggleMigration = (agentId: string, relPath: string, checked: boolean) => {
    const selected = new Set(migrationSelections[agentId] || [])
    if (checked) selected.add(relPath)
    else selected.delete(relPath)
    setMigrationSelections((current) => ({ ...current, [agentId]: [...selected] }))
  }

  const updateStatus = async (agent: AgentRegistryRecord, status: 'retired' | 'merged') => {
    if (!window.electronAPI?.agent?.updateRegistryStatus) return
    const defaultMergeTarget = activeAgents.find((item) => item.id !== agent.id)?.id || ''
    const target = status === 'merged' ? mergeTargets[agent.id] || defaultMergeTarget : ''
    const label = status === 'retired' ? `退休 ${agent.name}` : `把 ${agent.name} 合并到 ${target}`
    if (!window.confirm(`确认${label}？`)) return
    setActionRunning(`${status}:${agent.id}`)
    setError(null)
    try {
      const result = await window.electronAPI.agent.updateRegistryStatus({
        id: agent.id,
        status,
        mergedIntoAgentId: status === 'merged' ? target : null,
        migrateCardRelPaths: status === 'merged' ? migrationSelections[agent.id] || [] : [],
      })
      if (!result.success) throw new Error(result.error || '更新 Agent 状态失败')
      await loadAgents()
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
          <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)', margin: 0 }}>
            Agent 生命周期
          </h3>
          <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}>
            专项 Agent 的退休和合并需要显式确认；合并时可迁移知识卡，未迁移资产仍留在原目录。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadAgents()}
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

      <div className="mt-5 flex flex-col gap-2">
        {loading && (
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            加载中...
          </div>
        )}
        {!loading && agents.length === 0 && (
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            暂无 Agent 记录。
          </div>
        )}
        {agents.map((agent) => {
          const canAct = agent.id !== 'butler' && agent.status === 'active'
          const mergeOptions = activeAgents.filter((item) => item.id !== agent.id)
          const selectedTarget = mergeTargets[agent.id] || mergeOptions[0]?.id || ''
          const knowledgeCards = knowledgeByAgent[agent.id] || []
          const selectedMigrations = migrationSelections[agent.id] || []
          return (
            <div
              key={agent.id}
              className="border rounded-lg"
              style={{
                borderColor: 'var(--border-default)',
                padding: '12px 14px',
                background: 'color-mix(in srgb, var(--surface-panel-bg) 50%, transparent)',
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
                      {agent.name}
                    </div>
                    <span className="rounded-md text-[11px]" style={{ color: 'var(--text-muted)', background: 'color-mix(in srgb, currentColor 9%, transparent)', padding: '3px 7px' }}>
                      {statusLabel[agent.status]}
                    </span>
                    <span className="rounded-md text-[11px]" style={{ color: 'var(--text-light)', background: 'color-mix(in srgb, currentColor 9%, transparent)', padding: '3px 7px' }}>
                      {agent.id}
                    </span>
                  </div>
                  <div className="text-[12px] leading-5 mt-2" style={{ color: 'var(--text-muted)' }}>
                    {agent.charter || '未填写职责'}；创建于 {formatDate(agent.createdAt)}
                    {agent.parentAgentId ? `；来源 ${agent.parentAgentId}` : ''}
                    {agent.mergedIntoAgentId ? `；已并入 ${agent.mergedIntoAgentId}` : ''}
                  </div>
                  {agent.derivationReason && (
                    <div className="text-[11px] leading-5 mt-1 break-all" style={{ color: 'var(--text-light)' }}>
                      {agent.derivationReason}
                    </div>
                  )}
                </div>
	                {canAct && (
	                  <div className="flex shrink-0 flex-col items-end gap-2">
	                    <div className="flex items-center gap-2">
	                      <button
	                        type="button"
	                        disabled={actionRunning === `retired:${agent.id}`}
	                        onClick={() => void updateStatus(agent, 'retired')}
	                        className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
	                        style={{ ...SETTINGS_DANGER_BUTTON_STYLE, padding: '7px 10px' }}
	                      >
	                        <UserX className="w-3.5 h-3.5" />
	                        退休
	                      </button>
	                      {mergeOptions.length > 0 && (
	                        <>
	                          <select
	                            value={selectedTarget}
	                            onChange={(event) => setMergeTargets((current) => ({ ...current, [agent.id]: event.target.value }))}
	                            className="border rounded-lg text-[12px]"
	                            style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '7px 10px' }}
	                          >
	                            {mergeOptions.map((target) => (
	                              <option key={target.id} value={target.id}>{target.name}</option>
	                            ))}
	                          </select>
	                          <button
	                            type="button"
	                            disabled={!selectedTarget || actionRunning === `merged:${agent.id}`}
	                            onClick={() => void updateStatus({ ...agent }, 'merged')}
	                            className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
	                            style={{ ...SETTINGS_PRIMARY_BUTTON_STYLE, padding: '7px 10px' }}
	                          >
	                            <GitMerge className="w-3.5 h-3.5" />
	                            合并
	                          </button>
	                        </>
	                      )}
	                    </div>
                    {mergeOptions.length > 0 && knowledgeCards.length > 0 && (
                      <div className="w-64 text-left">
                        <div className="text-[11px] mb-1" style={{ color: 'var(--text-light)' }}>
                          合并时迁移
                        </div>
                        <div className="flex max-h-28 flex-col gap-1 overflow-auto pr-1">
                          {knowledgeCards.map((card) => (
                            <label key={card.relPath} className="flex items-start gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              <input
                                type="checkbox"
                                checked={selectedMigrations.includes(card.relPath)}
                                onChange={(event) => toggleMigration(agent.id, card.relPath, event.target.checked)}
                                className="mt-0.5"
                              />
                              <span className="min-w-0">
                                <span style={{ color: 'var(--text-title)' }}>{card.title}</span>
                                <span className="block truncate" style={{ color: 'var(--text-light)' }}>{card.relPath}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
