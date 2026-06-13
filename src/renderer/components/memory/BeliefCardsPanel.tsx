import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BeliefCardSettingsItemData, BeliefCardSettingsSnapshotData } from '../../types/electron'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
} from '../settings/settings-theme'

interface BeliefCardsPanelProps {
  snapshot: BeliefCardSettingsSnapshotData | null
  loading: boolean
  error: Error | null
  actionRunning: string | null
  onRefresh: () => Promise<void>
  onTransition: (relPath: string, action: 'approve' | 'reject') => Promise<void>
  onSetKnowledgeSystemEnabled: (enabled: boolean) => Promise<void>
}

const statusLabel: Record<BeliefCardSettingsItemData['status'], string> = {
  staged: '待确认',
  active: '已生效',
  rejected: '已驳回',
  invalid: '格式异常',
}

function formatDate(value: string | null): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function scopeLabel(scopeId: string): string {
  return scopeId === 'global' ? '全局' : scopeId.replace(/^agent:/, 'Agent ')
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'red' | 'green' }) {
  const color = tone === 'red'
    ? 'var(--color-red)'
    : tone === 'green'
      ? 'var(--color-green)'
      : tone === 'blue'
        ? 'var(--color-blue)'
        : 'var(--text-muted)'
  return (
    <span
      className="inline-flex items-center rounded-md text-[11px] font-medium"
      style={{
        color,
        background: 'color-mix(in srgb, currentColor 9%, transparent)',
        padding: '3px 7px',
      }}
    >
      {children}
    </span>
  )
}

function CardRow({
  card,
  actionRunning,
  onTransition,
}: {
  card: BeliefCardSettingsItemData
  actionRunning: string | null
  onTransition: (relPath: string, action: 'approve' | 'reject') => Promise<void>
}) {
  const isBusy = actionRunning?.endsWith(`:${card.relPath}`) ?? false
  const approveLabel = card.source?.startsWith('possible-update-of:')
    ? '合并'
    : card.source?.startsWith('possible-risk-update-of:')
      ? '标记已处理'
      : '确认'
  return (
    <div
      className="border rounded-lg"
      style={{
        borderColor: 'var(--border-default)',
        padding: '12px 14px',
        background: 'color-mix(in srgb, var(--surface-panel-bg) 50%, transparent)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <Pill tone={card.status === 'staged' ? 'blue' : card.status === 'invalid' ? 'red' : 'neutral'}>
              {statusLabel[card.status]}
            </Pill>
            <Pill>{scopeLabel(card.scopeId)}</Pill>
            {card.isSiteCard && <Pill tone={card.siteRiskLevel === 'high' ? 'red' : 'green'}>{card.siteRiskLevel === 'high' ? '高风险站点' : '低风险站点'}</Pill>}
            {card.isRiskSuggestion && <Pill tone="red">风险变更建议</Pill>}
          </div>
          <div className="text-[13px] font-medium leading-5" style={{ color: 'var(--text-title)' }}>
            {card.title}
          </div>
          <div className="text-[12px] leading-5 mt-1" style={{ color: 'var(--text-muted)' }}>
            {card.description}
          </div>
          <div className="text-[11px] leading-5 mt-2 break-all" style={{ color: 'var(--text-light)' }}>
            {card.relPath}
          </div>
        </div>
        {card.status === 'staged' && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              title="确认并生效"
              disabled={isBusy}
              onClick={() => void onTransition(card.relPath, 'approve').catch((error) => alert(error instanceof Error ? error.message : String(error)))}
              className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
              style={{ ...SETTINGS_PRIMARY_BUTTON_STYLE, padding: '7px 10px' }}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {approveLabel}
            </button>
            <button
              type="button"
              title="驳回"
              disabled={isBusy}
              onClick={() => void onTransition(card.relPath, 'reject').catch((error) => alert(error instanceof Error ? error.message : String(error)))}
              className="border rounded-lg inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50"
              style={{ ...SETTINGS_DANGER_BUTTON_STYLE, padding: '7px 10px' }}
            >
              <XCircle className="w-3.5 h-3.5" />
              驳回
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function BeliefCardsPanel({
  snapshot,
  loading,
  error,
  actionRunning,
  onRefresh,
  onTransition,
  onSetKnowledgeSystemEnabled,
}: BeliefCardsPanelProps) {
  const stagedCards = snapshot?.cards.filter((card) => card.status === 'staged') ?? []
  const siteCards = snapshot?.cards.filter((card) => card.isSiteCard) ?? []
  const highRiskSites = siteCards.filter((card) => card.siteRiskLevel === 'high')

  return (
    <section
      className="glass-surface-card border"
      style={{
        ...SETTINGS_CARD_STYLE,
        padding: '18px 22px',
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" style={{ color: 'var(--color-blue)' }} />
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)', margin: 0 }}>
              信念卡确认
            </h3>
          </div>
          <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}>
            系统学到的新知识先停在待确认区，确认后才会进入 Agent 的实际记忆。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="border rounded-lg inline-flex items-center gap-1.5 text-[12px]"
          style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '8px 11px' }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          刷新
        </button>
      </div>

      {loading && (
        <div className="mt-5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      )}

      {error && (
        <div className="mt-5 text-[13px]" style={{ color: 'var(--color-red)' }}>
          错误: {error.message}
        </div>
      )}

      {snapshot && (
        <div className="mt-5 flex flex-col gap-5">
          <div
            className="border rounded-lg"
            style={{
              borderColor: 'var(--border-default)',
              padding: '12px 14px',
              background: 'color-mix(in srgb, var(--surface-panel-bg) 50%, transparent)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
                  知识系统总开关
                </div>
                <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  关闭后停止知识注入和卡片工具，文件不会被删除。
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-body)' }}>
                <input
                  type="checkbox"
                  checked={snapshot.knowledgeSystemEnabled}
                  disabled={actionRunning === 'knowledge-system'}
                  onChange={(event) => void onSetKnowledgeSystemEnabled(event.target.checked).catch((err) => alert(err instanceof Error ? err.message : String(err)))}
                />
                {snapshot.knowledgeSystemEnabled ? '已开启' : '已关闭'}
              </label>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
              <Pill tone="blue">待确认 {snapshot.summary.staged}</Pill>
              <Pill tone="green">已生效 {snapshot.summary.active}</Pill>
              <Pill>Agent 专属 {snapshot.summary.agentScoped}</Pill>
              <Pill tone={snapshot.summary.invalid > 0 ? 'red' : 'neutral'}>异常 {snapshot.summary.invalid}</Pill>
            </div>
            <div className="text-[12px] leading-5 mt-4" style={{ color: 'var(--text-muted)' }}>
              维护：旧记忆维护{snapshot.maintenance.lifecycleRunning ? '运行中' : '已停止'}，
              上次运行 {formatDate(snapshot.maintenance.lastLifecycleMaintenanceAt)}；
              LLM 维护回合 {snapshot.maintenance.llmRound
                ? `${snapshot.maintenance.llmRound.decision === 'skip' ? '跳过' : '运行'}，写入 ${snapshot.maintenance.llmRound.applied}，驳回 ${snapshot.maintenance.llmRound.rejected}`
                : '尚未记录'}。
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-3">
              <h4 className="text-[13px] font-medium" style={{ color: 'var(--text-title)', margin: 0 }}>
                待确认卡片
              </h4>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {stagedCards.length} 张
              </span>
            </div>
            {stagedCards.length === 0 ? (
              <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                没有待确认卡片。
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {stagedCards.map((card) => (
                  <CardRow key={card.relPath} card={card} actionRunning={actionRunning} onTransition={onTransition} />
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4" style={{ color: highRiskSites.length > 0 ? 'var(--color-red)' : 'var(--text-muted)' }} />
              <h4 className="text-[13px] font-medium" style={{ color: 'var(--text-title)', margin: 0 }}>
                站点卡风险
              </h4>
            </div>
            <div className="text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
              站点卡 {snapshot.summary.siteCards} 张，高风险 {snapshot.summary.highRiskSiteCards} 张，风险变更建议 {snapshot.summary.riskSuggestions} 张。风险等级只按代码权威判断，卡片正文不能改拦截规则。
            </div>
            {highRiskSites.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {highRiskSites.slice(0, 8).map((card) => (
                  <Pill key={card.relPath} tone="red">{card.site ?? card.relPath}</Pill>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
