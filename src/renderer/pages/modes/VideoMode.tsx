import EditorToolbar from '../../components/creative/EditorToolbar'
import PlaybackControls from '../../components/creative/PlaybackControls'
import PreviewCanvas from '../../components/creative/PreviewCanvas'
import PropertiesPanel from '../../components/creative/PropertiesPanel'
import Timeline from '../../components/creative/Timeline'
import VideoDiagnosticsPanel from '../../components/creative/VideoDiagnosticsPanel'
import WorkbenchProjectTabs from '../../components/workbench/WorkbenchProjectTabs'
import { useVideoAgentAdapter } from '../../modules/video/useVideoAgentAdapter'
import { useVideoTimelineEditor } from '../../modules/video/useVideoTimelineEditor'
import { useVideoSession } from '../../stores/useVideoSession'
import { useWorkspace } from '../../stores/useWorkspace'

export default function VideoMode() {
  const selectedFile = useWorkspace((state) => state.selectedFile)
  const selectWorkspaceFile = useWorkspace((state) => state.selectFile)
  const setVideoSessionSnapshot = useVideoSession((state) => state.setSessionSnapshot)
  const setVideoRenderJob = useVideoSession((state) => state.setRenderJob)
  const videoSchemaVersion = useVideoSession((state) => state.schemaVersion)
  const videoTimelineHash = useVideoSession((state) => state.timelineHash)
  const videoTimelineSummary = useVideoSession((state) => state.timelineSummary)
  const videoRenderSpec = useVideoSession((state) => state.renderSpec)
  const primarySourcePath = useVideoSession((state) => state.primarySourcePath)
  const renderJob = useVideoSession((state) => state.renderJob)
  const lastArtifactPath = useVideoSession((state) => state.lastArtifactPath)

  const timeline = useVideoTimelineEditor({
    selectedFile,
    selectWorkspaceFile,
    setVideoSessionSnapshot,
    setVideoRenderJob,
  })

  useVideoAgentAdapter({
    activeProjectTabId: timeline.activeProjectTabId,
    selectedFile,
    videoClips: timeline.videoClips,
    subtitleClips: timeline.subtitleClips,
    audioClips: timeline.audioClips,
    duration: timeline.duration,
    currentTime: timeline.currentTime,
    isPlaying: timeline.isPlaying,
    zoom: timeline.zoom,
    setVideoSessionSnapshot,
    setVideoRenderJob,
    getTrackTypeFromPath: timeline.getTrackTypeFromPath,
    handleFileDrop: timeline.handleFileDrop,
    runExportPipeline: timeline.runExportPipeline,
    setExportState: timeline.setExportState,
    setExportMessage: timeline.setExportMessage,
    selectWorkspaceFile,
    lastImportedSelectionRef: timeline.lastImportedSelectionRef,
  })

  return (
    <div
      className="workbench-mode-root relative"
      onDragOver={timeline.handleRootDragOver}
      onDragLeave={timeline.handleRootDragLeave}
      onDrop={timeline.handleRootDrop}
      style={{
        background: timeline.videoDropActive ? 'var(--color-blue-light)' : 'var(--bg-primary)',
        transition: 'background 0.15s ease',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <input
        ref={timeline.importInputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        onChange={timeline.handleImportPickerChange}
        style={{ display: 'none' }}
      />

      {timeline.videoDropActive && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ zIndex: 40 }}
        >
          <div
            className="glass-surface-floating"
            style={{
              padding: '10px 16px',
              borderRadius: 12,
              border: '1px dashed var(--color-blue)',
              background: 'var(--surface-floating-bg)',
              color: 'var(--color-blue)',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            松开以导入到时间线（图片/视频到视频轨，音频到音轨）
          </div>
        </div>
      )}

      <WorkbenchProjectTabs
        layoutId="video-tabs"
        tabs={timeline.projectTabs.map((tab) => ({
          id: tab.id,
          label: tab.name,
          title: tab.path || tab.name,
          dotColor: tab.id === timeline.activeProjectTabId ? 'var(--color-blue)' : undefined,
          active: tab.id === timeline.activeProjectTabId,
        }))}
        onTabClick={(id) => {
          const tab = timeline.projectTabs.find((item) => item.id === id)
          timeline.handleProjectTabClick(id, tab?.path)
        }}
        onTabDragStart={(event, id) => {
          const tab = timeline.projectTabs.find((item) => item.id === id)
          if (tab) timeline.handleProjectTabDragStart(event, tab)
        }}
      />

      <EditorToolbar
        title={timeline.toolbarTitle}
        activeTool={timeline.activeTool}
        onToolChange={timeline.setActiveTool}
        onImportMedia={timeline.handleToolbarImportMedia}
        onUndo={timeline.handleUndo}
        onRedo={timeline.handleRedo}
        canUndo={timeline.history.length > 0}
        canRedo={timeline.future.length > 0}
        onExport={() => {
          void timeline.handleExport()
        }}
        exportState={timeline.exportState}
        exportMessage={timeline.exportMessage}
      />

      <VideoDiagnosticsPanel
        schemaVersion={videoSchemaVersion}
        activeProjectId={timeline.activeProjectTabId}
        primarySourcePath={primarySourcePath}
        timelineHash={videoTimelineHash}
        timelineSummary={videoTimelineSummary}
        renderSpec={videoRenderSpec}
        previewState={timeline.videoProjectSchema.previewState}
        renderJob={renderJob}
        lastArtifactPath={lastArtifactPath}
      />

      <div className="flex-1 flex overflow-hidden" style={{ minHeight: 0, background: 'var(--bg-content)' }}>
        <PreviewCanvas
          currentTime={timeline.currentTime}
          duration={timeline.duration}
          isPlaying={timeline.isPlaying}
          onTogglePlay={timeline.handleTogglePlay}
          onTimeUpdate={timeline.handlePreviewTimeUpdate}
          onPlaybackEnded={timeline.handlePreviewEnded}
          videoClips={timeline.videoClips}
          subtitleClips={timeline.subtitleClips}
          audioClips={timeline.audioClips}
          selectedClip={timeline.selectedClip}
          subtitleStyle={timeline.subtitleStyle}
          isMuted={timeline.isMuted}
        />
        <PropertiesPanel
          selectedClip={timeline.selectedClip}
          videoClips={timeline.videoClips}
          subtitleClips={timeline.subtitleClips}
          audioClips={timeline.audioClips}
          subtitleStyle={timeline.subtitleStyle}
          onSubtitleStyleChange={timeline.setSubtitleStyle}
          onClipUpdate={timeline.handleClipUpdate}
        />
      </div>

      <PlaybackControls
        currentTime={timeline.currentTime}
        duration={timeline.duration}
        isPlaying={timeline.isPlaying}
        onTogglePlay={timeline.handleTogglePlay}
        onPrevFrame={timeline.handlePrevFrame}
        onNextFrame={timeline.handleNextFrame}
        zoom={timeline.zoom}
        onZoomChange={timeline.setZoom}
      />

      <div style={{ height: 278, minHeight: 278 }}>
        <Timeline
          videoClips={timeline.videoClips}
          subtitleClips={timeline.subtitleClips}
          audioClips={timeline.audioClips}
          currentTime={timeline.currentTime}
          duration={timeline.duration}
          zoom={timeline.zoom}
          selectedClip={timeline.selectedClip}
          onTimeChange={timeline.handleSetCurrentTime}
          onSelectClip={timeline.handleSelectClip}
          onClipMove={timeline.handleClipMove}
          onFileDrop={timeline.handleFileDrop}
          onClipTrim={timeline.handleClipTrim}
          onDragStart={timeline.handleDragStart}
        />
      </div>
    </div>
  )
}
