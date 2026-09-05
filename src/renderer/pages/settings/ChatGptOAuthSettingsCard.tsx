import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ChatGptOAuthStatus } from '../../../shared/chatgpt-oauth'
import type { AIReasoningEffort } from '../../../shared/ai-providers'
import {
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_FLAT_INPUT_STYLE,
} from '../../components/settings/settings-theme'
import { AISettingsFieldCard } from './settings-shared'

export function ChatGptOAuthSettingsCard({
  active,
  reasoningEffort,
  onReasoningEffortChange,
  onConnected,
  onDisconnected,
}: {
  active: boolean
  reasoningEffort: AIReasoningEffort
  onReasoningEffortChange: (effort: AIReasoningEffort) => void
  onConnected: (status: ChatGptOAuthStatus) => void | Promise<void>
  onDisconnected: () => void | Promise<void>
}) {
  const [status, setStatus] = useState<ChatGptOAuthStatus | null>(null)
  const [busy, setBusy] = useState<'authorize' | 'resume' | 'disconnect' | null>(null)
  const [error, setError] = useState('')

  const callbacks = useRef({ onConnected, onDisconnected })
  callbacks.current = { onConnected, onDisconnected }
  const previous = useRef<ChatGptOAuthStatus | null>(null)
  const readVersion = useRef(0)
  const mounted = useRef(true)
  const actionPending = useRef(false)

  const refresh = useCallback(async () => {
    const version = ++readVersion.current
    try {
      const result = await window.electronAPI.settings.getChatGptOAuthStatus()
      if (!mounted.current || version !== readVersion.current) return
      if (!result.success || !result.data) throw new Error(result.error || '无法读取登录状态，请点击重试。')
      const wasPending = previous.current?.state === 'connecting'
      const changed = previous.current?.state !== result.data.state || previous.current?.operation?.phase !== result.data.operation?.phase
      previous.current = result.data
      setStatus(result.data)
      if (result.data.error || changed) setError(result.data.error || '')
      if (wasPending && result.data.state === 'ready') await callbacks.current.onConnected(result.data)
    } catch (error) {
      if (mounted.current && version === readVersion.current) setError(error instanceof Error ? error.message : '无法读取登录状态')
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let reading = false
    const poll = async () => {
      if (reading) return
      reading = true
      try { await refresh() } finally { reading = false }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 1000)
    return () => { mounted.current = false; ++readVersion.current; window.clearInterval(timer) }
  }, [refresh])

  const runAction = async (action: 'authorize' | 'resume' | 'disconnect') => {
    if (actionPending.current || status?.operation) return
    if (action === 'disconnect' && !window.confirm('断开后会删除 Ready 自己保存的 ChatGPT OAuth 凭证。继续吗？')) return
    actionPending.current = true
    ++readVersion.current
    setBusy(action)
    setError('')
    try {
      const api = window.electronAPI.settings
      const result = await (action === 'authorize' ? api.connectChatGptOAuth() : action === 'resume' ? api.resumeChatGptOAuth() : api.disconnectChatGptOAuth())
      if (!mounted.current) return
      if (!result.success || !result.data) throw new Error(result.error || '连接操作失败，请重试。')
      if (action === 'disconnect') await callbacks.current.onDisconnected()
      else await callbacks.current.onConnected(result.data)
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : '连接操作失败')
    } finally {
      actionPending.current = false
      if (mounted.current) { setBusy(null); await refresh() }
    }
  }

  const operation = status?.operation
  const pending = Boolean(busy || operation || status?.state === 'connecting')
  const ready = status?.state === 'ready' && !pending
  const connected = status?.connected === true
  const phaseText = {
    preparing: '正在准备登录…', waiting_browser: '请在浏览器完成授权，完成后会自动更新。',
    exchanging: '已收到授权，正在确认登录…', starting_service: '登录已确认，正在加载可用模型…',
    saving_profile: '正在保存连接设置…', cancelling: '正在取消登录…',
  }
  const statusText = operation ? phaseText[operation.phase]
    : busy === 'resume' || status?.state === 'connecting' ? '正在恢复连接…'
      : busy === 'authorize' ? '正在准备登录…'
        : busy === 'disconnect' ? '正在断开…'
          : ready ? `已连接 · ${status?.models.length} 个模型，可以开始对话`
            : status?.state === 'error' ? (connected ? '连接未完成，可尝试恢复' : '登录未完成，可重新登录')
              : connected ? '已保存登录，连接待恢复' : status ? '未登录' : '正在读取状态…'

  const controlLogin = async (action: 'cancel' | 'reopen') => {
    if (!operation) return
    try {
      const result = await (action === 'cancel'
        ? window.electronAPI.settings.cancelChatGptOAuth(operation.id)
        : window.electronAPI.settings.reopenChatGptOAuth(operation.id))
      if (!result.success) throw new Error(result.error || '操作失败，请重试。')
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '操作失败') }
    await refresh()
  }

  return (
    <AISettingsFieldCard
      title="ChatGPT 账号登录（实验）"
      wide
      description="非官方本机接入：授权页面显示的主体是 Codex，不是 Ready；凭证等同密码。OpenAI 没有把它发布为第三方通用模型 OAuth，接口可能随时失效。"
      control={(
        <div className="flex flex-col gap-3">
          <div
            className="rounded-xl border px-3 py-2.5 text-[12px] leading-5"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-orange) 28%, transparent)',
              background: 'color-mix(in srgb, var(--color-orange) 8%, transparent)',
              color: 'var(--text-body)',
            }}
          >
            仅绑定 127.0.0.1，并把凭证隔离保存在 Ready 数据目录；不会读取或覆盖 Codex CLI 的登录。官方 API Key 预设会原样保留。
          </div>
          {active && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2.5" style={{ borderColor: 'var(--border-subtle)' }}>
              <div>
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-title)' }}>推理强度</div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-light)' }}>强度越高，通常思考更充分，但响应也会更慢。</div>
              </div>
              <select
                value={reasoningEffort}
                onChange={(event) => onReasoningEffortChange(event.target.value as AIReasoningEffort)}
                className="rounded-lg border px-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 cursor-pointer"
                style={{
                  ...SETTINGS_FLAT_INPUT_STYLE,
                  padding: '8px 28px 8px 12px',
                }}
              >
                <option value="none">不额外推理</option>
                <option value="low">快速</option>
                <option value="medium">标准</option>
                <option value="high">较强</option>
                <option value="xhigh">最强</option>
              </select>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {!ready && !pending && status && (
              <button type="button" onClick={() => void runAction(connected ? 'resume' : 'authorize')}
                className="rounded-full font-semibold" style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '10px 15px', borderRadius: 999 }}>
                {connected ? '恢复连接并使用' : '使用 ChatGPT 登录'}
              </button>
            )}
            {connected && !pending && (
              <button type="button" onClick={() => void runAction('authorize')} className="rounded-full px-3 py-2 text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>重新授权</button>
            )}
            {active && connected && !pending && (
              <button type="button" onClick={() => void runAction('disconnect')} className="rounded-full px-3 py-2 text-[12px] font-semibold" style={{ color: 'var(--color-red)' }}>断开并删除凭证</button>
            )}
            <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-[12px] font-semibold" style={{ color: ready ? 'var(--color-green)' : 'var(--text-muted)' }}>
              {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{statusText}{operation?.phase === 'waiting_browser' ? `（已等待 ${Math.floor((Date.now() - operation.startedAt) / 1000)} 秒）` : ''}
            </span>
            {operation?.canReopen && operation.phase === 'waiting_browser' && (
              <button type="button" onClick={() => void controlLogin('reopen')} className="text-[12px] underline">重新打开授权页面</button>
            )}
            {operation && !['saving_profile', 'cancelling'].includes(operation.phase) && (
              <button type="button" onClick={() => void controlLogin('cancel')} className="text-[12px] underline">取消登录</button>
            )}
            {!status && error && <button type="button" onClick={() => void refresh()} className="text-[12px] underline">重试读取状态</button>}
          </div>
          {error && <div className="text-[12px] leading-5" style={{ color: 'var(--color-red)' }}>{error}</div>}
        </div>
      )}
    />
  )
}
