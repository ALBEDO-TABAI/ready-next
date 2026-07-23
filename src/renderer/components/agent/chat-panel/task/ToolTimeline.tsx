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
import { formatSingleLinePreview } from '../../../../modules/agent/toolTracePreview'
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
        color: 'var(--text-light)',
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 160ms ease',
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

export type ToolActivityKind =
  | 'research'
  | 'browser'
  | 'image'
  | 'document'
  | 'file'
  | 'skill'
  | 'command'
  | 'generic'

export interface ToolActivityPresentation {
  kind: ToolActivityKind
  title: string
}

function toolTimelineItemTitle(item: ToolTimelineItem): string {
  return formatSingleLinePreview(item.status === 'running' ? item.callText : (item.resultText || item.callText))
}

function toolNameFromItem(item: ToolTimelineItem): string {
  if (item.toolName) return item.toolName.toLowerCase()
  return item.callText?.match(/^([a-zA-Z_][\w:.-]*)\s*\(/)?.[1]?.toLowerCase() || ''
}

function toolDescriptor(item: ToolTimelineItem): string {
  if (!item.callDetail) return ''
  let detail: Record<string, unknown>
  try {
    const parsed = JSON.parse(item.callDetail) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    detail = parsed as Record<string, unknown>
  } catch {
    return ''
  }
  for (const key of ['query', 'url', 'prompt', 'title', 'name', 'relativePath', 'path', 'command']) {
    const value = detail[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const compact = formatSingleLinePreview(value.trim())
    return [...compact].length > 64 ? `${[...compact].slice(0, 63).join('')}…` : compact
  }
  return ''
}

function activityTitle(
  item: ToolTimelineItem,
  labels: { running: string; done: string; error: string },
): string {
  const label = labels[item.status]
  const descriptor = toolDescriptor(item)
  return descriptor ? `${label} · ${descriptor}` : label
}

type ToolActivityRule = {
  kind: ToolActivityKind
  matches: (name: string) => boolean
  labels: { running: string; done: string; error: string }
}

const TOOL_ACTIVITY_RULES: ToolActivityRule[] = [
  { kind: 'research', matches: (name) => name === 'web_search_domains', labels: { running: '查询搜索范围', done: '搜索范围已确认', error: '搜索范围查询失败' } },
  { kind: 'research', matches: (name) => name === 'web_search', labels: { running: '搜索网页', done: '网页检索完成', error: '网页检索失败' } },
  { kind: 'research', matches: (name) => name === 'web_fetch', labels: { running: '读取网页', done: '网页已读取', error: '网页读取失败' } },
  { kind: 'research', matches: (name) => name === 'web_clip_url', labels: { running: '保存网页资料', done: '网页资料已保存', error: '网页资料保存失败' } },
  { kind: 'file', matches: (name) => name === 'present_file', labels: { running: '整理文件', done: '文件已整理', error: '文件整理失败' } },
  { kind: 'image', matches: (name) => name === 'generate_image', labels: { running: '生成图片', done: '图片已生成', error: '图片生成失败' } },
  { kind: 'browser', matches: (name) => name.startsWith('browser_') || name === 'use_browser', labels: { running: '操作网页', done: '网页操作完成', error: '网页操作失败' } },
  { kind: 'document', matches: (name) => name.startsWith('document_') || name.startsWith('widget_'), labels: { running: '处理文档', done: '文档处理完成', error: '文档处理失败' } },
  { kind: 'file', matches: (name) => name.startsWith('file_') || name.startsWith('tag_forge_') || name === 'apply_patch' || /^skill_(?:read|write|export)_artifact$/.test(name), labels: { running: '处理文件', done: '文件处理完成', error: '文件处理失败' } },
  { kind: 'command', matches: (name) => /command|shell|exec|stdin/.test(name), labels: { running: '运行本地命令', done: '本地命令完成', error: '本地命令失败' } },
  { kind: 'skill', matches: (name) => name === 'use_skill' || name.startsWith('skill_'), labels: { running: '运行技能', done: '技能运行完成', error: '技能运行失败' } },
]

export function resolveToolActivityPresentation(item: ToolTimelineItem): ToolActivityPresentation {
  const rule = TOOL_ACTIVITY_RULES.find((candidate) => candidate.matches(toolNameFromItem(item)))
  if (!rule) {
    return {
      kind: 'generic',
      title: toolTimelineItemTitle(item),
    }
  }
  return {
    kind: rule.kind,
    title: activityTitle(item, rule.labels),
  }
}

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
              background: 'color-mix(in srgb, var(--border-default) 80%, transparent)',
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
              style={{ color: 'var(--text-light)', flexShrink: 0 }}
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
            {item.toolName ? (
              <div
                className="t-data"
                data-typography-role="data"
                data-ready-tool-timeline-tool-name="true"
                style={{ color: 'var(--text-gray)' }}
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
              <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-light)' }}>
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
