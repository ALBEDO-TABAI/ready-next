// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
import type { ElectronMcpServerConfig, ElectronMcpStatus } from '../../types/electron'

let configs: ElectronMcpServerConfig[] = [
  {
    id: 'filesystem',
    displayName: '本地文件',
    enabled: true,
    command: '/usr/local/bin/npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Documents/Ready'],
    approvalMode: 'writes',
    envEntries: [],
  },
  {
    id: 'linear',
    displayName: 'Linear',
    enabled: true,
    command: '/opt/homebrew/bin/linear-mcp',
    args: ['--stdio'],
    approvalMode: 'always',
    envEntries: [{ key: 'LINEAR_API_KEY', value: '', hasStoredValue: true }],
  },
]

function buildStatus(): ElectronMcpStatus {
  return {
    rawConfig: '',
    configs,
    configuredCount: configs.length,
    skipped: [],
    catalogGeneration: 3,
    catalogDigest: 'preview',
    servers: [
      {
        serverId: 'filesystem',
        displayName: '本地文件',
        toolCount: 6,
        toolNames: ['read_file', 'write_file', 'list_directory', 'search_files', 'get_file_info', 'move_file'],
        approvalMode: 'writes',
        clientConnected: true,
        resourceCount: 2,
        resourceTemplateCount: 0,
        catalogGeneration: 3,
        catalogDigest: 'preview',
        serverInfo: { name: 'secure-filesystem-server', version: '0.6.2' },
        instructions: null,
        stderrTail: '',
      },
      {
        serverId: 'linear',
        displayName: 'Linear',
        toolCount: 0,
        toolNames: [],
        approvalMode: 'always',
        clientConnected: false,
        resourceCount: 0,
        resourceTemplateCount: 0,
        catalogGeneration: 3,
        catalogDigest: 'preview',
        serverInfo: null,
        instructions: null,
        stderrTail: 'Error: LINEAR_API_KEY is invalid or expired',
        lastError: '进程启动后 3 秒内退出（exit code 1）',
      },
    ],
  }
}

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  mcp: {
    getStatus: async () => buildStatus(),
    saveConfig: async (servers: ElectronMcpServerConfig[]) => {
      configs = servers
      return { success: true, configuredCount: servers.length, skipped: [] }
    },
    reload: async () => ({
      success: true,
      outcomes: configs.map((server) => ({ serverId: server.id, ok: true, toolCount: 3, dropped: [] })),
    }),
    listResources: async (serverId: string) => ({
      success: true,
      data: {
        serverId,
        catalogGeneration: 3,
        catalogDigest: 'preview',
        resources: [
          { uri: 'file:///Users/me/Documents/Ready/周报.md', name: '周报.md', mimeType: 'text/markdown' },
          { uri: 'file:///Users/me/Documents/Ready/选题池.md', name: '选题池.md', mimeType: 'text/markdown' },
        ],
        resourceTemplates: [],
      },
    }),
    readResource: async (payload: { serverId: string; uri: string; catalogGeneration: number }) => ({
      success: true,
      data: { ...payload, catalogDigest: 'preview', content: { text: '' }, contentDigest: 'preview' },
    }),
  },
}
