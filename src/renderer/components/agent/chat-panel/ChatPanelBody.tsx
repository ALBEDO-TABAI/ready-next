import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { X, Puzzle, Copy, StickyNote } from 'lucide-react'
import type {
  AttachmentPreviewState,
  AgentMessage,
  ChatAttachment,
  ScopeRunState,
  ToolTraceEvent,
} from '../../../stores/useAgent'
import type { ReadySkillReference } from '../../../modules/agent/chat-input-bridge'
import { revealDocumentQuoteAttachment } from '../../../modules/agent/document-quote-navigation'
import { WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM } from '../../../modules/workbench/chrome'
import type { ReferenceSkillHintData } from '../../../types/electron'
import type { ActionAuthorizationMode } from '../../../../shared/action-authorization-mode'
import { toLocalFileUrl } from '../../../utils/dragDrop'
import ChatMessages from '../ChatMessages'
import ChatInput, { type ChatInputHandle } from '../ChatInput'
import { SoftFailureCapsule } from '../SoftFailureCapsule'
import ChatAttachments from '../ChatAttachments'
import ContextMenu from '../../layout/ContextMenu'
import { LiquidSurfaceLayer } from '../../ui/liquid-glass/LiquidFloatingPanel'
import { MarkdownContent } from './markdown'
import ModelSelector from './model-selector/ModelSelector'
import {
  AttachmentIcon,
  getAttachmentPreviewSrc,
} from './attachments-preview'
import {
  getAttachmentMetaSummary,
  getDocumentQuoteTooltip,
} from './attachment-summary'
import { useAttachmentPreview } from './attachments-preview/use-attachment-preview'
import { formatTime } from './format-time'
import {
  TaskToolSnapshot,
  type TaskToolSnapshotProps,
} from './task-snapshot/TaskToolSnapshot'
import { buildRunDurationMeterModel, RunDurationMeter } from './RunDurationMeter'

interface AgentSelectionMenuState {
  x: number
  y: number
  text: string
  boundary: { left: number; top: number; right: number; bottom: number }
}

interface ChatPanelBodyProps extends Omit<TaskToolSnapshotProps, 'children' | 'currentActivityNarration'> {
  messages: AgentMessage[]
  lifecycleInputBlocked: boolean
  stopPending: boolean
  stopError: string | null
  scopeRunStates: Record<string, ScopeRunState>
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: string | null
  toolTraceExpanded: boolean
  copiedMessageId: string | null
  showToolTraceCapsule: boolean
  shouldRenderGlobalToolTraceCapsule: boolean
  onSetInputSuggestion: (value: string) => void
  onToggleToolTrace: () => void
  onCopyMessage: (id: string, content: string) => void | Promise<void>
  onRetryProductTurn: (readyRunId: string) => void | Promise<void>
  agentSelectionMenu: AgentSelectionMenuState | null
  onCloseAgentSelectionMenu: () => void
  copyTextToClipboard: (content: string) => boolean | Promise<boolean>
  onPasteSelectionToPet: () => void | Promise<void>
  onAgentSelectionContextMenu: (event: React.MouseEvent, selectedText: string) => void
  referenceSkillHint: ReferenceSkillHintData | null
  attachedSessionRecallCapsules: Array<{
    conversationId: string
    title: string
    sourceKind: string
    sourceId: string
    updatedAt: string
    summary: string
  }>
  onDetachSessionRecall: (conversationId: string) => void | Promise<void>
  dismissSoftError: (scopeId: string) => void
  modeSwitcher?: ReactNode
  attachments: ChatAttachment[]
  removeAttachment: (id: string) => void
  inputValue: string
  isChannelScope: boolean
  actionAuthorizationMode: ActionAuthorizationMode
  isDragOver: boolean
  filePool: ChatAttachment[]
  chatInputRef: RefObject<ChatInputHandle | null>
  onInputChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onPickFiles: () => void | Promise<void>
  onActionAuthorizationModeChange: (mode: ActionAuthorizationMode) => void | Promise<void>
  onSkillReference: (skill: ReadySkillReference) => void
  onReferenceSelect: (attachment: ChatAttachment) => void
  setActiveAttachmentPreview: (preview: AttachmentPreviewState | null) => void
  setAttachmentPreviewLoading: (loading: boolean) => void
  admissionReady?: boolean
  composerNotice?: { message: string; errorKind: string } | null
  onDismissComposerNotice?: () => void
}

const CHAT_COMPOSER_FALLBACK_BOTTOM_INSET = 156

export function ChatPanelBody(props: ChatPanelBodyProps): React.ReactElement {
  const {
    messages,
    currentTaskRun,
    backgroundTaskRuns,
    liveTaskRuns,
    currentScopeId,
    scopeRunStates,
    taskDisclosureState,
    isStreaming,
    lifecycleInputBlocked,
    stopPending,
    stopError,
    streamingMessageId,
    parseSerializedTaskSnapshot,
    parseSerializedToolTraceSnapshot,
    setTaskSectionExpanded,
    onOpenTaskArtifact,
    onOpenScope,
    onCancelDetachedTask,
    onCancelChildRun,
    toolTrace,
    toolTraceStatus,
    toolTraceExpanded,
    copiedMessageId,
    showToolTraceCapsule,
    shouldRenderGlobalToolTraceCapsule,
    onSetInputSuggestion,
    onToggleToolTrace,
    onCopyMessage,
    onRetryProductTurn,
    agentSelectionMenu,
    onCloseAgentSelectionMenu,
    copyTextToClipboard,
    onPasteSelectionToPet,
    onAgentSelectionContextMenu,
    referenceSkillHint,
    attachedSessionRecallCapsules,
    onDetachSessionRecall,
    dismissSoftError,
    modeSwitcher,
    attachments,
    removeAttachment,
    inputValue,
    isChannelScope,
    actionAuthorizationMode,
    isDragOver,
    filePool,
    chatInputRef,
    onInputChange,
    onSend,
    onStop,
    onPickFiles,
    onActionAuthorizationModeChange,
    onSkillReference,
    onReferenceSelect,
    admissionReady = true,
    composerNotice = null,
    onDismissComposerNotice,
    setActiveAttachmentPreview,
    setAttachmentPreviewLoading,
  } = props

  const composerOverlayRef = useRef<HTMLDivElement | null>(null)
  const [composerBottomInset, setComposerBottomInset] = useState(CHAT_COMPOSER_FALLBACK_BOTTOM_INSET)
  const currentRunForDurationMeter = currentScopeId ? scopeRunStates[currentScopeId] || null : null
  const currentRunDurationModel = buildRunDurationMeterModel(currentRunForDurationMeter, Date.now())
  const terminalDurationLabel = currentRunDurationModel && !currentRunDurationModel.live && currentTaskRun
    ? currentRunDurationModel.duration
    : null

  // 外壳保持透明：玻璃材质（折射/模糊/纱层）全部由 ChatInput 里的 LiquidLens 承担。
  const composerShellStyle = {
    borderRadius: 'var(--workbench-canvas-radius)',
    background: 'transparent',
    border: isDragOver ? '2px solid var(--color-blue)' : '1px solid transparent',
    boxShadow: 'none',
  } as CSSProperties

  useLayoutEffect(() => {
    const overlay = composerOverlayRef.current
    if (!overlay) return

    const updateInset = () => {
      const nextInset = Math.ceil(overlay.getBoundingClientRect().height)
      setComposerBottomInset((current) => (current === nextInset ? current : nextInset))
    }

    updateInset()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateInset) : null
    observer?.observe(overlay)
    return () => observer?.disconnect()
  }, [])

  const handleAttachmentPreview = useAttachmentPreview({
    setActiveAttachmentPreview,
    setAttachmentPreviewLoading,
  })

  return (
    <TaskToolSnapshot
      messages={messages}
      currentTaskRun={currentTaskRun}
      backgroundTaskRuns={backgroundTaskRuns}
      liveTaskRuns={liveTaskRuns}
      currentScopeId={currentScopeId}
      taskDisclosureState={taskDisclosureState}
      isStreaming={isStreaming}
      streamingMessageId={streamingMessageId}
      terminalDurationLabel={terminalDurationLabel}
      currentActivityNarration={currentRunForDurationMeter?.activityNarration ?? null}
      parseSerializedTaskSnapshot={parseSerializedTaskSnapshot}
      parseSerializedToolTraceSnapshot={parseSerializedToolTraceSnapshot}
      setTaskSectionExpanded={setTaskSectionExpanded}
      onOpenTaskArtifact={onOpenTaskArtifact}
      onOpenScope={onOpenScope}
      onCancelDetachedTask={onCancelDetachedTask}
      onCancelChildRun={onCancelChildRun}
    >
      {({
        messageTaskSnapshots,
        messageGeneratedImageArtifacts,
        messageToolTraceSnapshots,
        pendingTaskRun,
        pendingToolTrace,
        bottomTaskCard,
      }) => (
        <div
          className="ready-chat-body-glass-stack"
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ChatMessages
            messages={messages}
            messageTaskSnapshots={messageTaskSnapshots}
            messageGeneratedImageArtifacts={messageGeneratedImageArtifacts}
            messageToolTraceSnapshots={messageToolTraceSnapshots}
            pendingTaskRun={pendingTaskRun}
            pendingToolTrace={pendingToolTrace}
            runDurationMeter={terminalDurationLabel ? null : <RunDurationMeter run={currentRunForDurationMeter} />}
            isStreaming={isStreaming}
            streamingMessageId={streamingMessageId}
            toolTrace={toolTrace}
            toolTraceStatus={toolTraceStatus}
            toolTraceExpanded={toolTraceExpanded}
            copiedMessageId={copiedMessageId}
            showToolTraceCapsule={showToolTraceCapsule && shouldRenderGlobalToolTraceCapsule}
            bottomOverlayInset={composerBottomInset}
            onSetInputSuggestion={onSetInputSuggestion}
            onToggleToolTrace={onToggleToolTrace}
            onCopyMessage={onCopyMessage}
            onRetryProductTurn={onRetryProductTurn}
            onAgentSelectionContextMenu={onAgentSelectionContextMenu}
            onAttachmentPreview={handleAttachmentPreview}
            onReferenceSelect={onReferenceSelect}
            onRevealDocumentQuote={revealDocumentQuoteAttachment}
            getDocumentQuoteTooltip={getDocumentQuoteTooltip}
            getAttachmentMetaSummary={getAttachmentMetaSummary}
            getAttachmentPreviewSrc={getAttachmentPreviewSrc}
            renderAttachmentIcon={(attachment, size = 16) => (
              <AttachmentIcon attachment={attachment} size={size} />
            )}
            renderMarkdown={(content, streaming) => <MarkdownContent content={content} streaming={streaming} />}
          />

          {agentSelectionMenu && (
            <ContextMenu
              x={agentSelectionMenu.x}
              y={agentSelectionMenu.y}
              boundary={agentSelectionMenu.boundary}
              portal
              onClose={onCloseAgentSelectionMenu}
              items={[
                {
                  id: 'copy-selection',
                  label: '复制',
                  icon: <Copy style={{ width: 15, height: 15 }} strokeWidth={2} />,
                  onClick: () => {
                    void copyTextToClipboard(agentSelectionMenu.text)
                  },
                },
                {
                  id: 'pin-selection-to-pet',
                  label: '贴到便利贴',
                  icon: <StickyNote style={{ width: 15, height: 15 }} strokeWidth={2} />,
                  onClick: () => {
                    void onPasteSelectionToPet()
                  },
                },
              ]}
            />
          )}

          <div
            ref={composerOverlayRef}
            className="ready-chat-composer-overlay"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 30,
              padding: `10px 16px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
              borderTop: '1px solid transparent',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'transparent',
              backdropFilter: 'none',
              WebkitBackdropFilter: 'none',
              boxShadow: 'none',
              pointerEvents: 'none',
            }}
          >
            {(() => {
              const scopedRun = currentScopeId ? scopeRunStates[currentScopeId] : null
              const softError = scopedRun?.softError || null
              if (softError && currentScopeId) {
                return (
                  <SoftFailureCapsule
                    softError={softError}
                    onDismiss={() => dismissSoftError(currentScopeId)}
                  />
                )
              }
              if (!composerNotice) return null
              return (
                <SoftFailureCapsule
                  softError={{
                    message: composerNotice.message,
                    errorKind: composerNotice.errorKind,
                    toolName: null,
                    friendlyMessage: composerNotice.message,
                    technicalDetails: null,
                    receivedAt: new Date().toISOString(),
                  }}
                  onDismiss={() => onDismissComposerNotice?.()}
                />
              )
            })()}

            {referenceSkillHint && (
              <div
                className="ready-liquid-card"
                data-reference-skill-hint="true"
                style={{
                  borderRadius: 18,
                  border: 'none',
                  background: 'var(--ready-liquid-card-base-bg, rgba(248, 250, 252, 0.54))',
                  padding: '8px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  position: 'relative',
                  overflow: 'hidden',
                  isolation: 'isolate',
                }}
              >
                <LiquidSurfaceLayer
                  className="ready-liquid-popover__lens ready-liquid-card__lens"
                  radius={18}
                  blur={14}
                  withProjection={false}
                  saturation={1.18}
                  brightness={1.05}
                  contrast={0.84}
                />
                <div
                  className="ready-liquid-card__content"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    width: '100%',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <Puzzle
                      style={{ width: 15, height: 15, color: 'var(--accent-primary)' }}
                      strokeWidth={2}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--text-light)',
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase'
                        }}
                      >
                        技能上下文
                      </div>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: 'var(--text-body)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {referenceSkillHint.name || referenceSkillHint.id}
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      flexShrink: 0,
                      fontSize: 11,
                      color: 'var(--text-muted)'
                    }}
                  >
                    上下文已启用
                  </div>
                </div>
              </div>
            )}

            {attachedSessionRecallCapsules.length > 0 && (
              <div
                className="glass-surface-card"
                data-session-recall-attachments="true"
                style={{
                  borderRadius: 12,
                  border: '1px solid var(--border-default)',
                  background: 'color-mix(in srgb, var(--surface-panel-bg) 46%, transparent)',
                  padding: 10,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--text-light)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase'
                  }}
                >
                  当前轮已引用的旧会话
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {attachedSessionRecallCapsules.map((capsule) => (
                    <div
                      key={capsule.conversationId}
                      className="rounded-[8px] border"
                      style={{
                        borderColor: 'var(--border-default)',
                        padding: '8px 10px',
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 10
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-body)' }}>
                          {capsule.title}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-light)', marginTop: 2 }}>
                          {capsule.sourceKind}:{capsule.sourceId} · {formatTime(capsule.updatedAt)}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: 'var(--text-muted)',
                            marginTop: 4,
                            whiteSpace: 'pre-wrap'
                          }}
                        >
                          {capsule.summary}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void onDetachSessionRecall(capsule.conversationId)
                        }}
                        className="rounded-[8px] border transition-[background-color,border-color]"
                        style={{
                          flexShrink: 0,
                          width: 28,
                          height: 28,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderColor: 'var(--border-default)',
                          background: 'transparent'
                        }}
                        title="移除旧会话引用"
                      >
                        <X
                          style={{ width: 12, height: 12, color: 'var(--text-light)' }}
                          strokeWidth={2}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <ChatAttachments
              attachments={attachments}
              onRemove={removeAttachment}
              onPreview={handleAttachmentPreview}
              onRevealDocumentQuote={revealDocumentQuoteAttachment}
              getDocumentQuoteTooltip={getDocumentQuoteTooltip}
              getAttachmentMetaSummary={getAttachmentMetaSummary}
              renderAttachmentIcon={(attachment, size = 16) => (
                <AttachmentIcon attachment={attachment} size={size} />
              )}
              toLocalFileUrl={toLocalFileUrl}
            />

            {bottomTaskCard}

            {modeSwitcher}

            <ChatInput
              ref={chatInputRef}
              inputValue={inputValue}
              isStreaming={isStreaming}
              lifecycleInputBlocked={lifecycleInputBlocked}
              stopPending={stopPending}
              stopError={stopError}
              attachmentsCount={attachments.length}
              hasUserMessages={messages.some((m) => m.type === 'user')}
              isDragOver={isDragOver}
              contextUsage={currentRunForDurationMeter?.contextUsage ?? null}
              composerShellStyle={composerShellStyle}
              filePool={filePool}
              filePoolCount={filePool.length}
              isChannelScope={isChannelScope}
              actionAuthorizationMode={actionAuthorizationMode}
              onInputChange={onInputChange}
              onSend={onSend}
              onStop={onStop}
              onPickFiles={onPickFiles}
              onActionAuthorizationModeChange={onActionAuthorizationModeChange}
              onSkillReference={onSkillReference}
              onReferenceSelect={onReferenceSelect}
              renderAttachmentIcon={(attachment, size = 16) => (
                <AttachmentIcon attachment={attachment} size={size} />
              )}
              ModelSelector={ModelSelector}
              admissionReady={admissionReady}
            />
          </div>
        </div>
      )}
    </TaskToolSnapshot>
  )
}
