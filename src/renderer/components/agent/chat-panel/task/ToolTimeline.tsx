import { useState } from 'react'
import {
  ChevronRight,
  FileText,
  FolderOpen,
  Globe2,
  Image,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import {
  resolveToolActivityPresentation,
  type ToolActivityKind,
} from '../../../../modules/agent/toolActivityPresentation'
import type {
  ToolTimelineItem,
  ToolTimelineStatus,
} from '../../../../modules/agent/toolTraceRows'
import { AgentStatusDot } from '../../../ui/dot-matrix/AgentStatusDot'
import type { TaskCardVisualState } from '../../../../modules/agent/task-status-vocabulary'
import { MessageCodeBlock } from '../markdown/MessageCodeBlock'

// ---------------------------------------------------------------------------
// 2026-07-10 activity-capsule — L2 工具时间线 + L3 逐条详情披露。
// 从 TaskCard.tsx 拆出（行数健康度台账 2026-07-10 预留缝）：TaskCard /
// ToolTraceCard 共用本组件族渲染「配对条目行 → 点开完整调用与输出」。
// L3 数据面：富事件（SDK executor）带 toolName / callDetail（入参 JSON 预览）
// / resultDetail（输出全文，main 侧脱敏截断）；瘦事件（orchestrator 输出流）
// 只有单行 text，L3 回退显示 callText / resultText。
// ---------------------------------------------------------------------------

export function CapsuleChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      style={{
        width: 12,
        height: 12,
        color: 'var(--rn-ink-3)',
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform var(--rn-d-2) var(--rn-ease-std)',
        flexShrink: 0,
      }}
      strokeWidth={2}
    />
  )
}

function timelineVisualState(status: ToolTimelineStatus): TaskCardVisualState {
  if (status === 'running') return 'running'
  if (status === 'error') return 'failed'
  return 'done'
}

export { resolveToolActivityPresentation }

function ToolActivityIcon({ kind }: { kind: ToolActivityKind }) {
  const Icon = {
    research: Search,
    browser: Globe2,
    image: Image,
    document: FileText,
    file: FolderOpen,
    skill: Sparkles,
    command: SquareTerminal,
    generic: Wrench,
  }[kind]
  return <Icon aria-hidden="true" size={12} strokeWidth={1.8} />
}

function ImageGenerationProgress() {
  return (
    <div
      className="ready-image-generation-progress"
      data-ready-image-generation-progress="true"
      role="img"
      aria-label="图片生成中"
    >
      <span className="ready-image-generation-dots" aria-hidden="true" />
      <span className="ready-image-generation-focus" aria-hidden="true" />
    </div>
  )
}

function DetailCodeBlock({ label, text, language }: { label: string; text: string; language: string }) {
  return (
    <div data-ready-tool-detail-code={label}>
      <MessageCodeBlock language={language} code={text} />
    </div>
  )
}

/**
 * L2 时间线的单个工具条目：一行标题（点 + 文本 + 时长 + chevron），点开
 * 后展示完整调用行与输出文本（L3）。`interactive=false` 用于运行态自动
 * 浮出的「最近动态」行（P0-2），只读不可点。
 */
export function ToolTimelineRow({
  item,
  isLast,
  open,
  onToggle,
  interactive = true,
}: {
  item: ToolTimelineItem
  isLast: boolean
  open?: boolean
  onToggle?: () => void
  interactive?: boolean
}) {
  const presentation = resolveToolActivityPresentation(item)
  const callDetailText = item.callDetail || item.callText
  const resultDetailText = item.resultDetail || item.resultText
  return (
    <div
      data-ready-tool-timeline-item={item.status}
      data-ready-tool-activity-kind={presentation.kind}
      className="ready-task-todo-row"
      style={{ display: 'flex', gap: 8 }}
    >
      <div
        aria-hidden="true"
        style={{ width: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}
      >
        <div
          className="ready-tool-activity-glyph"
          data-state={item.status}
          style={{ paddingTop: 3 }}
        >
          <ToolActivityIcon kind={presentation.kind} />
          <span className="ready-tool-activity-status">
            <AgentStatusDot state={timelineVisualState(item.status)} size={6} />
          </span>
        </div>
        {!isLast && (
          <div
            style={{
              width: 1,
              flex: 1,
              marginTop: 3,
              background: 'color-mix(in srgb, var(--rn-hair-2) 80%, transparent)',
            }}
          />
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1, paddingBottom: isLast ? 0 : 7 }}>
        <button
          type="button"
          disabled={!interactive}
          onClick={interactive ? onToggle : undefined}
          className="flex items-center gap-2 w-full text-left"
          style={{
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: interactive ? 'pointer' : 'default',
          }}
        >
          <span
            className="ready-task-todo-label t-meta"
            data-typography-role="meta"
            style={{
              minWidth: 0,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {presentation.title}
          </span>
          {item.durationLabel ? (
            <span
              className="t-data"
              data-typography-role="data"
              data-ready-tool-trace-duration="true"
              style={{ color: 'var(--rn-ink-3)', flexShrink: 0 }}
            >
              {item.durationLabel}
            </span>
          ) : null}
          {interactive ? <CapsuleChevron expanded={Boolean(open)} /> : null}
        </button>
        {presentation.kind === 'image' && item.status === 'running' ? <ImageGenerationProgress /> : null}
        {interactive && open ? (
          <div
            data-ready-tool-timeline-detail="true"
            style={{
              marginTop: 5,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
            }}
          >
            {item.toolName && !item.hideToolName ? (
              <div
                className="t-data"
                data-typography-role="data"
                data-ready-tool-timeline-tool-name="true"
                style={{ color: 'var(--rn-ink-3)' }}
              >
                {item.toolName}
              </div>
            ) : null}
            {callDetailText ? (
              <DetailCodeBlock
                label="调用"
                text={callDetailText}
                language={item.callDetail?.trim().startsWith('{') ? 'json' : '调用'}
              />
            ) : null}
            {resultDetailText ? (
              <DetailCodeBlock label="输出" text={resultDetailText} language="输出" />
            ) : (
              <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--rn-ink-3)' }}>
                执行中，尚无输出。
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** L2 工具时间线：条目级 L3 披露状态放本地（key 稳定时随 React 状态保留）。 */
export function ToolTimeline({ items }: { items: ToolTimelineItem[] }) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())
  if (items.length === 0) return null
  const toggle = (id: string) => {
    setOpenIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <div data-ready-tool-timeline="true" className="flex flex-col">
      {items.map((item, index) => (
        <ToolTimelineRow
          key={item.id}
          item={item}
          isLast={index === items.length - 1}
          open={openIds.has(item.id)}
          onToggle={() => toggle(item.id)}
        />
      ))}
    </div>
  )
}
