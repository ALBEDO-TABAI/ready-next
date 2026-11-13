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
import { WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM } from '../../../modules/workbench/chrome'
import type { ReferenceSkillHintData } from '../../../types/electron'
import type { ActionAuthorizationMode } from '../../../../shared/action-authorization-mode'
import type { CodexActionGate, CodexProductTurnActionProjection } from '../../../../shared/ipc-contracts/agent-runtime'
import { toLocalFileUrl } from '../../../utils/dragDrop'
import ChatMessages from '../ChatMessages'
import { ProjectSelector } from '../ProjectSelector'
import ChatInput, { type ChatInputHandle } from '../ChatInput'
import { SoftFailureCapsule } from '../SoftFailureCapsule'
import ChatAttachments from '../ChatAttachments'
import ContextMenu from '../../layout/ContextMenu'
import { Button, IconButton } from '../../ui'
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
import { browserHelpDisplayText } from '../../../modules/browser/browser-task-copy'

interface AgentSelectionMenuState {
  x: number
  y: number
  text: string
  boundary: { left: number; top: number; right: number; bottom: number }
}

interface ChatPanelBodyProps extends Omit<TaskToolSnapshotProps, 'children' | 'currentActivityNarration'> {
  messages: AgentMessage[]
  contextBoundaries?: import('../../../../shared/ipc-contracts/agent-runtime').CodexConversationContextBoundary[]
  lifecycleInputBlocked: boolean
  sendBlocker?: import('../../../modules/agent/composer-state').ComposerSendBlocker | null
  destructiveOperationPending?: boolean
  stopAvailable?: boolean
  stopPending: boolean
  stopError: string | null
  scopeRunStates: Record<string, ScopeRunState>
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: string | null
  toolTraceExpanded: boolean
  copiedMessageId: string | null
  productTurnActionProjectionByRunId: Record<string, CodexProductTurnActionProjection>
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
  /** The mode switch slot (V20), right of the project chip; the shell owns its state and handlers. */
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
  composerNotice?: {
    message: string
    errorKind: string
    recoveryActionRef?: import('../../../../shared/ipc-contracts/agent-runtime').CodexBeginNewContextActionRef
  } | null
  beginNewContextAvailable?: boolean
  onBeginNewContext?: () => void
  sendConsequence?: CodexActionGate['consequence']
  headUnavailable?: boolean
  onRefreshActionSurface?: () => void
  onDismissComposerNotice?: () => void
}

const CHAT_COMPOSER_FALLBACK_BOTTOM_INSET = 156

export function ChatPanelBody(props: ChatPanelBodyProps): React.ReactElement {
  const {
    messages,
    contextBoundaries = [],
    currentTaskRun,
    backgroundTaskRuns,
    liveTaskRuns,
    currentScopeId,
    scopeRunStates,
    taskDisclosureState,
    isStreaming,
    lifecycleInputBlocked,
    sendBlocker = null,
    destructiveOperationPending = false,
    stopAvailable = false,
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
    productTurnActionProjectionByRunId,
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
    beginNewContextAvailable = false,
    onBeginNewContext,
    sendConsequence = null,
    headUnavailable = false,
    onRefreshActionSurface,
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
  // A file held over the composer draws the drop ring in ink (the project pill's drop ring is the same).
  const composerShellStyle = {
    borderRadius: 'var(--rn-liquid-r)',
    background: 'transparent',
    border: isDragOver ? '2px solid var(--rn-ink-3)' : '1px solid transparent',
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
            messages={messages.map(message => {
              const display = message.meta?.readyRefDisplay
              if (display && typeof display === 'object' && 'content' in display && typeof display.content === 'string') return { ...message, content: display.content }
              const help = message.type === 'user' ? browserHelpDisplayText(message.content, message.meta) : null
              return help ? { ...message, content: help } : message
            })}
            contextBoundaries={contextBoundaries}
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
            productTurnActionProjectionByRunId={productTurnActionProjectionByRunId}
            showToolTraceCapsule={showToolTraceCapsule && shouldRenderGlobalToolTraceCapsule}
            bottomOverlayInset={composerBottomInset}
            onSetInputSuggestion={onSetInputSuggestion}
            onToggleToolTrace={onToggleToolTrace}
            onCopyMessage={onCopyMessage}
            onRetryProductTurn={onRetryProductTurn}
            onAgentSelectionContextMenu={onAgentSelectionContextMenu}
            onAttachmentPreview={handleAttachmentPreview}
            onReferenceSelect={onReferenceSelect}
            onRevealDocumentQuote={attachment => { void handleAttachmentPreview(attachment) }}
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

            {headUnavailable && (
              <div data-ready-action-state="head_unavailable" role="status" style={{ pointerEvents: 'auto' }}>
                暂时无法读取会话状态，草稿已保留。
                <button type="button" onClick={onRefreshActionSurface}>重新读取</button>
              </div>
            )}
            {beginNewContextAvailable && (
              <div data-ready-begin-new-context="true" role="status" style={{
                pointerEvents: 'auto', padding: '10px 12px', borderRadius: 'var(--rn-r-card)',
                background: 'var(--rn-inlay-hover)', boxShadow: 'inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2), var(--rn-shadow-1)',
                color: 'var(--rn-ink)', fontSize: 12, lineHeight: 1.6,
              }}>
                <p>当前会话暂时无法继续。已有消息会保留，重新开始后不会自动带入此前对话。</p>
                <Button variant="secondary" onClick={onBeginNewContext} className="mt-2 w-full" style={{ fontSize: 12 }}>
                  保留记录，开始新上下文
                </Button>
              </div>
            )}
            {sendConsequence && (
              <div data-ready-send-consequence="true" role="note">
                {sendConsequence.omittedItemCount === 1 ? '上一项' : `前面${sendConsequence.omittedItemCount}项`}
                不会作为当前任务带入；如仍需要，请完整重述。
                {sendConsequence.resourceReattachItemCount > 0
                  && `其中${sendConsequence.resourceReattachItemCount}项需重新附加资源。`}
              </div>
            )}

            {referenceSkillHint && (
              <div
                className="ready-liquid-card rn-float"
                data-reference-skill-hint="true"
                style={{
                  borderRadius: 18,
                  border: 'none',
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
                      style={{ width: 15, height: 15, color: 'var(--rn-ink-2)' }}
                      strokeWidth={2}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--rn-ink-3)',
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase'
                        }}
                      >
                        技能上下文
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: 'var(--rn-ink)',
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
                      color: 'var(--rn-ink-2)'
                    }}
                  >
                    上下文已启用
                  </div>
                </div>
              </div>
            )}

            {attachedSessionRecallCapsules.length > 0 && (
              <div
                data-session-recall-attachments="true"
                style={{
                  borderRadius: 12,
                  border: '.5px solid var(--rn-hair)',
                  background: 'var(--rn-fill)',
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
                    color: 'var(--rn-ink-3)',
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
                        borderColor: 'var(--rn-hair)',
                        padding: '8px 10px',
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 10
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--rn-ink)' }}>
                          {capsule.title}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--rn-ink-3)', marginTop: 2 }}>
                          {capsule.sourceKind}:{capsule.sourceId} · {formatTime(capsule.updatedAt)}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--rn-ink-2)',
                            marginTop: 4,
                            whiteSpace: 'pre-wrap'
                          }}
                        >
                          {capsule.summary}
                        </div>
                      </div>
                      <IconButton
                        icon={<X style={{ width: 12, height: 12 }} strokeWidth={2} />}
                        onClick={() => {
                          void onDetachSessionRecall(capsule.conversationId)
                        }}
                        title="移除旧会话引用"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <ChatAttachments
              attachments={attachments}
              onRemove={removeAttachment}
              onPreview={handleAttachmentPreview}
              onRevealDocumentQuote={attachment => { void handleAttachmentPreview(attachment) }}
              getDocumentQuoteTooltip={getDocumentQuoteTooltip}
              getAttachmentMetaSummary={getAttachmentMetaSummary}
              renderAttachmentIcon={(attachment, size = 16) => (
                <AttachmentIcon attachment={attachment} size={size} />
              )}
              toLocalFileUrl={toLocalFileUrl}
            />

            {bottomTaskCard}

            <div className="ready-chat-composer-context-row">
              <ProjectSelector />
              {modeSwitcher && (
                <div className="ready-chat-mode-tabs-dock" data-chat-mode-tabs-dock="true">{modeSwitcher}</div>
              )}
            </div>

            <ChatInput
              ref={chatInputRef}
              inputValue={inputValue}
              stopAvailable={stopAvailable}
              lifecycleInputBlocked={lifecycleInputBlocked}
              sendBlocker={sendBlocker}
              destructiveOperationPending={destructiveOperationPending}
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
