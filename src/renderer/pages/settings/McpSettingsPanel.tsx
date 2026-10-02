import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { SettingsCard, SettingsStatus, SettingsSwitch, settingsButtonClass } from './settings-shared'
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
    <div className="flex flex-col gap-5">
      <SettingsCard
        aria-labelledby="mcp-servers-heading"
        title={<span id="mcp-servers-heading">MCP server（stdio）</span>}
        description="仅连接本地 stdio server。工具会以 mcp_ 前缀进入 Agent 工具面，是否执行前确认由每个 server 的策略决定。"
        actions={(
          <button
            type="button"
            data-mcp-control="refresh-status"
            onClick={() => { void refreshStatus() }}
            className={settingsButtonClass('secondary', { size: 'sm' })}
          >
            <RefreshCw strokeWidth={2} />
            刷新
          </button>
        )}
      >
        {servers.length === 0 && (
          <div className="sx-card__body text-[12px] leading-5" style={{ color: 'var(--sx-muted)' }}>
            尚未配置 MCP server——在下方添加配置并「保存并重连」。
          </div>
        )}
        {servers.map((server, serverIndex) => {
          const tone = server.lastError ? 'danger' : server.clientConnected ? 'accent' : 'neutral'
          return (
            <div
              key={server.serverId}
              data-mcp-server={server.serverId}
              className="flex flex-col gap-1.5 px-6 py-4"
              style={{ borderTop: serverIndex > 0 ? '1px solid var(--sx-divider)' : undefined }}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-medium" style={{ color: 'var(--sx-title)' }}>
                      {server.serverId}
                    </span>
                    <span className="sx-meta shrink-0">
                      {server.toolCount} 个工具 · {server.resourceCount} 个资源
                    </span>
                  </div>
                </div>
                <SettingsStatus tone={tone}>
                  {server.lastError ? '连接失败' : server.clientConnected ? '已连接' : '未连接'}
                </SettingsStatus>
              </div>
              {server.toolNames.length > 0 && (
                <p className="sx-mono m-0 text-[11.5px] leading-5" style={{ color: 'var(--sx-muted)' }}>
                  {server.toolNames.join('、')}{server.toolCount > server.toolNames.length ? ' …' : ''}
                </p>
              )}
              {server.lastError && (
                <p className="sx-text-danger m-0 text-[12px] leading-5">
                  {server.lastError}
                </p>
              )}
              {server.stderrTail && (
                <pre className="sx-inset sx-mono m-0 whitespace-pre-wrap px-3 py-2 text-[11px] leading-5" style={{ color: 'var(--sx-muted)' }}>
                  {server.stderrTail}
                </pre>
              )}
              {server.clientConnected && server.resourceCount > 0 && (
                <div>
                  <button
                    type="button"
                    className={settingsButtonClass('ghost', { size: 'sm' })}
                    style={{ marginLeft: -11 }}
                    onClick={() => { void loadResources(server.serverId) }}
                  >
                    查看可选资源
                  </button>
                </div>
              )}
              {(resourceCatalogs[server.serverId]?.resources.length || 0) > 0 && (
                <div className="sx-inset flex flex-col py-1">
                  {resourceCatalogs[server.serverId]?.resources.map((resource) => (
                    <div key={resource.uri} className="flex items-center justify-between gap-3 py-0.5 pl-3 pr-1 text-[12px]">
                      <span className="min-w-0 truncate" style={{ color: 'var(--sx-body)' }}>{resource.name || resource.uri}</span>
                      <button
                        type="button"
                        className={settingsButtonClass('ghost', { size: 'sm' })}
                        onClick={() => { void attachResource(server.serverId, resource) }}
                      >
                        <Plus strokeWidth={2} />
                        加到下一条消息
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {(resourceCatalogs[server.serverId]?.resourceTemplates.length || 0) > 0 && (
                <p className="sx-meta m-0">
                  资源模板需填齐参数后才能读取。
                </p>
              )}
              {(server.serverInfo || server.instructions) && (
                <details className="text-[12px]" style={{ color: 'var(--sx-muted)' }}>
                  <summary className="cursor-pointer select-none" style={{ color: 'var(--sx-body)' }}>Server 信息</summary>
                  {server.serverInfo && (
                    <pre className="sx-inset sx-mono mt-2 whitespace-pre-wrap px-3 py-2 text-[11px] leading-5">{JSON.stringify(server.serverInfo, null, 2)}</pre>
                  )}
                  {server.instructions && <p className="mt-2 whitespace-pre-wrap">{server.instructions}</p>}
                </details>
              )}
            </div>
          )
        })}
      </SettingsCard>

      <SettingsCard
        aria-labelledby="mcp-config-heading"
        title={<span id="mcp-config-heading">Server 配置</span>}
        description="命令和参数分开保存，不经过 shell。环境变量已有的值只显示为已配置。"
      >
        <div className="sx-card__body flex flex-col gap-3">
          {configs.map((server, index) => (
            <div key={`${server.id}-${index}`} className="sx-inset flex flex-col gap-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="sx-field">
                  <span className="sx-field__label">Server ID</span>
                  <input value={server.id} placeholder="server id" onChange={(event) => updateServer(index, { id: event.target.value })} className="sx-input sx-input--mono" />
                </label>
                <label className="sx-field">
                  <span className="sx-field__label">显示名称</span>
                  <input value={server.displayName} placeholder="显示名称" onChange={(event) => updateServer(index, { displayName: event.target.value })} className="sx-input" />
                </label>
              </div>
              <label className="sx-field">
                <span className="sx-field__label">命令</span>
                <input value={server.command} placeholder="本地命令路径" onChange={(event) => updateServer(index, { command: event.target.value })} className="sx-input sx-input--mono" />
              </label>
              <label className="sx-field">
                <span className="sx-field__label">参数</span>
                <textarea value={server.args.join('\n')} placeholder="每行一个参数" onChange={(event) => updateServer(index, { args: event.target.value.split('\n').filter(Boolean) })} rows={3} className="sx-textarea sx-input--mono" style={{ minHeight: 72 }} />
              </label>
              {server.envEntries.length > 0 && (
                <div className="sx-field">
                  <span className="sx-field__label">环境变量</span>
                  {server.envEntries.map((entry, envIndex) => (
                    <div key={`${entry.key}-${envIndex}`} className="grid grid-cols-2 gap-3">
                      <input value={entry.key} placeholder="ENV_KEY" onChange={(event) => updateServer(index, { envEntries: server.envEntries.map((item, itemIndex) => itemIndex === envIndex ? { ...item, key: event.target.value } : item) })} className="sx-input sx-input--mono" />
                      <input type="password" value={entry.value} placeholder={entry.hasStoredValue ? '已配置（留空保持）' : '值'} onChange={(event) => updateServer(index, { envEntries: server.envEntries.map((item, itemIndex) => itemIndex === envIndex ? { ...item, value: event.target.value } : item) })} className="sx-input" />
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <SettingsSwitch
                  checked={server.enabled}
                  label="启用"
                  ariaLabel={`启用 ${server.displayName || server.id || 'server'}`}
                  onChange={(checked) => updateServer(index, { enabled: checked })}
                />
                <select
                  value={server.approvalMode}
                  aria-label="执行前确认策略"
                  onChange={(event) => updateServer(index, { approvalMode: event.target.value as ElectronMcpServerConfig['approvalMode'] })}
                  className="sx-select"
                >
                  <option value="always">每次确认</option>
                  <option value="writes">写入时确认</option>
                  <option value="never">始终允许</option>
                </select>
                <button
                  type="button"
                  className={settingsButtonClass('ghost', { size: 'sm' })}
                  onClick={() => updateServer(index, { envEntries: [...server.envEntries, { key: '', value: '' }] })}
                >
                  <Plus strokeWidth={2} />
                  环境变量
                </button>
                <button
                  type="button"
                  className={settingsButtonClass('danger-quiet', { size: 'sm', className: 'ml-auto' })}
                  onClick={() => { setDraftTouched(true); setConfigs((current) => current.filter((_, itemIndex) => itemIndex !== index)) }}
                >
                  <Trash2 strokeWidth={2} />
                  删除
                </button>
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={() => { setDraftTouched(true); setConfigs((current) => [...current, { ...EMPTY_SERVER, envEntries: [] }]) }}
              className={settingsButtonClass('secondary')}
            >
              <Plus strokeWidth={2} />
              添加 server
            </button>
          </div>
          <details className="text-[12px]" style={{ color: 'var(--sx-muted)' }}>
            <summary className="cursor-pointer select-none" style={{ color: 'var(--sx-body)' }}>查看规范化配置</summary>
            <pre className="sx-inset sx-mono mt-2 overflow-auto px-3 py-2 text-[11px] leading-5">{JSON.stringify(configs.map((server) => ({ ...server, envEntries: server.envEntries.map((entry) => ({ key: entry.key, value: entry.value ? '••••••' : entry.hasStoredValue ? '••••••' : '' })) })), null, 2)}</pre>
          </details>
        </div>
        <div className="sx-card__footer justify-between">
          <div className="min-w-0 text-[12px] leading-5">
            {feedback && (
              <span
                className={`inline-flex items-start gap-1.5 ${feedback.tone === 'ok' ? '' : 'sx-text-danger'}`}
                style={feedback.tone === 'ok' ? { color: 'var(--sx-body)' } : undefined}
              >
                {feedback.tone === 'ok'
                  ? <Check className="mt-[3px] h-3.5 w-3.5 shrink-0" strokeWidth={2.4} />
                  : <XCircle className="mt-[3px] h-3.5 w-3.5 shrink-0" />}
                {feedback.text}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-mcp-control="save-config"
              disabled={busy || !hasApi}
              onClick={() => { void handleSave(false) }}
              className={settingsButtonClass('secondary')}
            >
              保存
            </button>
            <button
              type="button"
              data-mcp-control="save-and-reload"
              disabled={busy || !hasApi}
              aria-busy={busy ? true : undefined}
              onClick={() => { void handleSave(true) }}
              className={settingsButtonClass('primary')}
            >
              保存并重连
            </button>
          </div>
        </div>
      </SettingsCard>
    </div>
  )
}
