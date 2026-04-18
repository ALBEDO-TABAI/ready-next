import { useMemoryStats, useMemoryLifecycle } from '../../hooks/useMemory'
import { Database, Layers, Tag, Archive, Activity, Play, CheckCircle2, Loader2 } from 'lucide-react'
import { SETTINGS_CARD_STYLE, SETTINGS_PRIMARY_BUTTON_STYLE } from '../settings/settings-theme'

const panelCardStyle = {
  ...SETTINGS_CARD_STYLE
}

const primaryButtonStyle = {
  ...SETTINGS_PRIMARY_BUTTON_STYLE
}

export default function MemoryStatsCard() {
  const { stats, loading: statsLoading, error: statsError } = useMemoryStats()
  const {
    status,
    loading: lifecycleLoading,
    error: lifecycleError,
    maintenanceRunning,
    runMaintenance
  } = useMemoryLifecycle()

  const handleRunMaintenance = async () => {
    try {
      const result = await runMaintenance()
      alert(`维护完成:\n- 已归档: ${result.archivedCount}\n- 已清理: ${result.prunedCount}`)
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
          borderRadius: 24,
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
          borderRadius: 24,
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
        borderRadius: 24,
        padding: 24
      }}
    >
      <div className="flex items-center gap-2 mb-6">
        <Database className="w-5 h-5" style={{ color: 'var(--color-blue)' }} />
        <h3 className="text-[15px] font-medium" style={{ color: 'var(--text-title)' }}>
          记忆统计
        </h3>
      </div>

      {stats && (
        <div className="space-y-6">
          <div>
            <div
              className="text-[11px] uppercase tracking-wider mb-2"
              style={{ color: 'var(--text-light)' }}
            >
              总记忆数
            </div>
            <div className="text-[32px] font-bold" style={{ color: 'var(--text-title)' }}>
              {stats.totalMemories}
            </div>
          </div>

          <div>
            <div
              className="text-[11px] uppercase tracking-wider mb-3"
              style={{ color: 'var(--text-light)' }}
            >
              <Layers className="w-3 h-3 inline mr-1" />
              按层级分布
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>L0 (常量)</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.byLayer.l0}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>L1 (会话)</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.byLayer.l1}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>L2 (触发器)</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.byLayer.l2}
                </span>
              </div>
            </div>
          </div>

          <div>
            <div
              className="text-[11px] uppercase tracking-wider mb-3"
              style={{ color: 'var(--text-light)' }}
            >
              来源分类
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>常驻记忆</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.bySourceType.resident_agent}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>用户偏好</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.bySourceType.resident_user}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>当前任务</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.bySourceType.scope_memory}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>触发规则</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.bySourceType.trigger_rule}
                </span>
              </div>
            </div>
          </div>

          <div>
            <div
              className="text-[11px] uppercase tracking-wider mb-3"
              style={{ color: 'var(--text-light)' }}
            >
              <Tag className="w-3 h-3 inline mr-1" />
              按类别分布
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>摘要</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.byCategory.summary}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>学习</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.byCategory.learning}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>触发器</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.byCategory.trigger}
                </span>
              </div>
              <div className="flex justify-between items-center text-[13px]">
                <span style={{ color: 'var(--text-body)' }}>规则</span>
                <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                  {stats.byCategory.rule}
                </span>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t space-y-2" style={{ borderColor: 'var(--border-default)' }}>
            <div className="flex justify-between items-center text-[13px]">
              <span className="flex items-center gap-1" style={{ color: 'var(--text-body)' }}>
                <Archive className="w-3 h-3" />
                已归档
              </span>
              <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                {stats.archivedCount}
              </span>
            </div>
            <div className="flex justify-between items-center text-[13px]">
              <span className="flex items-center gap-1" style={{ color: 'var(--text-body)' }}>
                <Activity className="w-3 h-3" />
                平均访问次数
              </span>
              <span className="font-medium" style={{ color: 'var(--text-title)' }}>
                {stats.avgAccessCount.toFixed(1)}
              </span>
            </div>
          </div>
        </div>
      )}

      {status && (
        <div className="mt-6 pt-6 border-t" style={{ borderColor: 'var(--border-default)' }}>
          <div
            className="text-[11px] uppercase tracking-wider mb-3"
            style={{ color: 'var(--text-light)' }}
          >
            生命周期状态
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  background: status.running ? 'var(--color-green)' : 'var(--text-muted)'
                }}
              />
              <span className="text-[13px]" style={{ color: 'var(--text-body)' }}>
                {status.running ? '运行中' : '已停止'}
              </span>
            </div>
            {status.lastMaintenanceAt && (
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                上次维护: {new Date(status.lastMaintenanceAt).toLocaleString()}
              </div>
            )}
            <button
              onClick={() => void handleRunMaintenance()}
              disabled={maintenanceRunning}
              className="w-full border rounded-xl transition-[opacity,background-color,border-color] duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
              style={{
                ...primaryButtonStyle,
                padding: '10px 16px',
                fontSize: '13px'
              }}
            >
              {maintenanceRunning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  运行中...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  运行维护
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
