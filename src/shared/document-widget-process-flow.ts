/**
 * 流程说明图共享渲染器：骨架 `process_flow` 与 openui `flow_diagram` 的同一实现。
 *
 * 面向"科普流程/步骤说明/因果链"类需求：纵向编号步骤 + hairline 导轨 + 可选分支
 * chips + 可选 outcome 卡。纯 HTML/CSS 确定性布局，模型只给文本结构不给坐标。
 *
 * openui 的 nodes/edges 图结构经 `processFlowFromGraph()` 确定性转换：节点按给定顺序
 * 成为步骤，出度 ≥2 的节点展开分支 chips（保留边标签），不再摊平丢结构。
 */

import { z } from 'zod'
import { renderWidgetChrome, renderWidgetFoot, renderWidgetHeading } from './document-widget-chassis'
import { widgetVar } from './document-widget-theme'

export const processFlowBranchSchema = z.object({
  label: z.string().min(1),
  detail: z.string().optional(),
})

export const processFlowStepSchema = z.object({
  label: z.string().min(1),
  detail: z.string().optional(),
  kind: z.enum(['step', 'decision', 'milestone']).optional(),
  branches: z.array(processFlowBranchSchema).min(2).max(3).optional(),
})

export const processFlowPropsSchema = z.object({
  heading: z.string().optional(),
  subtitle: z.string().optional(),
  steps: z.array(processFlowStepSchema).min(2).max(10),
  outcome: z
    .object({
      label: z.string().min(1),
      detail: z.string().optional(),
    })
    .optional(),
  footer: z.string().optional(),
})

export type ProcessFlowProps = z.infer<typeof processFlowPropsSchema>
export type ProcessFlowStep = z.infer<typeof processFlowStepSchema>

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeRichText(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br/>')
}

const INK = widgetVar('ink')
const INK2 = widgetVar('ink2')
const INK3 = widgetVar('ink3')
const HAIR = widgetVar('hair')
const ACCENT = widgetVar('accent')

function renderBranches(branches: ProcessFlowStep['branches']): string {
  if (!branches || branches.length === 0) return ''
  // 分支：内容栏里一条竖 hairline 把几路选择收成一组，每路一行，不做底板。
  const rows = branches
    .map(
      (branch, index) => `<div data-flow-branch style="display:flex;align-items:baseline;gap:12px;min-width:0;">
      <span class="num" style="flex:none;font-size:10.5px;line-height:20px;color:${INK3};">${String.fromCharCode(65 + index)}</span>
      <div style="min-width:0;">
        <span style="font-size:14px;font-weight:600;line-height:22px;color:${INK};">${escapeHtml(branch.label)}</span>
        ${branch.detail ? `<span style="margin-left:10px;font-size:13px;line-height:20px;color:${INK2};">${escapeRichText(branch.detail)}</span>` : ''}
      </div>
    </div>`,
    )
    .join('')
  return `<div class="stack" style="gap:6px;margin-top:12px;padding-left:16px;border-left:1px solid ${HAIR};">${rows}</div>`
}

export function compileProcessFlow(props: ProcessFlowProps): string {
  const stepCount = props.steps.length
  // 序号落在标签栏（2 栏），步骤落在内容栏；只靠网格与留白排序，不画圆圈与导轨。
  const steps = props.steps
    .map((step, index) => {
      const isMilestone = step.kind === 'milestone'
      const branchLabel =
        step.kind === 'decision' && step.branches?.length
          ? `<span class="label" style="margin-left:10px;font-size:9.5px;">${step.branches.length} 路分支</span>`
          : ''
      return `<div data-flow-step data-flow-marker="${step.kind || 'step'}" class="num span-2" style="padding-top:3px;font-size:11.5px;line-height:16px;font-weight:500;color:${isMilestone ? ACCENT : INK3};">${String(index + 1).padStart(2, '0')}</div>
      <div class="span-10" style="min-width:0;">
        <div style="display:flex;align-items:baseline;flex-wrap:wrap;font-size:14.5px;font-weight:600;color:${INK};line-height:22px;">${escapeHtml(step.label)}${branchLabel}</div>
        ${step.detail ? `<div style="font-size:13px;color:${INK2};line-height:20px;margin-top:2px;text-wrap:pretty;">${escapeRichText(step.detail)}</div>` : ''}
        ${renderBranches(step.branches)}
      </div>`
    })
    .join('')

  const outcome = props.outcome
    ? `<div data-flow-outcome class="span-2" style="display:flex;align-items:center;gap:8px;padding-top:3px;"><span class="dot dot--active" style="width:6px;height:6px;"></span><span class="label" style="font-size:10px;color:${ACCENT};">OUTCOME</span></div>
      <div class="span-10" style="min-width:0;">
        <div style="font-size:14.5px;font-weight:600;color:${INK};line-height:22px;">${escapeHtml(props.outcome.label)}</div>
        ${props.outcome.detail ? `<div style="font-size:13px;color:${INK2};line-height:20px;margin-top:2px;">${escapeRichText(props.outcome.detail)}</div>` : ''}
      </div>`
    : ''

  return `<div class="card stack process-flow-widget" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'PROCESS', meta: `${stepCount} 步${props.outcome ? ' · 1 结果' : ''}` })}
    ${renderWidgetHeading(props.heading, props.subtitle)}
    <div data-fill="grid" class="grid" style="row-gap:20px;padding-top:4px;">${steps}${outcome}</div>
    ${renderWidgetFoot(props.footer)}
  </div>`
}

export interface ProcessGraphNode {
  id: string
  label: string
}

export interface ProcessGraphEdge {
  from: string
  to: string
  label?: string
}

/** openui flow_diagram 的 nodes/edges → 步骤结构的确定性转换（保留分支与边标签）。 */
export function processFlowFromGraph(
  heading: string | undefined,
  nodes: ProcessGraphNode[],
  edges: ProcessGraphEdge[],
): ProcessFlowProps {
  const labelById = new Map(nodes.map((node) => [node.id, node.label]))
  const outgoingOf = (id: string) => edges.filter((edge) => edge.from === id && labelById.has(edge.to))
  // 分支的终点若自身再无去向，就只以分支卡出现，不再重复成后续步骤。
  const terminalBranchTargets = new Set<string>()
  for (const node of nodes) {
    const outgoing = outgoingOf(node.id)
    if (outgoing.length < 2) continue
    for (const edge of outgoing.slice(0, 3)) {
      if (outgoingOf(edge.to).length === 0) terminalBranchTargets.add(edge.to)
    }
  }
  const steps: ProcessFlowStep[] = nodes
    .filter((node) => !terminalBranchTargets.has(node.id))
    .slice(0, 10)
    .map((node) => {
      const outgoing = outgoingOf(node.id)
      if (outgoing.length >= 2) {
        return {
          label: node.label,
          kind: 'decision' as const,
          branches: outgoing.slice(0, 3).map((edge) => ({
            label: labelById.get(edge.to) || edge.to,
            detail: edge.label || undefined,
          })),
        }
      }
      const single = outgoing[0]
      return {
        label: node.label,
        detail: single?.label ? `→ ${single.label}` : undefined,
      }
    })
  const padded: ProcessFlowStep[] = [...steps]
  while (padded.length < 2) padded.push({ label: '（待补充）' })
  return {
    heading,
    steps: padded,
  }
}
