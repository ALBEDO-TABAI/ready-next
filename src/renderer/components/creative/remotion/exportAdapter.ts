import { type TimelineClip } from '../../../pages/modes/VideoMode'

export interface TimelineExportProject {
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  duration: number
  fps: number
  width: number
  height: number
}

interface ExportSuccessResult {
  success: true
  path: string
  message: string
}

interface ExportErrorResult {
  success: false
  error: string
}

export type TimelineExportResult = ExportSuccessResult | ExportErrorResult

function toExportPathFromSource(inputPath: string): string {
  return inputPath.replace(/\.[^.]+$/, '') + `_export_${Date.now()}.mp4`
}

export async function exportTimelineWithFallback(project: TimelineExportProject): Promise<TimelineExportResult> {
  const firstVideoSource = project.videoClips.find((clip) => clip.source)?.source
  const firstAudioSource = project.audioClips.find((clip) => clip.source)?.source
  const primarySource = firstVideoSource || firstAudioSource

  if (!primarySource) {
    return { success: false, error: 'No source file found. Import a video or image clip first.' }
  }

  const outputPath = toExportPathFromSource(primarySource)

  // Future extension point: if main process provides an actual timeline renderer,
  // use it first and keep this fallback for environments without renderer support.
  const advancedRenderer = window.electronAPI?.video?.renderTimeline
  if (advancedRenderer) {
    const advancedResult = await advancedRenderer({
      output: outputPath,
      width: project.width,
      height: project.height,
      fps: project.fps,
      duration: project.duration,
      tracks: {
        video: project.videoClips,
        subtitle: project.subtitleClips,
        audio: project.audioClips,
      },
    })
    if (advancedResult?.success && advancedResult.path) {
      const warningSuffix = advancedResult.warning ? ` (${advancedResult.warning})` : ''
      return { success: true, path: advancedResult.path, message: `Exported: ${advancedResult.path}${warningSuffix}` }
    }
  }

  // Fallback: preserve existing behavior (trim first source clip).
  const firstSourceClip = project.videoClips.find((clip) => clip.source)
  if (!firstSourceClip?.source) {
    return { success: false, error: 'Advanced renderer unavailable and no video clip for trim fallback.' }
  }
  if (!window.electronAPI?.video?.trim) {
    return { success: false, error: 'Video export API is unavailable in current environment.' }
  }

  const trimResult = await window.electronAPI.video.trim({
    input: firstSourceClip.source,
    start: firstSourceClip.start,
    end: firstSourceClip.end,
    output: outputPath,
  })

  if (!trimResult?.success) {
    return { success: false, error: trimResult?.error || 'Export failed' }
  }

  return { success: true, path: trimResult.path || outputPath, message: `Exported: ${trimResult.path || outputPath}` }
}
