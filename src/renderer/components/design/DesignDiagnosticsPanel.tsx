import { WORKBENCH_ROW_PADDING_X } from '../../modules/workbench/chrome'

interface DesignDiagnosticsPanelProps {
  activeFile: string | null
  isDirty: boolean
  saveStatus: string
  lastSavedAt: number | null
  lastError: string | null
  snapshotHash: string | null
  selectionSummary: string | null
  currentToolContext: string | null
  lastExportArtifactPath: string | null
}

function formatWhen(value: number | null): string {
  if (!value) return '未记录'
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function DesignDiagnosticsPanel({
  activeFile,
  isDirty,
  saveStatus,
  lastSavedAt,
  lastError,
  snapshotHash,
  selectionSummary,
  currentToolContext,
  lastExportArtifactPath,
}: DesignDiagnosticsPanelProps) {
  return (
    <div
      className="border-b py-3 text-[11px]"
      style={{
        borderColor: 'var(--border-default)',
        background: 'rgba(255,255,255,0.74)',
        color: 'var(--text-secondary)',
        paddingLeft: WORKBENCH_ROW_PADDING_X,
        paddingRight: WORKBENCH_ROW_PADDING_X,
      }}
    >
      <div className="mb-2 text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-light)' }}>
        Design Diagnostics
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <div>当前文件：{activeFile || '未保存草稿'}</div>
          <div>保存状态：{saveStatus}{isDirty ? ' · dirty' : ''}</div>
          <div>当前工具：{currentToolContext || '未记录'}</div>
          <div>选择状态：{selectionSummary || '未记录'}</div>
        </div>
        <div>
          <div>快照哈希：{snapshotHash || '未生成'}</div>
          <div>最近保存：{formatWhen(lastSavedAt)}</div>
          <div className="truncate">最近导出：{lastExportArtifactPath || '未导出'}</div>
          <div style={{ color: lastError ? 'var(--color-orange)' : 'var(--text-secondary)' }}>
            错误状态：{lastError || '无'}
          </div>
        </div>
      </div>
    </div>
  )
}
