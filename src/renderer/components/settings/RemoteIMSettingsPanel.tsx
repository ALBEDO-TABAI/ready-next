import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, CheckCircle2, ChevronDown, ChevronUp, Eye, EyeOff, Loader2, MessageSquare, RefreshCcw, Send, Trash2, XCircle } from 'lucide-react'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
} from './settings-theme'

type IMTab = 'imessage' | 'telegram' | 'feishu'

type ChannelAdapterType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'

interface ChannelData {
  id: string
  type: ChannelAdapterType
  name: string
  enabled: boolean
  config: Record<string, unknown>
  lastError?: string | null
  lastSeenAt?: string | null
}

interface RuntimeStatusData {
  sidecar?: {
    status?: string
    port?: number
    error?: string
  }
  heartbeat?: {
    adapters?: Array<{
      id: string
      type: ChannelAdapterType
      status?: 'starting' | 'running' | 'stopped' | 'error'
      healthy: boolean
      lastBeatAt?: string
      error?: string
    }>
  }
}

interface RemoteAttachmentCacheStatsData {
  totalFiles: number
  totalBytes: number
  targetPath: string
  channels: Array<{
    channelId: string
    files: number
    bytes: number
  }>
}

function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '•'.repeat(value.length)
  return `${value.slice(0, 4)}${'•'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`
}

const panelCardStyle = {
  ...SETTINGS_CARD_STYLE,
}

const fieldStyle = {
  ...SETTINGS_INPUT_STYLE,
  padding: '15px 18px',
}

const secondaryButtonStyle = {
  ...SETTINGS_SECONDARY_BUTTON_STYLE,
}

const primaryButtonStyle = {
  ...SETTINGS_PRIMARY_BUTTON_STYLE,
}

export default function RemoteIMSettingsPanel() {
  const [tab, setTab] = useState<IMTab>('feishu')
  const [channels, setChannels] = useState<ChannelData[]>([])
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusData | null>(null)
  const [cacheStats, setCacheStats] = useState<RemoteAttachmentCacheStatsData | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('')

  const [telegramToken, setTelegramToken] = useState('')
  const [feishuAppId, setFeishuAppId] = useState('')
  const [feishuAppSecret, setFeishuAppSecret] = useState('')
  const [feishuVerificationToken, setFeishuVerificationToken] = useState('')
  const [feishuEncryptKey, setFeishuEncryptKey] = useState('')
  const [showFeishuSecret, setShowFeishuSecret] = useState(false)
  const [showFeishuAdvanced, setShowFeishuAdvanced] = useState(false)
  const [showTelegramToken, setShowTelegramToken] = useState(false)

  const runWithBusy = useCallback(async <T,>(actionKey: string, task: () => Promise<T>): Promise<T | null> => {
    setBusyAction(actionKey)
    try {
      return await Promise.race([
        task(),
        new Promise<null>((_, reject) => {
          setTimeout(() => reject(new Error('请求超时，请查看 sidecar 状态或稍后重试')), 20_000)
        }),
      ])
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusyAction((current) => (current === actionKey ? null : current))
    }
  }, [])

  const isBusy = (actionKey: string): boolean => busyAction === actionKey

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.agent) return
    const [channelsRes, runtimeRes, cacheRes] = await Promise.all([
      window.electronAPI.agent.listChannels(),
      window.electronAPI.agent.getRuntimeStatus(),
      window.electronAPI.agent.getRemoteAttachmentCacheStats(),
    ])
    if (channelsRes.success && channelsRes.data) {
      const list = channelsRes.data as unknown as ChannelData[]
      setChannels(list)
      const tg = list.find((item) => item.type === 'telegram-bot')
      const fs = list.find((item) => item.type === 'feishu-app')
      if (tg) {
        const token = String(tg.config?.token || tg.config?.botToken || '')
        if (token) setTelegramToken(token)
      }
        if (fs) {
          const appId = String(fs.config?.appId || '')
          const appSecret = String(fs.config?.appSecret || '')
          const verificationToken = String(fs.config?.verificationToken || '')
          const encryptKey = String(fs.config?.encryptKey || '')
        if (appId) setFeishuAppId(appId)
          if (appSecret) setFeishuAppSecret(appSecret)
          if (verificationToken) setFeishuVerificationToken(verificationToken)
          if (encryptKey) setFeishuEncryptKey(encryptKey)
          if (verificationToken || encryptKey) setShowFeishuAdvanced(true)
        }
      }
    if (runtimeRes.success && runtimeRes.data) {
      setRuntimeStatus(runtimeRes.data as unknown as RuntimeStatusData)
    }
    if (cacheRes?.success && cacheRes.data) {
      setCacheStats(cacheRes.data as RemoteAttachmentCacheStatsData)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const feishuChannel = useMemo(
    () => channels.find((item) => item.type === 'feishu-app'),
    [channels],
  )
  const telegramChannel = useMemo(
    () => channels.find((item) => item.type === 'telegram-bot'),
    [channels],
  )

  const connectTelegram = async () => {
    if (!window.electronAPI?.agent) return
    const token = telegramToken.trim()
    if (!token) {
      setStatusText('请先填写 Telegram Bot Token')
      return
    }
    setStatusText('正在测试 Telegram 连接…')
    await runWithBusy('telegram-connect', async () => {
      const payload = {
        id: telegramChannel?.id || 'channel-telegram-default',
        type: 'telegram-bot' as const,
        name: 'Telegram',
        enabled: true,
        config: {
          token,
        },
      }
      const test = await window.electronAPI.agent.testChannel(payload)
      if (!test.success) {
        setStatusText(`连接失败：${test.error || '未知错误'}`)
        return
      }
      const save = await window.electronAPI.agent.upsertChannel(payload)
      if (!save.success) {
        setStatusText(`保存失败：${save.error || '未知错误'}`)
        return
      }
      setStatusText('Telegram 已连接')
      await refresh()
    })
  }

  const connectFeishu = async () => {
    if (!window.electronAPI?.agent) return
    const appId = feishuAppId.trim()
    const appSecret = feishuAppSecret.trim()
    if (!appId || !appSecret) {
      setStatusText('请先填写飞书 App ID 和 App Secret')
      return
    }
    setStatusText('正在测试飞书连接…')
    await runWithBusy('feishu-connect', async () => {
      const config: Record<string, string> = {
        appId,
        appSecret,
        mode: 'long-connection',
        triggerPrefix: '@ready',
      }
      const verificationToken = feishuVerificationToken.trim()
      const encryptKey = feishuEncryptKey.trim()
      if (verificationToken) config.verificationToken = verificationToken
      if (encryptKey) config.encryptKey = encryptKey
      const payload = {
        id: feishuChannel?.id || 'channel-feishu-default',
        type: 'feishu-app' as const,
        name: '飞书',
        enabled: true,
        config,
      }
      const test = await window.electronAPI.agent.testChannel(payload)
      if (!test.success) {
        setStatusText(`连接失败：${test.error || '未知错误'}`)
        return
      }
      const save = await window.electronAPI.agent.upsertChannel(payload)
      if (!save.success) {
        setStatusText(`保存失败：${save.error || '未知错误'}`)
        return
      }
      setStatusText('飞书已连接')
      await refresh()
    })
  }

  const disconnectChannel = async (id: string) => {
    if (!window.electronAPI?.agent) return
    await runWithBusy(`disconnect:${id}`, async () => {
      await window.electronAPI.agent.setChannelEnabled(id, false)
      await refresh()
      setStatusText('已断开连接')
    })
  }

  const deleteChannel = async (id: string) => {
    if (!window.electronAPI?.agent) return
    await runWithBusy(`delete:${id}`, async () => {
      await window.electronAPI.agent.deleteChannel(id)
      await refresh()
      setStatusText('已删除通道')
    })
  }

  const sendProbe = async (id: string) => {
    if (!window.electronAPI?.agent) return
    setStatusText('发送测试消息中…')
    await runWithBusy(`probe:${id}`, async () => {
      const res = await window.electronAPI.agent.sendChannelProbe(id, 'Ready 测试消息：通道已连通。')
      setStatusText(res.success ? '测试消息已发送' : `发送失败：${res.error || '未知错误'}`)
      await refresh()
    })
  }

  const currentAdapters = runtimeStatus?.heartbeat?.adapters || []

  return (
    <div className="flex flex-col" style={{ gap: 28 }}>
      <div
        className="glass-surface-card border flex w-fit"
        style={{
          ...panelCardStyle,
          borderRadius: 28,
          padding: 8,
          gap: 8,
        }}
      >
        {[
          { key: 'imessage' as const, label: 'iMessage' },
          { key: 'telegram' as const, label: 'Telegram' },
          { key: 'feishu' as const, label: '飞书' },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className="text-[13px] transition-all"
            style={{
              color: tab === item.key ? 'var(--color-blue)' : 'var(--text-muted)',
              background: tab === item.key ? 'var(--color-blue-light)' : 'transparent',
              fontWeight: tab === item.key ? 600 : 500,
              minWidth: 128,
              padding: '14px 28px',
              borderRadius: 20,
              lineHeight: 1.35,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'imessage' && (
        <div
          className="text-[13px]"
          style={{
            color: 'var(--text-muted)',
            padding: '4px 0 10px',
            lineHeight: 1.7,
          }}
        >
          iMessage 正在开发中，当前版本先支持 Telegram 与飞书。
        </div>
      )}

      {tab === 'telegram' && (
        <div className="flex flex-col" style={{ padding: '4px 0 10px', gap: 20 }}>
          <div className="flex flex-col" style={{ gap: 8 }}>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>Telegram 连接</div>
            <div className="text-[12px] leading-6" style={{ color: 'var(--text-muted)' }}>
              在 Telegram 中通过 `@BotFather` 创建机器人，并把 Bot Token 填到这里。
            </div>
          </div>
          <div className="relative">
            <input
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
              placeholder="Bot Token"
              type={showTelegramToken ? 'text' : 'password'}
              className="w-full border text-[13px] focus:outline-none"
              style={{ ...fieldStyle, borderRadius: 20, paddingRight: 56 }}
            />
            <button
              className="absolute top-1/2 -translate-y-1/2 rounded-xl"
              onClick={() => setShowTelegramToken((v) => !v)}
              title="显示/隐藏"
              style={{ color: 'var(--text-muted)', right: 16, padding: 8 }}
            >
              {showTelegramToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center flex-wrap" style={{ gap: 12 }}>
            <button
              disabled={isBusy('telegram-connect')}
              onClick={() => { void connectTelegram() }}
              className="text-[13px] font-medium"
              style={{ ...primaryButtonStyle, minWidth: 104, padding: '13px 24px', borderRadius: 20, lineHeight: 1.35 }}
            >
              <span className="inline-flex items-center gap-2">
                {isBusy('telegram-connect') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                连接
              </span>
            </button>
            {telegramChannel && telegramChannel.enabled && (
              <>
                <button
                  disabled={isBusy(`probe:${telegramChannel.id}`)}
                  onClick={() => { void sendProbe(telegramChannel.id) }}
                  className="border text-[13px]"
                  style={{ ...secondaryButtonStyle, minWidth: 104, padding: '13px 24px', borderRadius: 20, lineHeight: 1.35 }}
                >
                  <span className="inline-flex items-center gap-2">
                    {isBusy(`probe:${telegramChannel.id}`) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    测试
                  </span>
                </button>
                <button
                  disabled={isBusy(`disconnect:${telegramChannel.id}`)}
                  onClick={() => { void disconnectChannel(telegramChannel.id) }}
                  className="border text-[13px]"
                  style={{ ...secondaryButtonStyle, minWidth: 104, padding: '13px 24px', borderRadius: 20, lineHeight: 1.35 }}
                >
                  <span className="inline-flex items-center gap-2">
                    {isBusy(`disconnect:${telegramChannel.id}`) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    断开
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'feishu' && (
        <div className="flex flex-col" style={{ padding: '4px 0 10px', gap: 24 }}>
          <div className="flex flex-col" style={{ gap: 8 }}>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>飞书连接</div>
            <div className="text-[12px] leading-6" style={{ color: 'var(--text-muted)' }}>
              使用 App ID / App Secret 建立长连接事件通道，不依赖公网回调。Verification Token / Encrypt Key 只在回调 URL 或消息加密场景需要。
            </div>
          </div>
          <div className="grid grid-cols-2" style={{ gap: 16 }}>
            <input
              value={feishuAppId}
              onChange={(e) => setFeishuAppId(e.target.value)}
              placeholder="App ID"
              className="border text-[13px] focus:outline-none"
              style={{ ...fieldStyle, borderRadius: 20 }}
            />
            <div className="relative">
              <input
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
                placeholder="App Secret"
                type={showFeishuSecret ? 'text' : 'password'}
                className="w-full border text-[13px] focus:outline-none"
                style={{ ...fieldStyle, borderRadius: 20, paddingRight: 56 }}
              />
              <button
                className="absolute top-1/2 -translate-y-1/2 rounded-xl"
                onClick={() => setShowFeishuSecret((v) => !v)}
                title="显示/隐藏"
                style={{ color: 'var(--text-muted)', right: 16, padding: 8 }}
              >
                {showFeishuSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="flex flex-col" style={{ gap: 12 }}>
            <button
              type="button"
              onClick={() => setShowFeishuAdvanced((value) => !value)}
              className="inline-flex w-fit items-center text-[12px] font-medium"
              style={{ color: 'var(--text-muted)', gap: 6, padding: '4px 2px' }}
            >
              {showFeishuAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              高级选项（仅回调模式 / 加密场景）
            </button>
            {showFeishuAdvanced && (
              <div className="grid grid-cols-2" style={{ gap: 16 }}>
                <input
                  value={feishuVerificationToken}
                  onChange={(e) => setFeishuVerificationToken(e.target.value)}
                  placeholder="Verification Token（可选）"
                  className="border text-[13px] focus:outline-none"
                  style={{ ...fieldStyle, borderRadius: 20 }}
                />
                <input
                  value={feishuEncryptKey}
                  onChange={(e) => setFeishuEncryptKey(e.target.value)}
                  placeholder="Encrypt Key（可选）"
                  className="border text-[13px] focus:outline-none"
                  style={{ ...fieldStyle, borderRadius: 20 }}
                />
              </div>
            )}
          </div>
          {!showFeishuSecret && feishuAppSecret && (
            <div className="text-[11px]" style={{ color: 'var(--text-muted)', padding: '2px 4px' }}>
              当前密钥：{maskSecret(feishuAppSecret)}
            </div>
          )}
          <div className="flex items-center flex-wrap" style={{ gap: 12 }}>
            <button
              disabled={isBusy('feishu-connect')}
              onClick={() => { void connectFeishu() }}
              className="text-[13px] font-medium"
              style={{ ...primaryButtonStyle, minWidth: 104, padding: '13px 24px', borderRadius: 20, lineHeight: 1.35 }}
            >
              <span className="inline-flex items-center gap-2">
                {isBusy('feishu-connect') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                连接
              </span>
            </button>
            {feishuChannel && feishuChannel.enabled && (
              <>
                <button
                  disabled={isBusy(`probe:${feishuChannel.id}`)}
                  onClick={() => { void sendProbe(feishuChannel.id) }}
                  className="border text-[13px]"
                  style={{ ...secondaryButtonStyle, minWidth: 104, padding: '13px 24px', borderRadius: 20, lineHeight: 1.35 }}
                >
                  <span className="inline-flex items-center gap-2">
                    {isBusy(`probe:${feishuChannel.id}`) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    测试
                  </span>
                </button>
                <button
                  disabled={isBusy(`disconnect:${feishuChannel.id}`)}
                  onClick={() => { void disconnectChannel(feishuChannel.id) }}
                  className="border text-[13px]"
                  style={{ ...secondaryButtonStyle, minWidth: 104, padding: '13px 24px', borderRadius: 20, lineHeight: 1.35 }}
                >
                  <span className="inline-flex items-center gap-2">
                    {isBusy(`disconnect:${feishuChannel.id}`) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    断开
                  </span>
                </button>
              </>
            )}
          </div>
          <div className="text-[12px]" style={{ color: 'var(--text-muted)', padding: '4px 0 0', lineHeight: 1.8 }}>
            <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)', marginBottom: 10 }}>配置指引</div>
            <div>1. 在飞书开放平台创建自建应用并启用机器人能力。</div>
            <div>2. 建议选择事件订阅的“长连接”模式；如果使用回调 URL 模式，需要额外暴露可公网访问的 callback 地址。</div>
            <div>3. 订阅消息事件至少包含 `im.message.receive_v1`；长连接模式通常不需要填写 Verification Token / Encrypt Key，只有回调校验或消息加密时才需要。</div>
            <div>4. 发布应用版本后，填入 App ID / App Secret 并连接。</div>
          </div>
        </div>
      )}

      <div className="glass-surface-card border flex flex-col" style={{ ...panelCardStyle, borderRadius: 28, padding: '30px 32px', gap: 20 }}>
        <div className="flex items-center justify-between" style={{ paddingTop: 4 }}>
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>运行状态</div>
          <button
            className="border text-[12px] inline-flex items-center"
            style={{ ...secondaryButtonStyle, borderRadius: 18, padding: '12px 18px', gap: 8 }}
            onClick={() => { void refresh() }}
          >
            <RefreshCcw className="w-3.5 h-3.5" />
            刷新
          </button>
        </div>
        <div className="text-[12px] leading-7" style={{ color: 'var(--text-body)' }}>
          <div>Sidecar: {runtimeStatus?.sidecar?.status || 'unknown'}{runtimeStatus?.sidecar?.port ? ` (port ${runtimeStatus.sidecar.port})` : ''}</div>
          {runtimeStatus?.sidecar?.error && (
            <div style={{ color: 'var(--color-red)' }}>错误：{runtimeStatus.sidecar.error}</div>
          )}
        </div>

        <div className="flex flex-col" style={{ gap: 12 }}>
          {channels.map((channel) => {
            const adapter = currentAdapters.find((item) => item.id === channel.id)
            const running = channel.enabled && (adapter?.status === 'running' || adapter?.healthy)
            return (
              <div
                key={channel.id}
                className="glass-surface-card border flex items-start justify-between"
                style={{ ...panelCardStyle, borderRadius: 24, padding: '20px 24px', gap: 20 }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium flex items-center gap-3" style={{ color: 'var(--text-title)' }}>
                    <Bot className="w-4 h-4" />
                    {channel.name}
                    {running ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-green)' }}>
                        <CheckCircle2 className="w-3.5 h-3.5" /> 运行中
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <XCircle className="w-3.5 h-3.5" /> 未连接
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] mt-2 leading-6" style={{ color: 'var(--text-muted)' }}>
                    {channel.type} · {adapter?.lastBeatAt ? `最近心跳 ${new Date(adapter.lastBeatAt).toLocaleString()}` : '暂无心跳'}
                  </div>
                  {(adapter?.error || channel.lastError) && (
                    <div className="text-[11px] mt-2 leading-6" style={{ color: 'var(--color-red)' }}>
                      {adapter?.error || channel.lastError}
                    </div>
                  )}
                </div>
                <div className="flex items-center" style={{ gap: 12, paddingTop: 4, paddingRight: 4 }}>
                  <button
                    title="发送测试消息"
                    onClick={() => { void sendProbe(channel.id) }}
                    className="border"
                    style={{ ...secondaryButtonStyle, padding: 12, borderRadius: 18 }}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                  <button
                    title={channel.enabled ? '停用' : '启用'}
                    onClick={() => { void window.electronAPI.agent.setChannelEnabled(channel.id, !channel.enabled).then(() => refresh()) }}
                    className="border"
                    style={{ ...secondaryButtonStyle, padding: 12, borderRadius: 18 }}
                  >
                    {channel.enabled ? <MessageSquare className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                  </button>
                  <button
                    title="删除"
                    onClick={() => { void deleteChannel(channel.id) }}
                    className="border"
                    style={{ ...secondaryButtonStyle, color: 'var(--color-red)', padding: 12, borderRadius: 18 }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )
          })}
          {channels.length === 0 && (
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无远程 IM 通道</div>
          )}
        </div>
      </div>

      <div className="glass-surface-card border flex flex-col" style={{ ...panelCardStyle, borderRadius: 28, padding: '28px 32px', gap: 18 }}>
        <div className="flex items-center justify-between">
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>附件缓存</div>
          <button
            className="border text-[12px] inline-flex items-center"
            style={{ ...secondaryButtonStyle, borderRadius: 18, padding: '12px 18px', gap: 8 }}
            onClick={() => { void refresh() }}
          >
            <RefreshCcw className="w-3.5 h-3.5" />
            刷新
          </button>
        </div>
        <div className="text-[12px] leading-7" style={{ color: 'var(--text-body)' }}>
          <div>总附件数：{cacheStats?.totalFiles ?? 0}</div>
          <div>总大小：{(((cacheStats?.totalBytes ?? 0) / 1024 / 1024) || 0).toFixed(2)} MB</div>
        </div>
        <div className="flex items-center flex-wrap" style={{ gap: 12 }}>
          <button
            className="border text-[13px]"
            style={{ ...secondaryButtonStyle, minWidth: 120, padding: '13px 24px', borderRadius: 20, lineHeight: 1.35 }}
            disabled={isBusy('clear-cache:all')}
            onClick={() => {
              void runWithBusy('clear-cache:all', async () => {
                const res = await window.electronAPI.agent.clearRemoteAttachmentCache()
                setStatusText(res.success ? '已清空全部远程附件缓存' : `清理失败：${res.error || '未知错误'}`)
                await refresh()
              })
            }}
          >
            清空全部
          </button>
        </div>
        {cacheStats && cacheStats.channels.length > 0 && (
          <div className="flex flex-col" style={{ gap: 10 }}>
            {cacheStats.channels.map((item) => (
              <div
                key={item.channelId}
                className="glass-surface-card border flex items-center justify-between"
                style={{ ...panelCardStyle, borderRadius: 20, padding: '16px 18px', gap: 16 }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>{item.channelId}</div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    {item.files} 个文件 · {(item.bytes / 1024 / 1024).toFixed(2)} MB
                  </div>
                </div>
                <button
                  className="border text-[12px]"
                  style={{ ...secondaryButtonStyle, borderRadius: 18, padding: '10px 16px' }}
                  disabled={isBusy(`clear-cache:${item.channelId}`)}
                  onClick={() => {
                    void runWithBusy(`clear-cache:${item.channelId}`, async () => {
                      const res = await window.electronAPI.agent.clearRemoteAttachmentCache(item.channelId)
                      setStatusText(res.success ? `已清理 ${item.channelId} 的附件缓存` : `清理失败：${res.error || '未知错误'}`)
                      await refresh()
                    })
                  }}
                >
                  清理
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {statusText && (
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {statusText}
        </div>
      )}
    </div>
  )
}
