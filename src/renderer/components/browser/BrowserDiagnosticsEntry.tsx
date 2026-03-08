import { useState } from 'react'
import { Activity, ChevronDown, ChevronUp, Shield, ShieldOff, Workflow } from 'lucide-react'
import type { AdblockState, BrowserDiagnosticsData } from '../../modules/browser/types'
import type { BrowserTab } from '../../stores/useBrowserTabs'

interface BrowserDiagnosticsEntryProps {
  activeTab: BrowserTab | null
  adblockState: AdblockState
  diagnostics: BrowserDiagnosticsData | null
  currentDomain: string
  currentDomainAdblockWhitelisted: boolean
  onRefreshAdblock: () => void | Promise<void>
  onSyncBounds: () => void
}

function formatAuditTime(value?: number | null): string {
  if (!value) return '未记录'
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function BrowserDiagnosticsEntry({
  activeTab,
  adblockState,
  diagnostics,
  currentDomain,
  currentDomainAdblockWhitelisted,
  onRefreshAdblock,
  onSyncBounds,
}: BrowserDiagnosticsEntryProps) {
  const [expanded, setExpanded] = useState(false)
  if (!activeTab) return null

  const adblockLabel = !adblockState.enabled
    ? '全局关闭'
    : currentDomainAdblockWhitelisted
      ? '当前站点已放行'
      : '正在拦截'

  return (
    <div
      className="pointer-events-auto absolute right-4 top-4 z-20 w-[248px] rounded-[14px] border p-3"
      style={{
        background: 'rgba(255,255,255,0.88)',
        borderColor: 'var(--border-default)',
        boxShadow: 'var(--shadow-sm)',
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-light)' }}>
            Browser Diagnostics
          </div>
          <div className="truncate text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
            {activeTab.title || activeTab.url || '未命名标签页'}
          </div>
          <div className="truncate text-[11px]" style={{ color: 'var(--text-light)' }}>
            {currentDomain || activeTab.url || 'about:blank'}
          </div>
        </div>
        <button
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--color-blue)' }}
        >
          {expanded ? <ChevronUp style={{ width: 12, height: 12 }} /> : <ChevronDown style={{ width: 12, height: 12 }} />}
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      <div className="space-y-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2">
            <Workflow style={{ width: 12, height: 12 }} />
            标签所有权
          </span>
          <span style={{ color: 'var(--text-title)' }}>
            {activeTab.owner === 'agent' ? 'Agent' : 'Manual'}
            {activeTab.required ? ' · Required' : ''}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2">
            <Activity style={{ width: 12, height: 12 }} />
            活动状态
          </span>
          <span style={{ color: 'var(--text-title)' }}>
            {activeTab.activity || 'idle'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2">
            {adblockState.enabled ? <Shield style={{ width: 12, height: 12 }} /> : <ShieldOff style={{ width: 12, height: 12 }} />}
            Adblock
          </span>
          <span style={{ color: 'var(--text-title)' }}>{adblockLabel}</span>
        </div>
      </div>

      <div
        className="mt-3 rounded-[10px] px-3 py-2 text-[10px]"
        style={{ background: 'var(--surface-card-bg)', color: 'var(--text-light)' }}
      >
        <div>规则版本：{adblockState.rulesVersion}</div>
        <div>网络拦截：{adblockState.networkBlockedCount}</div>
        <div>最近审计：{formatAuditTime(activeTab.lastAuditedAt)}</div>
      </div>

      <button
        onClick={onSyncBounds}
        className="mt-3 w-full rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
        style={{
          borderColor: 'var(--border-default)',
          color: 'var(--text-title)',
        }}
      >
        同步 BrowserView 边界
      </button>

      {expanded && diagnostics && (
        <div
          className="mt-3 rounded-[10px] border px-3 py-2 text-[10px]"
          style={{
            borderColor: 'var(--border-default)',
            background: 'rgba(255,255,255,0.72)',
            color: 'var(--text-secondary)',
          }}
        >
          <div>Host Driver：{diagnostics.hostDriver}</div>
          <div>标签总数：{diagnostics.tabCount}</div>
          <div>激活标签：{diagnostics.activeTabId || '无'}</div>
          <div>Preview：{diagnostics.preview.url || '未打开'}</div>
          {diagnostics.preview.url ? (
            <div>
              预览状态：
              {diagnostics.preview.loading ? ' loading' : ' idle'}
              {diagnostics.preview.error ? ` · ${diagnostics.preview.error}` : ''}
            </div>
          ) : null}
          <div className="mt-2 truncate">日志路径：{diagnostics.diagnosticsLogPath}</div>
          <button
            onClick={() => void onRefreshAdblock()}
            className="mt-2 rounded-full px-2 py-1 text-[10px] transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--color-blue)' }}
          >
            刷新诊断
          </button>
          {diagnostics.recentLogs.length > 0 ? (
            <div
              className="mt-2 max-h-32 overflow-auto rounded-[8px] px-2 py-1 font-mono text-[9px]"
              style={{ background: 'var(--surface-card-bg)', color: 'var(--text-light)' }}
            >
              {diagnostics.recentLogs.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
