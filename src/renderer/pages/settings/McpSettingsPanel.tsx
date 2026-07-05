import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plug2, RefreshCw } from 'lucide-react'
import {
  SETTINGS_FLAT_CARD_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../components/settings/settings-theme'
import type { ElectronMcpStatus } from '../../types/electron'

// Phase M 管理面（2026-07-05）：stdio transport 已实装，本面板从
// "not shipped" 占位升级为真实管理面 —— server 状态（注册工具数/连接/
// 错误）+ 配置编辑（mcp_servers_json，主进程同一 parser 校验，坏条目
// 原因逐条回显）+ 保存并重连。OAuth / per-scope 授权 UI 属第二阶段。
const CONFIG_PLACEHOLDER = `[
  {
    "id": "filesystem",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
  }
]`

export function McpSettingsPanel() {
  const [status, setStatus] = useState<ElectronMcpStatus | null>(null)
  const [configDraft, setConfigDraft] = useState('')
  const [draftTouched, setDraftTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const refreshStatus = useCallback(async () => {
    const api = window.electronAPI?.mcp
    if (!api) return
    try {
      const next = await api.getStatus()
      setStatus(next)
      setConfigDraft((current) => (draftTouched ? current : next.rawConfig))
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
      const saved = await api.saveConfig(configDraft)
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
  }, [busy, configDraft, refreshStatus])

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
                外部 MCP server 的工具会以 mcp_ 前缀进入 Agent 工具面；未声明只读的外部工具执行前需确认。远程 transport 与 OAuth 授权在后续版本开放。
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
              尚未配置 MCP server——在下方粘贴配置并「保存并重连」。
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
                    {server.toolCount} 个工具{server.requiresAuthorization ? '（需授权）' : ''}
                  </span>
                </div>
                {server.toolNames.length > 0 && (
                  <p className="text-[11px] leading-5" style={{ color: 'var(--text-light)', margin: '4px 0 0 16px' }}>
                    {server.toolNames.join('、')}{server.toolCount > server.toolNames.length ? ' …' : ''}
                  </p>
                )}
                {server.lastError && (
                  <p className="text-[11px] leading-5" style={{ color: 'var(--status-error, #d4553f)', margin: '4px 0 0 16px' }}>
                    {server.lastError}
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
          配置（mcp_servers_json）
        </h4>
        <p className="text-[11px] leading-5" style={{ color: 'var(--text-light)', margin: '4px 0 8px', maxWidth: 640 }}>
          JSON 数组，每项 id / command / args（stdio）。无效条目保存时会逐条给出原因，不会被静默丢弃。
        </p>
        <textarea
          value={configDraft}
          data-mcp-control="config-editor"
          onChange={(event) => {
            setConfigDraft(event.target.value)
            setDraftTouched(true)
          }}
          placeholder={CONFIG_PLACEHOLDER}
          spellCheck={false}
          rows={8}
          className="w-full rounded-xl border text-[12px]"
          style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            padding: '10px 12px',
            background: 'var(--surface-muted)',
            color: 'var(--text-title)',
            borderColor: 'var(--border-light, rgba(0,0,0,0.08))',
            resize: 'vertical',
            lineHeight: 1.6,
          }}
        />
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
