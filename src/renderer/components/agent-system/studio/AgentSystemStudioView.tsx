import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, FileText, RefreshCw, XCircle } from 'lucide-react'
import type {
  AgentSystemStudioContentEditProposal,
  AgentSystemStudioSnapshot,
} from '../../../../shared/agent-system-studio'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
} from '../../settings/settings-theme'

const statusLabel: Record<string, string> = {
  active: '历史记录',
  disabled: '已停用记录',
  retired: '已归档',
  merged: '已合并记录',
}

export default function AgentSystemStudioView() {
  const [snapshot, setSnapshot] = useState<AgentSystemStudioSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.agent.getSystemStudioSnapshot()
      if (!result.success || !result.data) throw new Error(result.error || '读取历史资料失败')
      setSnapshot(result.data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const settleProposal = useCallback(async (
    proposal: AgentSystemStudioContentEditProposal,
    action: 'confirm' | 'reject',
  ) => {
    setBusyProposalId(proposal.proposalId)
    setError(null)
    try {
      const result = action === 'confirm'
        ? await window.electronAPI.agent.confirmSystemStudioContentEdit(proposal.proposalId)
        : await window.electronAPI.agent.rejectSystemStudioContentEdit(proposal.proposalId)
      if (!result.success) throw new Error(result.error || '处理文件修改提案失败')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyProposalId(null)
    }
  }, [refresh])

  return (
    <section className="glass-surface-card border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 22px' }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4" style={{ color: 'var(--color-blue)' }} />
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)', margin: 0 }}>
              专项资料审计
            </h3>
          </div>
          <p className="mt-1.5 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
            只展示旧专项资料和待确认的文件修改提案；这些记录不会改变当前 Codex，也不会自动创建或分配 Agent。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border text-[12px] disabled:opacity-50"
          style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      {error && <div className="mt-4 text-[12px]" style={{ color: 'var(--color-red)' }}>{error}</div>}
      {loading && !snapshot && <div className="mt-5 text-[13px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>}
      {snapshot && (
        <div className="mt-5 flex flex-col gap-3">
          {snapshot.agents.length === 0 && (
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>暂无专项历史资料。</div>
          )}
          {snapshot.agents.map((agent) => {
            const staged = agent.contentEditProposals.filter((proposal) => proposal.status === 'staged')
            return (
              <div key={agent.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-default)' }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>{agent.name}</span>
                  <span className="text-[11px]" style={{ color: 'var(--text-light)' }}>{agent.id}</span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{statusLabel[agent.status] || agent.status}</span>
                </div>
                <div className="mt-2 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                  规则文件 {agent.rules.exists ? '已存档' : '未存档'} · 基础文件 {agent.foundation.exists ? '已存档' : '未存档'} · 信念资料 {agent.contentSummary.knowledgeCards} 条
                </div>
                {staged.length > 0 && (
                  <div className="mt-3 flex flex-col gap-2">
                    {staged.map((proposal) => (
                      <div key={proposal.proposalId} className="flex items-start justify-between gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-default)' }}>
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium" style={{ color: 'var(--text-title)' }}>待确认文件修改</div>
                          <div className="mt-1 break-all text-[11px]" style={{ color: 'var(--text-light)' }}>{proposal.targetRelPath}</div>
                          {proposal.provenance.note && <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{proposal.provenance.note}</div>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            disabled={busyProposalId === proposal.proposalId}
                            onClick={() => void settleProposal(proposal, 'confirm')}
                            className="inline-flex items-center gap-1 rounded-lg border text-[11px] disabled:opacity-50"
                            style={{ ...SETTINGS_PRIMARY_BUTTON_STYLE, padding: '6px 9px' }}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />确认写入
                          </button>
                          <button
                            type="button"
                            disabled={busyProposalId === proposal.proposalId}
                            onClick={() => void settleProposal(proposal, 'reject')}
                            className="inline-flex items-center gap-1 rounded-lg border text-[11px] disabled:opacity-50"
                            style={{ ...SETTINGS_DANGER_BUTTON_STYLE, padding: '6px 9px' }}
                          >
                            <XCircle className="h-3.5 w-3.5" />驳回
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
