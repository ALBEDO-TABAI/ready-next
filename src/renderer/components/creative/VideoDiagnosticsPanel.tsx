import type { VideoRenderJobSnapshot } from '../../stores/useVideoSession'
import { WORKBENCH_ROW_PADDING_X } from '../../modules/workbench/chrome'

interface VideoDiagnosticsPanelProps {
  schemaVersion: 1 | null
  activeProjectId: string | null
  primarySourcePath: string | null
  timelineHash: string | null
  timelineSummary: {
    videoClips: number
    subtitleClips: number
    audioClips: number
    duration: number
  }
  renderSpec: {
    fps: number
    width: number
    height: number
  }
  previewState: {
    currentTime: number
    isPlaying: boolean
    zoom: number
  }
  renderJob: VideoRenderJobSnapshot
  lastArtifactPath: string | null
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

export default function VideoDiagnosticsPanel({
  schemaVersion,
  activeProjectId,
  primarySourcePath,
  timelineHash,
  timelineSummary,
  renderSpec,
  previewState,
  renderJob,
  lastArtifactPath,
}: VideoDiagnosticsPanelProps) {
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
        Video Diagnostics
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        <div>
          <div>Schema：v{schemaVersion || 1}</div>
          <div>项目：{activeProjectId || '未命名项目'}</div>
          <div className="truncate">主素材：{primarySourcePath || '未导入'}</div>
          <div>时间线：{timelineSummary.videoClips}/{timelineSummary.subtitleClips}/{timelineSummary.audioClips} clips · {timelineSummary.duration}s</div>
        </div>
        <div>
          <div>Render：{renderSpec.width}x{renderSpec.height} · {renderSpec.fps}fps</div>
          <div>播放状态：{previewState.isPlaying ? 'playing' : 'paused'} · {previewState.currentTime.toFixed(2)}s</div>
          <div>缩放：{previewState.zoom.toFixed(2)}x</div>
          <div>哈希：{timelineHash || '未生成'}</div>
        </div>
        <div>
          <div>渲染任务：{renderJob.status}</div>
          <div>最近更新：{formatWhen(renderJob.updatedAt)}</div>
          <div className="truncate">导出物：{lastArtifactPath || renderJob.outputPath || '未生成'}</div>
          <div className="truncate">消息：{renderJob.message || '无'}</div>
        </div>
      </div>
    </div>
  )
}
