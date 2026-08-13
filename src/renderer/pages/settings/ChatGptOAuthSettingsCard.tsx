import { useCallback, useEffect, useState } from 'react'
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

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.settings.getChatGptOAuthStatus()
    if (result.success && result.data) {
      setStatus(result.data)
      setError(result.data.error || '')
      return
    }
    setError(result.error || '无法读取 ChatGPT OAuth 状态')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const authorize = useCallback(async () => {
    setBusy('authorize')
    setError('')
    try {
      const result = await window.electronAPI.settings.connectChatGptOAuth()
      if (!result.success || !result.data) {
        throw new Error(result.error || 'ChatGPT 登录失败')
      }
      setStatus(result.data)
      await onConnected(result.data)
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : 'ChatGPT 登录失败'
      await refresh()
      setError(message)
    } finally {
      setBusy(null)
    }
  }, [onConnected, refresh])

  const resume = useCallback(async () => {
    setBusy('resume')
    setError('')
    try {
      const result = await window.electronAPI.settings.resumeChatGptOAuth()
      if (!result.success || !result.data) {
        throw new Error(result.error || 'ChatGPT 连接恢复失败')
      }
      setStatus(result.data)
      await onConnected(result.data)
    } catch (resumeError) {
      const message = resumeError instanceof Error ? resumeError.message : 'ChatGPT 连接恢复失败'
      await refresh()
      setError(message)
    } finally {
      setBusy(null)
    }
  }, [onConnected, refresh])

  const disconnect = useCallback(async () => {
    if (!window.confirm('断开后会删除 Ready 自己保存的 ChatGPT OAuth 凭证。继续吗？')) return
    setBusy('disconnect')
    setError('')
    try {
      const result = await window.electronAPI.settings.disconnectChatGptOAuth()
      if (!result.success || !result.data) {
        throw new Error(result.error || '断开 ChatGPT 登录失败')
      }
      setStatus(result.data)
      await onDisconnected()
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : '断开 ChatGPT 登录失败')
    } finally {
      setBusy(null)
    }
  }, [onDisconnected])

  const ready = status?.state === 'ready'
  const connected = status?.connected === true
  const authorizationExpired = status?.state === 'error'
  const statusText = ready
    ? `已连接 · ${status.models.length} 个模型`
    : authorizationExpired
      ? '登录已失效，需要重新授权'
      : connected
        ? '登录有效，服务待恢复'
        : status
          ? '未授权'
          : '正在读取状态'

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
            {!ready && (
              <button
                type="button"
                onClick={() => void (connected && !authorizationExpired ? resume() : authorize())}
                disabled={busy !== null || status === null}
                className="inline-flex items-center gap-2 rounded-full font-semibold transition-[filter,transform] hover:brightness-95 active:scale-[0.98] disabled:opacity-50"
                style={{ ...SETTINGS_FLAT_BUTTON_STYLE, padding: '10px 15px', borderRadius: 999 }}
              >
                {(busy === 'authorize' || busy === 'resume') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy === 'authorize'
                  ? '等待浏览器授权'
                  : busy === 'resume'
                    ? '正在恢复'
                    : connected && !authorizationExpired
                      ? '恢复并使用'
                      : authorizationExpired
                        ? '重新授权'
                        : '使用 ChatGPT 登录'}
              </button>
            )}
            {connected && !authorizationExpired && (
              <button
                type="button"
                onClick={() => void authorize()}
                disabled={busy !== null}
                className="rounded-full px-3 py-2 text-[12px] font-semibold disabled:opacity-50"
                style={{ color: 'var(--text-muted)' }}
              >
                {busy === 'authorize' ? '等待浏览器授权' : '重新授权'}
              </button>
            )}
            {active && status?.connected && (
              <button
                type="button"
                onClick={() => void disconnect()}
                disabled={busy !== null}
                className="rounded-full px-3 py-2 text-[12px] font-semibold disabled:opacity-50"
                style={{ color: 'var(--color-red)' }}
              >
                {busy === 'disconnect' ? '正在断开' : '断开并删除凭证'}
              </button>
            )}
            <span
              className="text-[12px] font-semibold"
              style={{ color: ready ? 'var(--color-green)' : 'var(--text-muted)' }}
            >
              {statusText}
            </span>
          </div>
          {error && <div className="text-[12px] leading-5" style={{ color: 'var(--color-red)' }}>{error}</div>}
        </div>
      )}
    />
  )
}
