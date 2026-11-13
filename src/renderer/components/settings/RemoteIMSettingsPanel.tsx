import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { WechatLoginControl } from './WechatLoginControl'
import { Bot, ChevronDown, ChevronUp, Eye, EyeOff, Loader2, MessageSquareDashed, RefreshCcw, Send, Trash2 } from 'lucide-react'
import {
  SettingsCard,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsStatus,
  type SettingsTone,
} from '../../pages/settings/settings-shared'
import { Button, IconButton, Input, Switch, Tabs } from '../ui'

type IMTab = 'imessage' | 'telegram' | 'feishu' | 'wechat'

type ChannelAdapterType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'
  | 'wechat-openclaw'

interface ChannelData {
  id: string
  type: ChannelAdapterType
  name: string
  enabled: boolean
  config: Record<string, unknown>
  credentialState: 'ready' | 'missing' | 'recovery_required' | 'vault_unavailable'
  secretStatus: Record<string, {
    configured: boolean
    state: 'ready' | 'missing' | 'recovery_required' | 'vault_unavailable'
  }>
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

const WECHAT_CHANNEL_ID = 'channel-wechat-openclaw-default'

const IM_TABS: { id: IMTab; label: string }[] = [
  { id: 'imessage', label: 'iMessage' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'feishu', label: '飞书' },
  { id: 'wechat', label: '微信' },
]

type ChannelHealth = { tone: SettingsTone; label: string }

// 文案里用反引号标出的命令 / 事件名渲染成等宽小片段。
function withInlineCode(text: string) {
  return text.split(/`([^`]+)`/).map((part, index) => (index % 2 === 1
    ? <code key={index} className="sx-code text-[12px]">{part}</code>
    : part))
}

// 带「显示/隐藏」按钮的密钥输入框：眼睛按钮是凹槽内的幽灵图标按钮。
function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  visible,
  onToggleVisible,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  visible: boolean
  onToggleVisible: () => void
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        className="sx-mono"
        style={{ paddingRight: 40 }}
      />
      <IconButton
        size="sm"
        className="absolute right-[4px] top-1/2 -translate-y-1/2"
        onClick={onToggleVisible}
        title="显示/隐藏"
        icon={visible ? <EyeOff /> : <Eye />}
      />
    </div>
  )
}

export default function RemoteIMSettingsPanel() {
  const fieldId = useId()
  const [tab, setTab] = useState<IMTab>('feishu')
  const [channels, setChannels] = useState<ChannelData[]>([])
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusData | null>(null)
  const [cacheStats, setCacheStats] = useState<RemoteAttachmentCacheStatsData | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [statusText, setStatusText] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const busyRef = useRef(false)

  const [telegramToken, setTelegramToken] = useState('')
  const [feishuAppId, setFeishuAppId] = useState('')
  const [feishuAppSecret, setFeishuAppSecret] = useState('')
  const [feishuVerificationToken, setFeishuVerificationToken] = useState('')
  const [feishuEncryptKey, setFeishuEncryptKey] = useState('')
  const [wechatRouteTag, setWechatRouteTag] = useState('')
  const [wechatBotAgent, setWechatBotAgent] = useState('')
  const [showFeishuSecret, setShowFeishuSecret] = useState(false)
  const [showFeishuAdvanced, setShowFeishuAdvanced] = useState(false)
  const [showTelegramToken, setShowTelegramToken] = useState(false)
  const [showWechatAdvanced, setShowWechatAdvanced] = useState(false)

  const runWithBusy = useCallback(async <T,>(actionKey: string, task: () => Promise<T>): Promise<T | null> => {
    if (busyRef.current) return null
    busyRef.current = true
    setBusyAction(actionKey)
    try {
      return await task()
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      busyRef.current = false
      setBusyAction((current) => (current === actionKey ? null : current))
    }
  }, [])

  const isBusy = (actionKey: string): boolean => busyAction === actionKey

  const applyChannelList = useCallback((list: ChannelData[]) => {
    setChannels(list)
    const fs = list.find((item) => item.type === 'feishu-app')
    if (fs) {
      const appId = String(fs.config?.appId || '')
      if (appId) setFeishuAppId(appId)
      if (fs.secretStatus.verificationToken || fs.secretStatus.encryptKey) {
        setShowFeishuAdvanced(true)
      }
    }
    const wx = list.find((item) => item.type === 'wechat-openclaw')
    if (wx) {
      const routeTag = String(wx.config?.routeTag || wx.config?.skRouteTag || '')
      const botAgent = String(wx.config?.botAgent || '')
      setWechatRouteTag(routeTag)
      setWechatBotAgent(botAgent)
      if (routeTag || botAgent) setShowWechatAdvanced(true)
    }
  }, [])

  // 进入页面时只加载频道配置（listChannels 轻量），让表单立即可用。
  const loadChannelConfig = useCallback(async () => {
    if (!window.electronAPI?.agent) return
    const channelsRes = await window.electronAPI.agent.listChannels()
    if (channelsRes.success && channelsRes.data) {
      applyChannelList(channelsRes.data as unknown as ChannelData[])
    }
  }, [applyChannelList])

  // 运行态 + 远程附件缓存统计（后者触发主进程同步 fs 遍历），仅手动刷新时执行，避免切入页面卡顿。
  const refreshStatus = useCallback(async () => {
    if (!window.electronAPI?.agent) return
    const runtimePromise = window.electronAPI.agent.getRuntimeStatus()
    const cachePromise = window.electronAPI.agent.getRemoteAttachmentCacheStats()
    const runtimeRes = await runtimePromise
    if (runtimeRes.success && runtimeRes.data) {
      setRuntimeStatus(runtimeRes.data as unknown as RuntimeStatusData)
    }
    const cacheRes = await cachePromise
    if (cacheRes?.success && cacheRes.data) {
      setCacheStats(cacheRes.data as RemoteAttachmentCacheStatsData)
    }
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([loadChannelConfig(), refreshStatus()])
  }, [loadChannelConfig, refreshStatus])

  useEffect(() => {
    let disposed = false
    let refreshing = false
    void loadChannelConfig().catch(error => setStatusText(String(error)))
    const poll = async () => {
      if (refreshing || !window.electronAPI?.agent) return
      refreshing = true
      try {
        const [status, config] = await Promise.all([
          window.electronAPI.agent.getRuntimeStatus(), window.electronAPI.agent.listChannels(),
        ])
        if (disposed) return
        if (status.success && status.data) setRuntimeStatus(status.data as RuntimeStatusData)
        if (config.success && config.data) setChannels(config.data as unknown as ChannelData[])
      } catch (error) {
        // silent-catch: refresh failures are displayed beside the connection controls.
        if (!disposed) setStatusText(error instanceof Error ? error.message : String(error))
      } finally { refreshing = false }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 3000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [loadChannelConfig])

  const feishuChannel = useMemo(
    () => channels.find((item) => item.type === 'feishu-app'),
    [channels],
  )
  const telegramChannel = useMemo(
    () => channels.find((item) => item.type === 'telegram-bot'),
    [channels],
  )
  const wechatChannel = useMemo(
    () => channels.find((item) => item.type === 'wechat-openclaw'),
    [channels],
  )
  useEffect(() => { setPairingCode('') }, [feishuChannel?.config.bindingId])

  const telegramSecretState = telegramChannel?.secretStatus.token?.state
    || telegramChannel?.secretStatus.botToken?.state
    || 'missing'
  const feishuAppSecretState = feishuChannel?.secretStatus.appSecret?.state || 'missing'

  const connectTelegram = async () => {
    if (!window.electronAPI?.agent) return
    const token = telegramToken.trim()
    if (!token && telegramSecretState !== 'ready') {
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
        config: token ? { token } : {},
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
      setTelegramToken('')
      setStatusText('Telegram 已连接')
      await refresh()
    })
  }

  const connectFeishu = async () => {
    if (!window.electronAPI?.agent) return
    const appId = feishuAppId.trim()
    const appSecret = feishuAppSecret.trim()
    if (!appId || (!appSecret && feishuAppSecretState !== 'ready')) {
      setStatusText('请先填写飞书 App ID 和 App Secret')
      return
    }
    setStatusText('正在测试飞书连接…')
    await runWithBusy('feishu-connect', async () => {
      const config: Record<string, string> = {
        appId,
        mode: 'long-connection',
        triggerPrefix: '@ready',
      }
      if (appSecret) config.appSecret = appSecret
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
      setFeishuAppSecret('')
      setFeishuVerificationToken('')
      setFeishuEncryptKey('')
      setStatusText('飞书配置已保存，正在建立连接。请继续绑定你本人的飞书账号。')
      await refresh()
    })
  }

  const saveWechatChannel = useCallback(async (
    accountId?: string,
    options?: { enabled?: boolean; silent?: boolean },
  ) => {
    if (!window.electronAPI?.agent) return
    const existingAccountId = String(wechatChannel?.config?.accountId || '')
    const config: Record<string, string> = {}
    const nextAccountId = accountId || existingAccountId
    const routeTag = wechatRouteTag.trim()
    const botAgent = wechatBotAgent.trim()
    if (nextAccountId) config.accountId = nextAccountId
    if (routeTag) config.routeTag = routeTag
    if (botAgent) config.botAgent = botAgent
    const save = await window.electronAPI.agent.upsertChannel({
      id: wechatChannel?.id || WECHAT_CHANNEL_ID,
      type: 'wechat-openclaw' as const,
      name: '微信',
      enabled: options?.enabled ?? true,
      config,
    })
    if (!save.success) throw new Error(`保存失败：${save.error || '未知错误'}`)
    if (!options?.silent) setStatusText('微信已启用')
    await refresh()
  }, [refresh, wechatBotAgent, wechatChannel?.config, wechatChannel?.id, wechatRouteTag])

  const disconnectChannel = async (id: string) => {
    if (!window.electronAPI?.agent) return
    await runWithBusy(`disconnect:${id}`, async () => {
      const result = await window.electronAPI.agent.setChannelEnabled(id, false)
      if (!result.success) {
        setStatusText(`断开失败：${result.error || '未知错误'}`)
        return
      }
      await refresh()
      setStatusText('已断开连接')
    })
  }

  const deleteChannel = async (id: string) => {
    if (!window.electronAPI?.agent) return
    await runWithBusy(`delete:${id}`, async () => {
      const result = await window.electronAPI.agent.deleteChannel(id)
      if (!result.success) {
        setStatusText(`删除失败：${result.error || '稍后重试'}`)
        return
      }
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

  // 运行中 = 已启用 + 凭据就绪 + 通讯服务运行 + 适配器健康；运行中但最近一次发送报错 = 通讯异常。
  const describeChannelHealth = (channel: ChannelData | undefined): ChannelHealth => {
    if (!channel) return { tone: 'muted', label: '未连接' }
    const adapter = currentAdapters.find((item) => item.id === channel.id)
    const running = channel.enabled && channel.credentialState === 'ready' && runtimeStatus?.sidecar?.status === 'running' && adapter?.status === 'running' && adapter.healthy
    if (running && channel.lastError) return { tone: 'danger', label: '通讯异常' }
    if (running) return { tone: 'accent', label: '运行中' }
    return { tone: 'muted', label: '未连接' }
  }

  const sidecarStatus: ChannelHealth = runtimeStatus?.sidecar?.status === 'running'
    ? { tone: 'accent', label: '运行中' }
    : runtimeStatus?.sidecar?.status === 'starting'
      ? { tone: 'warning', label: '正在启动' }
      : runtimeStatus?.sidecar?.status === 'error'
        ? { tone: 'danger', label: '连接异常' }
        : { tone: 'muted', label: '尚未启动' }

  const statusIsFailure = /失败|错误|异常|不可用|请先/.test(statusText)

  const renderConnectedActions = (channel: ChannelData | undefined) => channel && channel.enabled && (
    <>
      <Button
        disabled={Boolean(busyAction)}
        onClick={() => { void sendProbe(channel.id) }}
        icon={isBusy(`probe:${channel.id}`) ? <Loader2 className="animate-spin" /> : <Send />}
      >
        测试
      </Button>
      <Button
        variant="danger"
        disabled={Boolean(busyAction)}
        onClick={() => { void disconnectChannel(channel.id) }}
        icon={isBusy(`disconnect:${channel.id}`) ? <Loader2 className="animate-spin" /> : undefined}
      >
        断开
      </Button>
    </>
  )

  const renderHealth = (channel: ChannelData | undefined) => {
    const health = describeChannelHealth(channel)
    return <SettingsStatus tone={health.tone}>{health.label}</SettingsStatus>
  }

  return (
    <div className="sx-stack">
      <div className="flex flex-col gap-4">
        <p className="m-0 px-1 text-[12px] leading-6" style={{ color: 'var(--rn-ink-2)', maxWidth: 720 }}>
          微信和飞书绑定本人后，文字任务会交给 Ready 处理并原路回复。单独发送的附件先保存到对应会话；需要处理附件时，请同时说明任务。
        </p>
        <div className="self-start">
          <Tabs
            label="远程 IM 平台"
            items={IM_TABS}
            value={tab}
            onChange={(id) => setTab(id as IMTab)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {tab === 'imessage' && (
          <SettingsCard>
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <div className="sx-inset grid h-11 w-11 place-items-center" style={{ borderRadius: 14, color: 'var(--rn-ink-2)' }}>
                <MessageSquareDashed className="h-5 w-5" strokeWidth={1.8} />
              </div>
              <div className="sx-card-title">iMessage</div>
              <p className="m-0 text-[13px] leading-6" style={{ color: 'var(--rn-ink-2)' }}>
                iMessage 正在开发中，当前版本先支持 Telegram、飞书与微信。
              </p>
              <span className="sx-badge">即将推出</span>
            </div>
          </SettingsCard>
        )}

        {tab === 'telegram' && (
          <SettingsCard
            title="Telegram 连接"
            description={withInlineCode('在 Telegram 中通过 `@BotFather` 创建机器人，并把 Bot Token 填到这里。')}
            actions={renderHealth(telegramChannel)}
          >
            <div className="sx-card__body flex flex-col gap-2">
              <div className="sx-field">
                <label className="sx-field__label" htmlFor={`${fieldId}-telegram-token`}>Bot Token</label>
                <SecretInput
                  id={`${fieldId}-telegram-token`}
                  value={telegramToken}
                  onChange={setTelegramToken}
                  placeholder={telegramSecretState === 'ready'
                    ? '已安全保存（留空沿用）'
                    : telegramSecretState === 'recovery_required'
                      ? '升级后需重新填写 Bot Token'
                      : 'Bot Token'}
                  visible={showTelegramToken}
                  onToggleVisible={() => setShowTelegramToken((v) => !v)}
                />
              </div>
              {telegramSecretState === 'recovery_required' && (
                <div className="sx-text-danger text-[12px]">
                  升级后无法读取原密钥，请重新填写并连接。
                </div>
              )}
            </div>
            <div className="sx-card__footer" style={{ justifyContent: 'flex-start' }}>
              <Button
                variant="primary"
                disabled={Boolean(busyAction)}
                onClick={() => { void connectTelegram() }}
                icon={isBusy('telegram-connect') ? <Loader2 className="animate-spin" /> : undefined}
              >
                连接
              </Button>
              {renderConnectedActions(telegramChannel)}
            </div>
          </SettingsCard>
        )}

        {tab === 'feishu' && (
          <SettingsCard
            title="飞书连接"
            description="在飞书开放平台创建企业自建应用，启用机器人和长连接，订阅接收消息事件并发布版本。需要接收消息、以机器人身份发消息和获取消息资源权限。填入 App ID 与 App Secret 后，再绑定你本人。"
            actions={renderHealth(feishuChannel)}
          >
            <div className="sx-card__body flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="sx-field">
                  <label className="sx-field__label" htmlFor={`${fieldId}-feishu-app-id`}>App ID</label>
                  <Input
                    id={`${fieldId}-feishu-app-id`}
                    value={feishuAppId}
                    onChange={(e) => setFeishuAppId(e.target.value)}
                    placeholder="App ID"
                    className="sx-mono"
                  />
                </div>
                <div className="sx-field">
                  <label className="sx-field__label" htmlFor={`${fieldId}-feishu-app-secret`}>App Secret</label>
                  <SecretInput
                    id={`${fieldId}-feishu-app-secret`}
                    value={feishuAppSecret}
                    onChange={setFeishuAppSecret}
                    placeholder={feishuAppSecretState === 'ready'
                      ? '已安全保存（留空沿用）'
                      : feishuAppSecretState === 'recovery_required'
                        ? '升级后需重新填写 App Secret'
                        : 'App Secret'}
                    visible={showFeishuSecret}
                    onToggleVisible={() => setShowFeishuSecret((v) => !v)}
                  />
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setShowFeishuAdvanced((value) => !value)}
                aria-expanded={showFeishuAdvanced}
                style={{ marginLeft: -8 }}
                icon={showFeishuAdvanced ? <ChevronUp /> : <ChevronDown />}
              >
                高级选项（仅回调模式 / 加密场景）
              </Button>
              {showFeishuAdvanced && (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    value={feishuVerificationToken}
                    onChange={(e) => setFeishuVerificationToken(e.target.value)}
                    placeholder="Verification Token（可选）"
                    aria-label="Verification Token（可选）"
                    className="sx-mono"
                  />
                  <Input
                    value={feishuEncryptKey}
                    onChange={(e) => setFeishuEncryptKey(e.target.value)}
                    placeholder="Encrypt Key（可选）"
                    aria-label="Encrypt Key（可选）"
                    className="sx-mono"
                  />
                </div>
              )}
              {feishuAppSecretState === 'recovery_required' && (
                <div className="sx-text-danger text-[12px]">
                  升级后无法读取原密钥，请重新填写并连接。
                </div>
              )}
            </div>
            <div className="sx-card__footer" style={{ justifyContent: 'flex-start' }}>
              <Button
                variant="primary"
                disabled={Boolean(busyAction)}
                onClick={() => { void connectFeishu() }}
                icon={isBusy('feishu-connect') ? <Loader2 className="animate-spin" /> : undefined}
              >
                连接
              </Button>
              {renderConnectedActions(feishuChannel)}
            </div>
          </SettingsCard>
        )}

        {tab === 'feishu' && feishuChannel?.enabled && (
          <SettingsCard>
            <SettingsRow
              label={feishuChannel.config.allowedSenderId ? '已绑定本人' : '绑定本人'}
              description={feishuChannel.config.allowedSenderId ? '已绑定本人，私聊可直接发送任务；群聊请以 @ready 开头。' : '还需要绑定本人，完成后才能远程发送任务。'}
            >
              <Button
                disabled={Boolean(busyAction)}
                onClick={() => {
                  void runWithBusy('feishu-pair', async () => {
                    const result = await window.electronAPI.agent.startChannelPairing(feishuChannel.id)
                    if (!result.success || !result.data) throw new Error(result.error || '生成绑定码失败')
                    setPairingCode(result.data.code)
                  })
                }}
                icon={isBusy('feishu-pair') ? <Loader2 className="animate-spin" /> : undefined}
              >
                {feishuChannel.config.allowedSenderId ? '重新绑定本人' : '生成本人绑定码'}
              </Button>
            </SettingsRow>
            {pairingCode && (
              <div className="px-6 pb-5">
                <div className="sx-inset px-4 py-3 text-[13px] leading-6" style={{ color: 'var(--rn-ink)' }}>
                  在飞书中私聊你的机器人，发送 <code className="sx-code px-1.5 py-0.5 text-[12px]">/bind {pairingCode}</code>。绑定码 5 分钟内有效，完成后这里会显示已绑定。
                </div>
              </div>
            )}
          </SettingsCard>
        )}

        {tab === 'wechat' && (
          <SettingsCard
            title="微信连接"
            description="点击启用后会直接生成二维码，用手机微信扫码确认即可绑定。微信通道会发送到当前绑定的微信账号本人，无需设置收件人。"
            actions={renderHealth(wechatChannel)}
          >
            <div className="sx-card__body flex flex-col gap-3">
              <WechatLoginControl
                channelId={wechatChannel?.id || WECHAT_CHANNEL_ID}
                enabled={Boolean(wechatChannel?.enabled)}
                disabled={Boolean(busyAction)}
                beforeStart={async () => {
                  if (wechatRouteTag.trim() || wechatBotAgent.trim()) {
                    await saveWechatChannel(undefined, { enabled: Boolean(wechatChannel?.enabled), silent: true })
                  }
                }}
                onChanged={loadChannelConfig}
              />
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                style={{ marginLeft: -8 }}
                aria-expanded={showWechatAdvanced}
                onClick={() => setShowWechatAdvanced((value) => !value)}
                icon={showWechatAdvanced ? <ChevronUp /> : <ChevronDown />}
              >
                高级
              </Button>
              {showWechatAdvanced && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Input
                    value={wechatRouteTag}
                    onChange={(e) => setWechatRouteTag(e.target.value)}
                    placeholder="OpenClaw routeTag（可选）"
                    aria-label="OpenClaw routeTag（可选）"
                    className="sx-mono"
                  />
                  <Input
                    value={wechatBotAgent}
                    onChange={(e) => setWechatBotAgent(e.target.value)}
                    placeholder="botAgent（可选）"
                    aria-label="botAgent（可选）"
                    className="sx-mono"
                  />
                  <Button
                    className="justify-self-start md:col-span-2"
                    disabled={Boolean(busyAction)}
                    onClick={() => { void runWithBusy('wechat-save', () => saveWechatChannel()) }}
                    icon={isBusy('wechat-save') ? <Loader2 className="animate-spin" /> : undefined}
                  >
                    保存配置
                  </Button>
                </div>
              )}
            </div>
            {wechatChannel?.enabled && (
              <div className="sx-card__footer" style={{ justifyContent: 'flex-start' }}>
                {renderConnectedActions(wechatChannel)}
              </div>
            )}
          </SettingsCard>
        )}

        {statusText && (
          <SettingsNotice tone={statusIsFailure ? 'danger' : 'plain'}>
            {statusText}
          </SettingsNotice>
        )}
      </div>

      {tab === 'feishu' && (
        <SettingsGroup label="配置指引">
          <ol className="sx-inset m-0 flex list-none flex-col gap-2.5 px-6 py-5 text-[12px] leading-[1.7]" style={{ color: 'var(--rn-ink-2)' }}>
            {[
              '在飞书开放平台创建自建应用并启用机器人能力。',
              '建议选择事件订阅的“长连接”模式；如果使用回调 URL 模式，需要额外暴露可公网访问的 callback 地址。',
              '订阅消息事件至少包含 `im.message.receive_v1`；长连接模式通常不需要填写 Verification Token / Encrypt Key，只有回调校验或消息加密时才需要。',
              '发布应用版本后，填入 App ID / App Secret 并连接。',
            ].map((step, index) => (
              <li key={step} className="flex gap-3">
                <span
                  className="sx-mono mt-[2px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[11px]"
                  style={{ background: 'var(--rn-fill-2)', color: 'var(--rn-ink)' }}
                >
                  {index + 1}
                </span>
                <span>{withInlineCode(step)}</span>
              </li>
            ))}
          </ol>
        </SettingsGroup>
      )}

      <SettingsGroup label="运行状态">
        <SettingsCard>
          <SettingsRow
            label="通讯服务"
            description={runtimeStatus?.sidecar?.error
              ? <span className="sx-text-danger">错误：{runtimeStatus.sidecar.error}</span>
              : '远程 IM 的消息收发都经由本地通讯服务'}
          >
            <SettingsStatus tone={sidecarStatus.tone}>{sidecarStatus.label}</SettingsStatus>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void refresh() }}
              icon={<RefreshCcw />}
            >
              刷新
            </Button>
          </SettingsRow>
          {channels.map((channel) => {
            const adapter = currentAdapters.find((item) => item.id === channel.id)
            const channelError = adapter?.error || channel.lastError
            const health = describeChannelHealth(channel)
            return (
              <div key={channel.id} className="sx-row" style={{ alignItems: 'flex-start' }}>
                <div className="flex min-w-0 flex-1 gap-3">
                  <div className="sx-inset grid h-8 w-8 shrink-0 place-items-center" style={{ borderRadius: 10, color: 'var(--rn-ink-2)' }}>
                    <Bot className="h-4 w-4" strokeWidth={1.8} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="sx-row__label">{channel.name}</span>
                      <SettingsStatus tone={health.tone}>{health.label}</SettingsStatus>
                    </div>
                    <div className="sx-meta mt-0.5">
                      {channel.config.allowedSenderId ? '已绑定本人' : '尚未绑定本人'} · {adapter?.lastBeatAt ? `最近连接检查 ${new Date(adapter.lastBeatAt).toLocaleString()}` : '等待连接检查'}
                    </div>
                    {channelError && (
                      <div className="sx-text-danger mt-1 text-[12px] leading-5">
                        {channelError}
                      </div>
                    )}
                  </div>
                </div>
                <div className="sx-row__control" style={{ gap: 4 }}>
                  <IconButton
                    size="sm"
                    title="发送测试消息"
                    disabled={Boolean(busyAction)}
                    onClick={() => { void sendProbe(channel.id) }}
                    icon={<Send />}
                  />
                  <IconButton
                    size="sm"
                    title="删除"
                    disabled={Boolean(busyAction)}
                    onClick={() => { void deleteChannel(channel.id) }}
                    icon={<Trash2 />}
                  />
                  <span className="ml-2" title={channel.enabled ? '停用' : '启用'}>
                    <Switch
                      checked={channel.enabled}
                      disabled={Boolean(busyAction)}
                      label={channel.enabled ? `停用 ${channel.name}` : `启用 ${channel.name}`}
                      onChange={() => {
                        void runWithBusy(`toggle:${channel.id}`, async () => {
                          const result = await window.electronAPI.agent.setChannelEnabled(channel.id, !channel.enabled)
                          if (!result.success) throw new Error(result.error || '连接设置未生效')
                          await refresh()
                        })
                      }}
                    />
                  </span>
                </div>
              </div>
            )
          })}
          {channels.length === 0 && (
            <div className="sx-row">
              <span className="text-[12px]" style={{ color: 'var(--rn-ink-2)' }}>暂无远程 IM 通道</span>
            </div>
          )}
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup label="附件缓存">
        <SettingsCard>
          <SettingsRow
            label="远程附件"
            description={cacheStats
              ? `共 ${cacheStats.totalFiles} 个附件 · ${(cacheStats.totalBytes / 1024 / 1024).toFixed(2)} MB`
              : '总附件数与大小需手动统计，点击刷新后查看'}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void refresh() }}
              icon={<RefreshCcw />}
            >
              刷新
            </Button>
            <Button
              variant="danger"
              disabled={Boolean(busyAction)}
              onClick={() => {
                void runWithBusy('clear-cache:all', async () => {
                  const res = await window.electronAPI.agent.clearRemoteAttachmentCache()
                  setStatusText(res.success ? '已清空全部远程附件缓存' : `清理失败：${res.error || '未知错误'}`)
                  await refresh()
                })
              }}
              icon={isBusy('clear-cache:all') ? <Loader2 className="animate-spin" /> : <Trash2 />}
            >
              清空全部
            </Button>
          </SettingsRow>
          {cacheStats && cacheStats.channels.map((item) => (
            <SettingsRow
              key={item.channelId}
              label={<span className="sx-mono text-[12px]">{item.channelId}</span>}
              description={`${item.files} 个文件 · ${(item.bytes / 1024 / 1024).toFixed(2)} MB`}
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={Boolean(busyAction)}
                onClick={() => {
                  void runWithBusy(`clear-cache:${item.channelId}`, async () => {
                    const res = await window.electronAPI.agent.clearRemoteAttachmentCache(item.channelId)
                    setStatusText(res.success ? `已清理 ${item.channelId} 的附件缓存` : `清理失败：${res.error || '未知错误'}`)
                    await refresh()
                  })
                }}
              >
                清理
              </Button>
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsGroup>
    </div>
  )
}
