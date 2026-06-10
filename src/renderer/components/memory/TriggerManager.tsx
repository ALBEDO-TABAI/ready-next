import { useTriggers } from '../../hooks/useMemory'
import type { TriggerDefinition } from '../../types/electron'
import { CheckCircle2, XCircle, Code, Zap, TrendingUp } from 'lucide-react'
import { SETTINGS_CARD_STYLE } from '../settings/settings-theme'

const panelCardStyle = {
  ...SETTINGS_CARD_STYLE,
}

export default function TriggerManager() {
  const { triggers, loading, error, updateTrigger } = useTriggers()

  const handleToggleEnabled = async (trigger: TriggerDefinition) => {
    try {
      await updateTrigger(trigger.id, { enabled: !trigger.enabled })
    } catch (err) {
      alert(`更新失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-[13px]" style={{ color: 'var(--color-red)' }}>
          错误: {error.message}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div
        className="border-b"
        style={{
          borderColor: 'var(--border-default)',
          padding: '16px 20px',
        }}
      >
        <h3 className="text-[15px] font-medium" style={{ color: 'var(--text-title)' }}>
          触发器管理
        </h3>
        <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
          当模式匹配时自动加载相关记忆
        </p>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ padding: '12px' }}>
        {triggers.length === 0 ? (
          <div
            className="flex items-center justify-center h-full text-[13px]"
            style={{ color: 'var(--text-muted)' }}
          >
            暂无触发器
          </div>
        ) : (
          <div className="space-y-3">
            {triggers.map((trigger) => (
              <div
                key={trigger.id}
                className="glass-surface-card border transition-[background-color,border-color,color] duration-200"
                style={{
                  ...panelCardStyle,
                  borderRadius: 12,
                  padding: '16px 18px',
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
                        {trigger.label}
                      </div>
                      {trigger.module && (
                        <span
                          className="text-[11px] font-medium px-2 py-0.5 rounded"
                          style={{
                            background: 'var(--color-purple-light)',
                            color: 'var(--color-purple)',
                          }}
                        >
                          {trigger.module}
                        </span>
                      )}
                      {trigger.blocking && (
                        <span
                          className="text-[11px] font-medium px-2 py-0.5 rounded flex items-center gap-1"
                          style={{
                            background: 'var(--color-red-light)',
                            color: 'var(--color-red)',
                          }}
                        >
                          <Zap className="w-3 h-3" />
                          阻塞
                        </span>
                      )}
                    </div>
                    <div
                      className="text-[12px] font-mono px-2 py-1 rounded mb-2 inline-block"
                      style={{
                        background: 'color-mix(in srgb, var(--surface-panel-bg) 60%, transparent)',
                        color: 'var(--text-body)',
                      }}
                    >
                      <Code className="w-3 h-3 inline mr-1" />
                      /{trigger.pattern}/{trigger.patternFlags}
                    </div>
                    <div className="flex items-center gap-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <span className="flex items-center gap-1">
                        <TrendingUp className="w-3 h-3" />
                        优先级 {trigger.priority}
                      </span>
                      <span>命中 {trigger.hitCount} 次</span>
                      {trigger.lastHitAt && (
                        <span>
                          最后命中: {new Date(trigger.lastHitAt * 1000).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={trigger.enabled}
                      onChange={() => void handleToggleEnabled(trigger)}
                      className="rounded"
                    />
                    {trigger.enabled ? (
                      <span className="flex items-center gap-1" style={{ color: 'var(--color-green)' }}>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        已启用
                      </span>
                    ) : (
                      <span className="flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                        <XCircle className="w-3.5 h-3.5" />
                        已禁用
                      </span>
                    )}
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
