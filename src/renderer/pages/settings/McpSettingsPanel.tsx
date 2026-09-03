import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plug2, RefreshCw } from 'lucide-react'
import {
  SETTINGS_FLAT_CARD_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../components/settings/settings-theme'
import type { ElectronMcpServerConfig, ElectronMcpStatus } from '../../types/electron'
import { useAgent } from '../../stores/useAgent'

type McpResourceCatalog = {
  catalogGeneration: number
  catalogDigest: string
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
  resourceTemplates: Array<{ uriTemplate: string; name?: string; description?: string; mimeType?: string }>
}

const EMPTY_SERVER: ElectronMcpServerConfig = {
  id: '',
  displayName: '',
  enabled: true,
  command: '',
  args: [],
  approvalMode: 'writes',
  envEntries: [],
}

export function McpSettingsPanel() {
  const [status, setStatus] = useState<ElectronMcpStatus | null>(null)
  const [configs, setConfigs] = useState<ElectronMcpServerConfig[]>([])
  const [draftTouched, setDraftTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resourceCatalogs, setResourceCatalogs] = useState<Record<string, McpResourceCatalog>>({})
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const refreshStatus = useCallback(async () => {
    const api = window.electronAPI?.mcp
    if (!api) return
    try {
      const next = await api.getStatus()
      setStatus(next)
      if (!draftTouched) setConfigs(next.configs)
    } catch {
      // silent-catch: 状态读取失败保持上一份显示；保存/重连路径有各自的错误反馈
    }
  }, [draftTouched])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const handleSave = useCallback(async (thenReload: boolean) => {
    const api = window.electronAPI?.mcp
    if (!api || busy) return
    setBusy(true)
    setFeedback(null)
    try {
      const saved = await api.saveConfig(configs)
      if (!saved.success) {
        const reasons = (saved.skipped || []).map((item) => item.reason).join('；')
        setFeedback({ tone: 'error', text: `${saved.error || '保存失败'}${reasons ? `（${reasons}）` : ''}` })
        return
      }
      const skippedNote = (saved.skipped || []).length > 0
        ? `；跳过 ${saved.skipped!.length} 条无效条目：${saved.skipped!.map((item) => item.reason).join('；')}`
        : ''
      if (thenReload) {
        const reloaded = await api.reload()
        if (!reloaded.success) {
          setFeedback({ tone: 'error', text: `已保存，但重连失败：${reloaded.error || '未知原因'}` })
          return
        }
        const failed = (reloaded.outcomes || []).filter((item) => !item.ok)
        setFeedback({
          tone: failed.length > 0 ? 'error' : 'ok',
          text: failed.length > 0
            ? `已保存并重连：${(reloaded.outcomes || []).length - failed.length} 个成功，失败：${failed.map((item) => `${item.serverId}（${item.error || '未知'}）`).join('、')}`
            : `已保存并重连 ${saved.configuredCount ?? 0} 个 server${skippedNote}`,
        })
      } else {
        setFeedback({ tone: 'ok', text: `已保存 ${saved.configuredCount ?? 0} 个 server 配置（点「保存并重连」生效）${skippedNote}` })
      }
      setDraftTouched(false)
      await refreshStatus()
    } finally {
      setBusy(false)
    }
  }, [busy, configs, refreshStatus])

  const updateServer = useCallback((index: number, patch: Partial<ElectronMcpServerConfig>) => {
    setDraftTouched(true)
    setConfigs((current) => current.map((server, serverIndex) => (
      serverIndex === index ? { ...server, ...patch } : server
    )))
  }, [])

  const loadResources = useCallback(async (serverId: string) => {
    const result = await window.electronAPI.mcp?.listResources(serverId)
    if (!result?.success || !result.data) {
      setFeedback({ tone: 'error', text: result?.error || '资源目录读取失败' })
      return
    }
    setResourceCatalogs((current) => ({ ...current, [serverId]: result.data! }))
  }, [])

  const attachResource = useCallback(async (
    serverId: string,
    resource: McpResourceCatalog['resources'][number],
  ) => {
    const catalog = resourceCatalogs[serverId]
    if (!catalog) return
    const result = await window.electronAPI.mcp?.readResource({
      serverId,
      uri: resource.uri,
      catalogGeneration: catalog.catalogGeneration,
    })
    if (!result?.success || !result.data) {
      setFeedback({ tone: 'error', text: result?.error || '资源读取失败' })
      return
    }
    useAgent.getState().addAttachments([{
      id: `mcp-resource-${crypto.randomUUID()}`,
      name: resource.name || resource.uri,
      path: resource.uri,
      type: 'text',
      size: JSON.stringify(result.data.content).length,
      ext: '',
      source: 'mcp-resource',
      mcpServerId: serverId,
      mcpResourceUri: resource.uri,
      mcpCatalogGeneration: result.data.catalogGeneration,
      mcpCatalogDigest: result.data.catalogDigest,
      mcpContentDigest: result.data.contentDigest,
    }])
    setFeedback({ tone: 'ok', text: `已把资源「${resource.name || resource.uri}」加到下一条消息。` })
  }, [resourceCatalogs])

  const servers = status?.servers ?? []
  const hasApi = useMemo(() => Boolean(window.electronAPI?.mcp), [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section
        aria-labelledby="mcp-servers-heading"
        className="glass-surface-card rounded-2xl border"
        style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '18px 20px' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
              style={{ background: 'var(--surface-muted)', color: 'var(--text-muted)' }}
            >
              <Plug2 className="h-4 w-4" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h3
                id="mcp-servers-heading"
                className="text-[14px] font-semibold leading-6"
                style={{ color: 'var(--text-title)', margin: 0 }}
              >
                MCP server（stdio）
              </h3>
              <p
                className="text-[12px] leading-5"
                style={{ color: 'var(--text-muted)', margin: '4px 0 0', maxWidth: 640 }}
              >
                仅连接本地 stdio server。工具会以 mcp_ 前缀进入 Agent 工具面，是否执行前确认由每个 server 的策略决定。
              </p>
            </div>
          </div>
          <button
            type="button"
            data-mcp-control="refresh-status"
            onClick={() => { void refreshStatus() }}
            className="inline-flex items-center gap-1.5 rounded-xl border text-[12px] font-medium"
            style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '6px 10px' }}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
            刷新
          </button>
        </div>

        <div className="mt-4" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {servers.length === 0 && (
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-light)', margin: 0 }}>
              尚未配置 MCP server——在下方添加配置并「保存并重连」。
            </p>
          )}
          {servers.map((server) => {
            const stateColor = server.lastError
              ? 'var(--status-error, #d4553f)'
              : server.clientConnected
                ? 'var(--status-success, #3f9d63)'
                : 'var(--text-light)'
            return (
              <div
                key={server.serverId}
                data-mcp-server={server.serverId}
                className="rounded-xl border"
                style={{ ...SETTINGS_FLAT_CARD_STYLE, padding: '10px 14px' }}
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    style={{ width: 8, height: 8, borderRadius: 4, background: stateColor, flexShrink: 0 }}
                  />
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
                    {server.serverId}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {server.toolCount} 个工具 · {server.resourceCount} 个资源
                  </span>
                </div>
                {server.toolNames.length > 0 && (
                  <p className="text-[11px] leading-5" style={{ color: 'var(--text-light)', margin: '4px 0 0 16px' }}>
                    {server.toolNames.join('、')}{server.toolCount > server.toolNames.length ? ' …' : ''}
                  </p>
                )}
                {server.clientConnected && server.resourceCount > 0 && (
                  <button
                    type="button"
                    className="ml-4 mt-1 text-[11px]"
                    onClick={() => { void loadResources(server.serverId) }}
                  >
                    查看可选资源
                  </button>
                )}
                {resourceCatalogs[server.serverId]?.resources.map((resource) => (
                  <div key={resource.uri} className="ml-4 mt-1 flex items-center justify-between gap-3 text-[11px]">
                    <span style={{ color: 'var(--text-light)' }}>{resource.name || resource.uri}</span>
                    <button type="button" onClick={() => { void attachResource(server.serverId, resource) }}>
                      加到下一条消息
                    </button>
                  </div>
                ))}
                {(resourceCatalogs[server.serverId]?.resourceTemplates.length || 0) > 0 && (
                  <p className="ml-4 mt-1 text-[11px]" style={{ color: 'var(--text-light)' }}>
                    资源模板需填齐参数后才能读取。
                  </p>
                )}
                {(server.serverInfo || server.instructions) && (
                  <details className="ml-4 mt-1 text-[11px]" style={{ color: 'var(--text-light)' }}>
                    <summary>Server 信息</summary>
                    {server.serverInfo && <pre className="whitespace-pre-wrap">{JSON.stringify(server.serverInfo, null, 2)}</pre>}
                    {server.instructions && <p className="whitespace-pre-wrap">{server.instructions}</p>}
                  </details>
                )}
                {server.lastError && (
                  <p className="text-[11px] leading-5" style={{ color: 'var(--status-error, #d4553f)', margin: '4px 0 0 16px' }}>
                    {server.lastError}
                  </p>
                )}
                {server.stderrTail && (
                  <p className="text-[11px] leading-5" style={{ color: 'var(--text-light)', margin: '4px 0 0 16px', whiteSpace: 'pre-wrap' }}>
                    {server.stderrTail}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section
        aria-labelledby="mcp-config-heading"
        className="rounded-2xl border"
        style={{ ...SETTINGS_FLAT_CARD_STYLE, padding: '16px 18px' }}
      >
        <h4
          id="mcp-config-heading"
          className="text-[13px] font-medium"
          style={{ color: 'var(--text-title)', margin: 0 }}
        >
          Server 配置
        </h4>
        <p className="text-[11px] leading-5" style={{ color: 'var(--text-light)', margin: '4px 0 8px', maxWidth: 640 }}>
          命令和参数分开保存，不经过 shell。环境变量已有的值只显示为已配置。
        </p>
        <div className="flex flex-col gap-3">
          {configs.map((server, index) => (
            <div key={`${server.id}-${index}`} className="rounded-xl border p-3" style={SETTINGS_SUBTLE_CARD_STYLE}>
              <div className="grid grid-cols-2 gap-2">
                <input value={server.id} placeholder="server id" onChange={(event) => updateServer(index, { id: event.target.value })} className="rounded-lg border px-2 py-1.5 text-[12px]" />
                <input value={server.displayName} placeholder="显示名称" onChange={(event) => updateServer(index, { displayName: event.target.value })} className="rounded-lg border px-2 py-1.5 text-[12px]" />
              </div>
              <input value={server.command} placeholder="本地命令路径" onChange={(event) => updateServer(index, { command: event.target.value })} className="mt-2 w-full rounded-lg border px-2 py-1.5 text-[12px]" />
              <textarea value={server.args.join('\n')} placeholder="每行一个参数" onChange={(event) => updateServer(index, { args: event.target.value.split('\n').filter(Boolean) })} rows={3} className="mt-2 w-full rounded-lg border px-2 py-1.5 text-[12px]" />
              <div className="mt-2 flex items-center gap-3 text-[12px]">
                <label><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(index, { enabled: event.target.checked })} /> 启用</label>
                <select value={server.approvalMode} onChange={(event) => updateServer(index, { approvalMode: event.target.value as ElectronMcpServerConfig['approvalMode'] })} className="rounded-lg border px-2 py-1.5">
                  <option value="always">每次确认</option>
                  <option value="writes">写入时确认</option>
                  <option value="never">始终允许</option>
                </select>
                <button type="button" onClick={() => { setDraftTouched(true); setConfigs((current) => current.filter((_, itemIndex) => itemIndex !== index)) }}>删除</button>
              </div>
              {server.envEntries.map((entry, envIndex) => (
                <div key={`${entry.key}-${envIndex}`} className="mt-2 grid grid-cols-2 gap-2">
                  <input value={entry.key} placeholder="ENV_KEY" onChange={(event) => updateServer(index, { envEntries: server.envEntries.map((item, itemIndex) => itemIndex === envIndex ? { ...item, key: event.target.value } : item) })} className="rounded-lg border px-2 py-1.5 text-[12px]" />
                  <input type="password" value={entry.value} placeholder={entry.hasStoredValue ? '已配置（留空保持）' : '值'} onChange={(event) => updateServer(index, { envEntries: server.envEntries.map((item, itemIndex) => itemIndex === envIndex ? { ...item, value: event.target.value } : item) })} className="rounded-lg border px-2 py-1.5 text-[12px]" />
                </div>
              ))}
              <button type="button" className="mt-2 text-[11px]" onClick={() => updateServer(index, { envEntries: [...server.envEntries, { key: '', value: '' }] })}>+环境变量</button>
            </div>
          ))}
          <button type="button" onClick={() => { setDraftTouched(true); setConfigs((current) => [...current, { ...EMPTY_SERVER, envEntries: [] }]) }} className="rounded-xl border px-3 py-2 text-[12px]" style={SETTINGS_SECONDARY_BUTTON_STYLE}>+ 添加 server</button>
        </div>
        <details className="mt-3 text-[11px]" style={{ color: 'var(--text-light)' }}>
          <summary>查看规范化配置</summary>
          <pre className="mt-2 overflow-auto rounded-lg p-2" style={{ background: 'var(--surface-muted)' }}>{JSON.stringify(configs.map((server) => ({ ...server, envEntries: server.envEntries.map((entry) => ({ key: entry.key, value: entry.value ? '••••••' : entry.hasStoredValue ? '••••••' : '' })) })), null, 2)}</pre>
        </details>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-mcp-control="save-config"
            disabled={busy || !hasApi}
            onClick={() => { void handleSave(false) }}
            className="inline-flex items-center gap-1.5 rounded-xl border text-[12px] font-medium"
            style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '7px 12px', opacity: busy ? 0.6 : 1 }}
          >
            保存
          </button>
          <button
            type="button"
            data-mcp-control="save-and-reload"
            disabled={busy || !hasApi}
            onClick={() => { void handleSave(true) }}
            className="inline-flex items-center gap-1.5 rounded-xl border text-[12px] font-medium"
            style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '7px 12px', opacity: busy ? 0.6 : 1 }}
          >
            保存并重连
          </button>
          {feedback && (
            <span
              className="text-[11px]"
              style={{ color: feedback.tone === 'ok' ? 'var(--text-muted)' : 'var(--status-error, #d4553f)' }}
            >
              {feedback.text}
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
