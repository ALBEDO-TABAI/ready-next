import { Plug2 } from 'lucide-react'
import {
  SETTINGS_FLAT_CARD_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../components/settings/settings-theme'

// Y0.7 §11.0b labeling branch: Settings MCP section renders a "not shipped" label
// with all controls visibly inert. The Stage T authorization plumbing
// (`src/main/modules/mcp/*` + `src/__tests__/mcp-tools-authorization.test.ts`)
// stays in-tree; real transport landing is deferred to Stage Z per
// `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md` §5b.
export function McpSettingsPanel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section
        aria-labelledby="mcp-not-shipped-heading"
        className="glass-surface-card rounded-2xl border"
        style={{ ...SETTINGS_SUBTLE_CARD_STYLE, padding: '18px 20px' }}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'var(--surface-muted)', color: 'var(--text-muted)' }}
          >
            <Plug2 className="h-4 w-4" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h3
              id="mcp-not-shipped-heading"
              className="text-[14px] font-semibold leading-6"
              style={{ color: 'var(--text-title)', margin: 0 }}
            >
              MCP 暂未发布 / MCP not shipped in this release
            </h3>
            <p
              className="text-[12px] leading-5"
              style={{ color: 'var(--text-muted)', margin: '4px 0 0', maxWidth: 640 }}
            >
              本版本不包含 MCP 客户端 transport；真实接入计划在 Stage Z 路线图中落地。See Stage Z roadmap for transport landing.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="mcp-install-disabled-heading"
        aria-disabled="true"
        className="rounded-2xl border"
        style={{
          ...SETTINGS_FLAT_CARD_STYLE,
          padding: '16px 18px',
          opacity: 0.55,
          pointerEvents: 'none',
        }}
      >
        <div className="min-w-0">
          <h4
            id="mcp-install-disabled-heading"
            className="text-[13px] font-medium"
            style={{ color: 'var(--text-title)', margin: 0 }}
          >
            MCP server install / configure (disabled)
          </h4>
          <p
            className="text-[11px] leading-5"
            style={{ color: 'var(--text-light)', margin: '4px 0 0', maxWidth: 640 }}
          >
            未发布期间不暴露安装与配置入口；占位组件保持未来界面的位置感，但所有操作不可点击。
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled
            aria-disabled="true"
            data-mcp-control="install-server"
            className="inline-flex items-center gap-1.5 rounded-xl border text-[12px] font-medium"
            style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '7px 12px', opacity: 0.6, cursor: 'not-allowed' }}
          >
            安装 MCP server（不可用）
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            data-mcp-control="configure-transport"
            className="inline-flex items-center gap-1.5 rounded-xl border text-[12px] font-medium"
            style={{ ...SETTINGS_SECONDARY_BUTTON_STYLE, padding: '7px 12px', opacity: 0.6, cursor: 'not-allowed' }}
          >
            配置 transport（不可用）
          </button>
        </div>
      </section>

      <section
        aria-labelledby="mcp-stage-t-plumbing-heading"
        className="rounded-2xl border"
        style={{ ...SETTINGS_FLAT_CARD_STYLE, padding: '14px 16px' }}
      >
        <h4
          id="mcp-stage-t-plumbing-heading"
          className="text-[12px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: 'var(--text-light)', margin: 0 }}
        >
          Stage T authorization plumbing — visibly inert
        </h4>
        <p
          className="text-[11px] leading-5"
          style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}
        >
          Stage T 已落地的 MCP 授权管道（<code>src/main/modules/mcp/*</code>）继续保留在仓库内并通过既有测试 <code>src/__tests__/mcp-tools-authorization.test.ts</code>。本版本不再向 UI 暴露任何 MCP 工具或登录入口；真实 transport 接入计划在 Stage Z 落地后再启用此处的入口。
        </p>
      </section>
    </div>
  )
}
