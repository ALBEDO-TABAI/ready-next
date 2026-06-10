import { Database, Play, Loader2 } from 'lucide-react'
import type { MemoryLifecycleStatus, MemoryMaintenanceResult, MemoryStats } from '../../types/electron'
import { SETTINGS_CARD_STYLE, SETTINGS_PRIMARY_BUTTON_STYLE } from '../settings/settings-theme'

const panelCardStyle = {
  ...SETTINGS_CARD_STYLE
}

const primaryButtonStyle = {
  ...SETTINGS_PRIMARY_BUTTON_STYLE
}

const GROUP_DIVIDER = '1px solid color-mix(in srgb, var(--border-default) 55%, transparent)'

interface MemoryStatsCardProps {
  stats: MemoryStats | null
  statsLoading: boolean
  statsError: Error | null
  status: MemoryLifecycleStatus | null
  lifecycleLoading: boolean
  lifecycleError: Error | null
  maintenanceRunning: boolean
  onRunMaintenance: () => Promise<MemoryMaintenanceResult>
}

function StatGroup({ title, rows }: { title: string; rows: { label: string; value: string | number }[] }) {
  return (
    <div style={{ borderTop: GROUP_DIVIDER, paddingTop: 16 }}>
      <div className="text-[11px] tracking-[0.08em] mb-2" style={{ color: 'var(--text-light)' }}>
        {title}
      </div>
      <div>
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between py-[5px] text-[13px]">
            <span style={{ color: 'var(--text-body)' }}>{row.label}</span>
            <span className="font-medium tabular-nums" style={{ color: 'var(--text-title)' }}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function MemoryStatsCard({
  stats,
  statsLoading,
  statsError,
  status,
  lifecycleLoading,
  lifecycleError,
  maintenanceRunning,
  onRunMaintenance
}: MemoryStatsCardProps) {
  const handleRunMaintenance = async () => {
    try {
      const result = await onRunMaintenance()
      alert(
        `维护完成:\n- 已归档（任务/按需）: ${result.archivedL1Count} / ${result.archivedL2Count}\n- 已清理: ${result.prunedCount}`
      )
    } catch (err) {
      alert(`维护失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (statsLoading || lifecycleLoading) {
    return (
      <div
        className="glass-surface-card border flex items-center justify-center"
        style={{
          ...panelCardStyle,
          padding: 24,
          minHeight: 400
        }}
      >
        <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      </div>
    )
  }

  if (statsError || lifecycleError) {
    return (
      <div
        className="glass-surface-card border flex items-center justify-center"
        style={{
          ...panelCardStyle,
          padding: 24,
          minHeight: 400
        }}
      >
        <div className="text-[13px]" style={{ color: 'var(--color-red)' }}>
          错误: {(statsError || lifecycleError)?.message}
        </div>
      </div>
    )
  }

  return (
    <div
      className="glass-surface-card border"
      style={{
        ...panelCardStyle,
        padding: '22px 22px 20px'
      }}
    >
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4" style={{ color: 'var(--color-blue)' }} />
        <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>
          记忆统计
        </h3>
      </div>

      {stats && (
        <div className="mt-5 flex flex-col gap-5">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>总记忆数</span>
            <span className="text-[28px] font-bold leading-none tabular-nums" style={{ color: 'var(--text-title)' }}>
              {stats.totalMemories}
            </span>
          </div>

          <StatGroup
            title="记忆分布"
            rows={[
              { label: '长期保留', value: stats.byLayer.l0 },
              { label: '任务沉淀', value: stats.byLayer.l1 },
              { label: '按需唤起', value: stats.byLayer.l2 },
            ]}
          />

          <StatGroup
            title="来源分类"
            rows={[
              { label: '常驻记忆', value: stats.bySourceType.resident_agent },
              { label: '用户偏好', value: stats.bySourceType.resident_user },
              { label: '当前任务', value: stats.bySourceType.scope_memory },
              { label: '按需唤起', value: stats.bySourceType.trigger_rule },
            ]}
          />

          <StatGroup
            title="按类别分布"
            rows={[
              { label: '摘要', value: stats.byCategory.summary },
              { label: '学习', value: stats.byCategory.learning },
              { label: '唤起线索', value: stats.byCategory.trigger },
              { label: '规则', value: stats.byCategory.rule },
            ]}
          />

          <StatGroup
            title="归档与访问"
            rows={[
              { label: '已归档', value: stats.archivedCount },
              { label: '平均访问次数', value: stats.avgAccessCount.toFixed(1) },
            ]}
          />
        </div>
      )}

      {status && (
        <div className="mt-5" style={{ borderTop: GROUP_DIVIDER, paddingTop: 16 }}>
          <div className="text-[11px] tracking-[0.08em] mb-2" style={{ color: 'var(--text-light)' }}>
            生命周期状态
          </div>
          <div className="flex items-center justify-between py-[5px]">
            <span className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-body)' }}>
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: status.running ? 'var(--color-green)' : 'var(--text-muted)' }}
              />
              {status.running ? '运行中' : '已停止'}
            </span>
            {status.lastMaintenanceAt && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                上次维护 {new Date(status.lastMaintenanceAt).toLocaleString()}
              </span>
            )}
          </div>
          <button
            onClick={() => void handleRunMaintenance()}
            disabled={maintenanceRunning}
            className="mt-3 border rounded-xl transition-[opacity,background-color,border-color,filter] duration-200 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-95 active:scale-[0.98]"
            style={primaryButtonStyle}
          >
            {maintenanceRunning ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                运行中...
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                运行维护
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
