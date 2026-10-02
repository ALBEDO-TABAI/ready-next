// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
// 远程 IM：飞书运行中且已绑定本人、Telegram 运行中但最近发送报错、微信已扫码绑定，覆盖三种通道状态。

const now = Date.now()
const minutesAgo = (minutes: number) => new Date(now - minutes * 60 * 1000).toISOString()

let channels = [
  {
    id: 'channel-feishu-default',
    type: 'feishu-app',
    name: '飞书',
    enabled: true,
    config: { appId: 'cli_a5f2c8e1b7d0400e', allowedSenderId: 'ou_7d1f0c', mode: 'long-connection' },
    credentialState: 'ready' as const,
    secretStatus: { appSecret: { configured: true, state: 'ready' as const } },
    lastError: null,
    lastSeenAt: minutesAgo(2),
    createdAt: minutesAgo(60 * 24 * 9),
    updatedAt: minutesAgo(2),
  },
  {
    id: 'channel-telegram-default',
    type: 'telegram-bot',
    name: 'Telegram',
    enabled: true,
    config: {},
    credentialState: 'ready' as const,
    secretStatus: { token: { configured: true, state: 'ready' as const } },
    lastError: '最近一次发送失败：429 Too Many Requests，稍后会自动重试',
    lastSeenAt: minutesAgo(14),
    createdAt: minutesAgo(60 * 24 * 21),
    updatedAt: minutesAgo(14),
  },
  {
    id: 'channel-wechat-openclaw-default',
    type: 'wechat-openclaw',
    name: '微信',
    enabled: false,
    config: {},
    credentialState: 'missing' as const,
    secretStatus: {},
    lastError: null,
    lastSeenAt: null,
    createdAt: minutesAgo(60 * 24 * 3),
    updatedAt: minutesAgo(60 * 24 * 3),
  },
]

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  agent: {
    listChannels: async () => ({ success: true, data: channels }),
    getRuntimeStatus: async () => ({
      success: true,
      data: {
        orchestrator: 'codex-native',
        sidecarEnabled: true,
        sidecar: { status: 'running', port: 8765, lastBeatAt: minutesAgo(0) },
        channels: {
          total: channels.length,
          enabled: channels.filter((channel) => channel.enabled).length,
          connected: channels.filter((channel) => channel.enabled).length,
          errors: channels.filter((channel) => channel.lastError).length,
          byType: {},
        },
        heartbeat: {
          sidecar: { status: 'running', port: 8765 },
          adapters: channels.map((channel, index) => ({
            id: channel.id,
            type: channel.type,
            status: channel.enabled ? 'running' : 'stopped',
            healthy: channel.enabled,
            lastBeatAt: channel.enabled ? minutesAgo(index * 3 + 1) : undefined,
          })),
        },
      },
    }),
    getRemoteAttachmentCacheStats: async () => ({
      success: true,
      data: {
        totalFiles: 37,
        totalBytes: 54_853_222,
        targetPath: '~/Library/Application Support/Ready/remote-attachments',
        channels: [
          { channelId: 'channel-feishu-default', files: 29, bytes: 41_220_096 },
          { channelId: 'channel-telegram-default', files: 8, bytes: 13_633_126 },
        ],
      },
    }),
    setChannelEnabled: async (id: string, enabled: boolean) => {
      channels = channels.map((channel) => channel.id === id ? { ...channel, enabled } : channel)
      return { success: true, data: channels.find((channel) => channel.id === id) }
    },
    deleteChannel: async (id: string) => {
      channels = channels.filter((channel) => channel.id !== id)
      return { success: true }
    },
    startChannelPairing: async () => ({
      success: true,
      data: { code: '4K7Q-2M', expiresAt: new Date(now + 5 * 60 * 1000).toISOString() },
    }),
    sendChannelProbe: async () => ({ success: true }),
    testChannel: async () => ({ success: true }),
    getWechatLoginStatus: async () => ({ success: true, data: { status: 'idle' } }),
  },
}
