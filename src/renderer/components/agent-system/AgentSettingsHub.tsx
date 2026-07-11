import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, GitBranch, SlidersHorizontal } from 'lucide-react'
import PersonalityEditor from '../personality/PersonalityEditor'
import AgentDerivationPanel from '../personality/AgentDerivationPanel'
import AgentRegistryPanel from '../personality/AgentRegistryPanel'
import AgentSystemStudio from './AgentSystemStudio'
import { SETTINGS_FLAT_INPUT_STYLE } from '../settings/settings-theme'
import { DELIVERY_MODE_SETTING_KEY, isDeliveryMode } from '../../../shared/dynamic-delivery'

// 设置页「Agent」单入口容器：把原先分散的 Agent / Agent 人格 / Agent 系统 三个 Tab
// 合并成一个 Tab，内部用子导航分区，默认首屏直接进「Agent 管理」做渐进披露。
// 见 docs/superpowers/plans/2026-06-22-agent-identity-unification-and-settings-merge-implementation.md §4.3 / §7.2。
//
// A↔B seam（§7.4 / §7.5）：本容器只负责"摆放"叶子面板与子导航，不碰叶子内部逻辑。
// 叶子组件（PersonalityEditor / AgentRegistryPanel / AgentDerivationPanel / AgentSystemStudio）
// 仍是 propless 自包含 default export，由 Workstream B 改其内部与后端。
// B 若拆分 AgentSystemStudio，把"知识与维护"作为第 4 个子区插入 SUB_VIEWS 即可。

type SubViewId = 'manage' | 'behavior' | 'advanced'

const SUB_VIEWS: { id: SubViewId; label: string; icon: React.ElementType; hint: string }[] = [
  { id: 'manage', label: 'Agent 管理', icon: Bot, hint: '人格、知识、路由与启用状态都在这里管理' },
  { id: 'behavior', label: '行为', icon: SlidersHorizontal, hint: '后台播报、新会话路由与知识系统总开关' },
  { id: 'advanced', label: '派生与系统', icon: GitBranch, hint: '派生确认、路由卡、蓝图与分派 trace' },
  // B 拆分 AgentSystemStudio 后，在此追加：{ id: 'knowledge', label: '知识与维护', ... }
]

const PREROUTE_OPTIONS: { value: 'off' | 'suggest' | 'auto'; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'suggest', label: '建议（默认）' },
  { value: 'auto', label: '自动' },
]

// 与 Settings.tsx 的 SettingsSwitch 视觉一致的本地开关（后者未导出，复刻其样式）。
function HubSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label
      className="group/switch inline-flex shrink-0 items-center"
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}
    >
      <span
        className="relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-[background-color,border-color,filter] group-hover/switch:brightness-[0.96]"
        style={{
          borderColor: checked
            ? 'color-mix(in srgb, var(--color-blue) 42%, transparent)'
            : 'color-mix(in srgb, var(--surface-border) 68%, transparent)',
          background: checked
            ? 'color-mix(in srgb, var(--color-blue) 78%, var(--surface-floating-bg) 22%)'
            : 'color-mix(in srgb, var(--surface-floating-bg) 72%, var(--bg-content) 28%)',
        }}
      >
        <span
          className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: checked ? 'translateX(20px)' : 'translateX(3px)' }}
        />
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
    </label>
  )
}

function BehaviorRow({
  label,
  description,
  control,
  error,
}: {
  label: string
  description: string
  control: React.ReactNode
  error?: string | null
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>{label}</div>
        <div className="mt-0.5 text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>{description}</div>
        {error && <div className="mt-1 text-[11px]" style={{ color: 'var(--color-red, #d44)' }}>{error}</div>}
      </div>
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  )
}

export function BehaviorSection() {
  const [autoNarration, setAutoNarration] = useState(true)
  const [prerouteMode, setPrerouteMode] = useState<'off' | 'suggest' | 'auto'>('suggest')
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(true)
  const [deliveryMode, setDeliveryMode] = useState<'standard' | 'adaptive'>('adaptive')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const setError = useCallback((key: string, message: string | null) => {
    setErrors((prev) => {
      const next = { ...prev }
      if (message) next[key] = message
      else delete next[key]
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const settings = window.electronAPI?.settings
      const cards = window.electronAPI?.memoryCards
      if (settings?.getAgentAutoNarrationContinuation) {
        const r = await settings.getAgentAutoNarrationContinuation()
        if (!cancelled && r?.success) setAutoNarration(typeof r.data === 'boolean' ? r.data : r.data !== 'false')
      }
      if (settings?.getAgentSessionPrerouteMode) {
        const r = await settings.getAgentSessionPrerouteMode()
        if (!cancelled && r?.success && typeof r.data === 'string') setPrerouteMode(r.data as 'off' | 'suggest' | 'auto')
      }
      if (cards?.list) {
        const r = await cards.list()
        if (!cancelled && r?.success && r.data) setKnowledgeEnabled(Boolean(r.data.knowledgeSystemEnabled))
      }
      if (settings?.get) {
        const r = await settings.get(DELIVERY_MODE_SETTING_KEY)
        if (!cancelled && r?.success && isDeliveryMode(r.data) && r.data !== 'thorough') setDeliveryMode(r.data)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const onToggleNarration = useCallback(async (next: boolean) => {
    const api = window.electronAPI?.settings?.setAgentAutoNarrationContinuation
    if (!api) { setError('narration', '设置 IPC 不可用'); return }
    const result = await api(next)
    if (result.success) { setAutoNarration(next); setError('narration', null) }
    else setError('narration', result.error || '设置保存失败')
  }, [setError])

  const onChangePreroute = useCallback(async (next: 'off' | 'suggest' | 'auto') => {
    const api = window.electronAPI?.settings?.setAgentSessionPrerouteMode
    if (!api) { setError('preroute', '设置 IPC 不可用'); return }
    const result = await api(next)
    if (result.success) { setPrerouteMode(next); setError('preroute', null) }
    else setError('preroute', result.error || '设置保存失败')
  }, [setError])

  const onToggleKnowledge = useCallback(async (next: boolean) => {
    const api = window.electronAPI?.memoryCards?.setKnowledgeSystemEnabled
    if (!api) { setError('knowledge', '知识系统 IPC 不可用'); return }
    const result = await api(next)
    if (result.success && result.data) { setKnowledgeEnabled(Boolean(result.data.knowledgeSystemEnabled)); setError('knowledge', null) }
    else setError('knowledge', result.error || '设置保存失败')
  }, [setError])

  const onChangeDeliveryMode = useCallback(async (next: 'standard' | 'adaptive') => {
    const api = window.electronAPI?.settings?.set
    if (!api) { setError('delivery', '设置 IPC 不可用'); return }
    const result = await api(DELIVERY_MODE_SETTING_KEY, next)
    if (result.success) { setDeliveryMode(next); setError('delivery', null) }
    else setError('delivery', result.error || '设置保存失败')
  }, [setError])

  return (
    <div className="flex flex-col gap-6">
      <BehaviorRow
        label="后台任务自动播报"
        description="没有活跃对话运行时，后台任务完成后自动生成一条结果播报。"
        error={errors.narration}
        control={<HubSwitch checked={autoNarration} onChange={(v) => { void onToggleNarration(v) }} />}
      />
      <BehaviorRow
        label="新会话智能路由"
        description="新会话首条消息按“状态优先/先例次之”判定更合适的专项 agent：建议=显示建议条由你决定；自动=先例命中直接转给对应 agent（可一键改回）。派生新 agent 永远需要你确认。"
        error={errors.preroute}
        control={
          <select
            value={prerouteMode}
            onChange={(e) => { void onChangePreroute(e.target.value as 'off' | 'suggest' | 'auto') }}
            className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
            style={{ ...SETTINGS_FLAT_INPUT_STYLE, padding: '9px 32px 9px 14px', width: 'auto', minWidth: 136 }}
          >
            {PREROUTE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        }
      />
      <BehaviorRow
        label="Dynamic Delivery"
        description="标准模式直接执行；自适应模式只在任务确实能从协作和复核中获益时启用。输入框的“彻底”只影响下一次发送。"
        error={errors.delivery}
        control={
          <select
            value={deliveryMode}
            data-ready-delivery-mode="true"
            onChange={(event) => { void onChangeDeliveryMode(event.target.value as 'standard' | 'adaptive') }}
            className="rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30"
            style={{ ...SETTINGS_FLAT_INPUT_STYLE, padding: '9px 32px 9px 14px', minWidth: 136 }}
          >
            <option value="standard">标准</option>
            <option value="adaptive">自适应</option>
          </select>
        }
      />
      <BehaviorRow
        label="知识系统总开关"
        description="关闭后所有信念卡 / 站点卡知识不再注入 prompt，仅保留基础人格与规则。"
        error={errors.knowledge}
        control={<HubSwitch checked={knowledgeEnabled} onChange={(v) => { void onToggleKnowledge(v) }} />}
      />
    </div>
  )
}

export default function AgentSettingsHub() {
  const [subView, setSubView] = useState<SubViewId>('manage')
  // §7.1 统一刷新契约：容器订阅 ready:agent-registry-changed，任一写操作后重挂管理区列表，
  // 保证人格列表 / registry 列表跨面板同步（registry 面板自身也监听，此处覆盖人格面板）。
  const [refreshNonce, setRefreshNonce] = useState(0)
  useEffect(() => {
    const onChanged = () => setRefreshNonce((n) => n + 1)
    window.addEventListener('ready:agent-registry-changed', onChanged)
    return () => window.removeEventListener('ready:agent-registry-changed', onChanged)
  }, [])

  const activeHint = useMemo(() => SUB_VIEWS.find((v) => v.id === subView)?.hint ?? '', [subView])

  return (
    <div className="flex flex-col gap-5">
      {/* 子导航 */}
      <div
        className="flex items-center gap-1 rounded-xl border p-1"
        style={{ borderColor: 'color-mix(in srgb, var(--surface-border) 18%, transparent)', background: 'color-mix(in srgb, var(--surface-card-bg) 6%, transparent)' }}
      >
        {SUB_VIEWS.map((view) => {
          const Icon = view.icon
          const active = view.id === subView
          return (
            <button
              key={view.id}
              onClick={() => setSubView(view.id)}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-[background-color,color] duration-150"
              style={{
                color: active ? 'var(--color-blue)' : 'var(--text-muted)',
                background: active ? 'color-mix(in srgb, var(--color-blue-light) 70%, var(--surface-card-bg) 30%)' : 'transparent',
              }}
            >
              <Icon className="h-4 w-4" strokeWidth={1.8} />
              {view.label}
            </button>
          )
        })}
      </div>
      {activeHint && <div className="-mt-1 text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>{activeHint}</div>}

      {/* 子区内容 */}
      {subView === 'manage' && (
        <div key={refreshNonce} className="flex flex-col gap-5">
          <PersonalityEditor />
          <AgentRegistryPanel />
        </div>
      )}
      {subView === 'behavior' && <BehaviorSection />}
      {subView === 'advanced' && (
        <div className="flex flex-col gap-5">
          <AgentDerivationPanel />
          <AgentSystemStudio />
        </div>
      )}
    </div>
  )
}
