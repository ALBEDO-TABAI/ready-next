import type { MutableRefObject } from 'react'
import type { ModuleAgentActionHandler } from '../../utils/moduleAgentBridge'
import { buildRenderTimelineRequest, buildVideoProjectSchema } from './schema'
import type { TimelineClip } from './types'

function getPathBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

interface VideoRenderResult {
  success: true
  path: string
  message: string
}

interface VideoRenderErrorResult {
  success: false
  error: string
}

type VideoRenderPipelineResult = VideoRenderResult | VideoRenderErrorResult

export interface VideoAgentHandlerDeps {
  activeProjectTabId: string
  selectedFile: string | null
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  duration: number
  currentTime: number
  isPlaying: boolean
  zoom: number
  setVideoSessionSnapshot: (payload: {
    activeProjectId?: string | null
    primarySourcePath?: string | null
    schemaVersion?: 1 | null
    timelineHash?: string | null
    timelineSummary?: { videoClips: number; subtitleClips: number; audioClips: number; duration: number }
    previewState?: { currentTime: number; isPlaying: boolean; zoom: number }
    renderSpec?: { fps: number; width: number; height: number }
    lastArtifactPath?: string | null
  }) => void
  getTrackTypeFromPath: (path: string) => 'video' | 'subtitle' | 'audio' | null
  handleFileDrop: (path: string, name: string, type: 'video' | 'subtitle' | 'audio') => void
  runExportPipeline: () => Promise<VideoRenderPipelineResult>
  setExportState: (value: 'idle' | 'exporting' | 'done' | 'error') => void
  setExportMessage: (value: string) => void
  selectWorkspaceFile: (path: string | null) => void
  lastImportedSelectionRef: MutableRefObject<string | null>
  setVideoRenderJob: (payload: {
    status?: 'idle' | 'queued' | 'rendering' | 'done' | 'error'
    outputPath?: string | null
    message?: string | null
  }) => void
}

export function createVideoAgentHandler(deps: VideoAgentHandlerDeps): ModuleAgentActionHandler {
  const buildSchema = () => buildVideoProjectSchema({
    projectId: deps.activeProjectTabId,
    selectedFile: deps.selectedFile,
    videoClips: deps.videoClips,
    subtitleClips: deps.subtitleClips,
    audioClips: deps.audioClips,
    duration: deps.duration,
    currentTime: deps.currentTime,
    isPlaying: deps.isPlaying,
    zoom: deps.zoom,
  })

  return async ({ action, args }) => {
    if (action === 'video.captureSession') {
      const schema = buildSchema()
      const primarySource = schema.primarySourcePath
      return {
        intent: 'capture_video_session',
        ownerResourceId: primarySource,
        summary: primarySource
          ? `视频会话已捕获：主素材 ${getPathBasename(primarySource)}，共 ${schema.timeline.summary.videoClips} 个视频片段。`
          : '视频会话已捕获：当前尚未导入素材。',
        timelineHash: schema.timeline.hash,
        clipCounts: {
          video: schema.timeline.summary.videoClips,
          subtitle: schema.timeline.summary.subtitleClips,
          audio: schema.timeline.summary.audioClips,
        },
        duration: schema.composition.duration,
        schemaVersion: schema.schemaVersion,
      }
    }

    if (action === 'video.importMedia') {
      const path = String(args.path || '').trim()
      if (!path) throw new Error('video.importMedia 缺少 path')
      const trackType = deps.getTrackTypeFromPath(path)
      if (!trackType || trackType === 'subtitle') throw new Error('当前文件类型不能导入到时间线')
      deps.lastImportedSelectionRef.current = path
      deps.selectWorkspaceFile(path)
      deps.handleFileDrop(path, getPathBasename(path), trackType)
      return {
        intent: 'import_video_media',
        ownerResourceId: path,
        summary: `已将 ${getPathBasename(path)} 导入到 ${trackType === 'audio' ? '音轨' : '视频轨'}。`,
      }
    }

    if (action === 'video.inspectMedia') {
      const schema = buildSchema()
      const path = String(
        args.path
        || deps.selectedFile
        || schema.primarySourcePath
        || '',
      ).trim()
      if (!path) throw new Error('video.inspectMedia 缺少可用媒体路径')
      const infoResult = await window.electronAPI?.video?.getInfo?.(path)
      if (!infoResult?.success || !infoResult.data) {
        throw new Error(infoResult?.error || '读取媒体信息失败')
      }
      const data = infoResult.data
      return {
        intent: 'inspect_video_media',
        ownerResourceId: path,
        summary: `媒体信息已读取：${getPathBasename(path)}，时长 ${String(data.duration || 'unknown')} 秒。`,
        metadata: data,
      }
    }

    if (action === 'video.renderExport') {
      const schema = buildSchema()
      const explicitOutputPath = String(args.outputPath || '').trim()
      if (
        explicitOutputPath &&
        window.electronAPI?.video?.renderTimeline &&
        (
          schema.timeline.summary.videoClips > 0
          || schema.timeline.summary.audioClips > 0
          || schema.timeline.summary.subtitleClips > 0
        )
      ) {
        deps.setVideoRenderJob({ status: 'rendering', message: 'Rendering...', outputPath: explicitOutputPath })
        const renderResult = await window.electronAPI.video.renderTimeline(
          buildRenderTimelineRequest(schema, explicitOutputPath),
        )
        if (!renderResult?.success || !renderResult.path) {
          deps.setVideoRenderJob({ status: 'error', message: renderResult?.error || '渲染失败', outputPath: null })
          throw new Error(renderResult?.error || '渲染失败')
        }
        deps.setExportState('done')
        deps.setExportMessage(`Exported: ${renderResult.path}`)
        deps.setVideoRenderJob({ status: 'done', message: `Exported: ${renderResult.path}`, outputPath: renderResult.path })
        deps.setVideoSessionSnapshot({ lastArtifactPath: renderResult.path })
        return {
          intent: 'render_video_export',
          ownerResourceId: schema.primarySourcePath,
          summary: `视频已导出到 ${renderResult.path}.`,
          artifactRefs: [{
            kind: 'video-export',
            label: getPathBasename(renderResult.path),
            path: renderResult.path,
            mimeType: 'video/mp4',
          }],
          schemaVersion: schema.schemaVersion,
        }
      }

      const result = await deps.runExportPipeline()
      if (!result.success) {
        throw new Error(result.error || '导出失败')
      }
      deps.setVideoSessionSnapshot({ lastArtifactPath: result.path })
      return {
        intent: 'render_video_export',
        ownerResourceId: schema.primarySourcePath,
        summary: result.message,
        artifactRefs: [{
          kind: 'video-export',
          label: getPathBasename(result.path),
          path: result.path,
          mimeType: 'video/mp4',
        }],
        schemaVersion: schema.schemaVersion,
      }
    }

    throw new Error(`Unsupported video agent action: ${action}`)
  }
}
