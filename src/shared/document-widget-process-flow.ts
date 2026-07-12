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
const HAIR = widgetVar('hair')
const CARD = widgetVar('card')
const CANVAS = widgetVar('canvas')
const ACCENT = widgetVar('accent')
const ACCENT_SOFT = widgetVar('accentSoft')

function stepMarker(index: number, kind?: string): string {
  const numeral = String(index + 1).padStart(2, '0')
  const isMilestone = kind === 'milestone'
  const bg = isMilestone ? ACCENT_SOFT : CARD
  const border = isMilestone ? ACCENT : HAIR
  const color = isMilestone ? ACCENT : INK2
  return `<div class="num" data-flow-marker="${kind || 'step'}" style="position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:${bg};border:1px solid ${border};color:${color};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;">${numeral}</div>`
}

function renderBranches(branches: ProcessFlowStep['branches']): string {
  if (!branches || branches.length === 0) return ''
  const cells = branches
    .map(
      (branch) => `<div data-flow-branch style="min-width:0;padding:10px 12px;border-radius:12px;background:${CANVAS};border:1px solid ${HAIR};">
      <div style="font-size:13px;font-weight:600;color:${INK};line-height:1.4;">${escapeHtml(branch.label)}</div>
      ${branch.detail ? `<div style="font-size:12px;color:${INK2};line-height:1.5;margin-top:3px;">${escapeRichText(branch.detail)}</div>` : ''}
    </div>`,
    )
    .join('')
  return `<div style="display:grid;grid-template-columns:repeat(${branches.length},minmax(0,1fr));gap:8px;margin-top:10px;">${cells}</div>`
}

export function compileProcessFlow(props: ProcessFlowProps): string {
  const steps = props.steps
    .map((step, index) => {
      const isLast = index === props.steps.length - 1 && !props.outcome
      const branchLabel =
        step.kind === 'decision' && step.branches?.length
          ? `<span class="badge" style="margin-left:8px;">分支</span>`
          : ''
      return `<div data-flow-step style="position:relative;padding-left:40px;padding-bottom:${isLast ? '0' : '18px'};">
      ${stepMarker(index, step.kind)}
      <div style="font-size:14px;font-weight:600;color:${INK};line-height:1.5;display:flex;align-items:center;flex-wrap:wrap;">${escapeHtml(step.label)}${branchLabel}</div>
      ${step.detail ? `<div style="font-size:13px;color:${INK2};line-height:1.65;margin-top:4px;">${escapeRichText(step.detail)}</div>` : ''}
      ${renderBranches(step.branches)}
    </div>`
    })
    .join('')

  const outcome = props.outcome
    ? `<div data-flow-outcome style="position:relative;margin-left:40px;padding:12px 14px;border-radius:12px;background:${ACCENT_SOFT};border-left:3px solid ${ACCENT};">
      <div class="label" style="color:${ACCENT};font-size:10px;">OUTCOME</div>
      <div style="font-size:14px;font-weight:600;color:${INK};line-height:1.5;margin-top:4px;">${escapeHtml(props.outcome.label)}</div>
      ${props.outcome.detail ? `<div style="font-size:13px;color:${INK2};line-height:1.6;margin-top:3px;">${escapeRichText(props.outcome.detail)}</div>` : ''}
    </div>`
    : ''

  return `<div class="card stack process-flow-widget" style="gap:16px;">
    <div class="stack" style="gap:4px;">
      ${props.heading ? `<div class="title">${escapeHtml(props.heading)}</div>` : ''}
      ${props.subtitle ? `<div class="subtitle">${escapeHtml(props.subtitle)}</div>` : ''}
    </div>
    <div style="position:relative;">
      <div style="position:absolute;left:13px;top:10px;bottom:10px;width:1px;background:${HAIR};"></div>
      <div style="position:relative;">${steps}</div>
      ${outcome}
    </div>
    ${props.footer ? `<div class="label" style="font-size:10px;">${escapeHtml(props.footer)}</div>` : ''}
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
  const steps: ProcessFlowStep[] = nodes.slice(0, 10).map((node) => {
    const outgoing = edges.filter((edge) => edge.from === node.id && labelById.has(edge.to))
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
