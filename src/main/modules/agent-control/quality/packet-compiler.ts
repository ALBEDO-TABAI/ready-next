/**
 * EP3-PK2 — dispatch compiler gate + packet-tree validation (09 §3).
 * P5c/C22 unwired: this module is not in production path.
 *
 * The trigger threshold is CODE, never the model: only multi_step_task /
 * research with multiple targets enter compilation; direct_answer and
 * short_task are NEVER packetized (一包都嫌多). The compiler itself is a
 * constrained planning-step action — prompt asset
 * `prompts/dispatch/compile-packets.md` (X3 loader) — and its output tree
 * is structurally validated here: one parent + 1..4 children, exactly one
 * deliverable per child (没有产出的协调包非法), refs-not-retellings, and
 * the two-level cap proven with the SAME validators the projection write
 * funnel uses. A bad tree is rejected whole, never partially applied.
 *
 * The parent is an aggregation packet whose criteria are a FIXED code-owned
 * template (09 §3.3) — acceptance is written at compile time, executors
 * cannot rewrite it (验收权与执行权分离).
 */

import type { TaskType } from '../../../../shared/task-types'
import type { CriteriaItem } from './criteria-templates'
import { validatePacketFields, assertPacketDepth, type PacketDepthRow } from './packet-fields'
import { PromptAssetLoader } from '../prompt-assets/loader'
import { promptAssetRoots } from '../prompt-assets/roots'

/** 09 §6 风险缓解: 包数上限 v1 ≤4（防模型把简单事拆碎）。 */
export const MAX_CHILD_PACKETS = 4

const PACKET_ELIGIBLE_TYPES: ReadonlyArray<TaskType> = ['multi_step_task', 'research']
const NEVER_PACKETIZED: ReadonlyArray<TaskType> = ['direct_answer', 'short_task']

export interface PacketCompileGateInput {
  taskType: TaskType
  /** Distinct deliverable targets, counted by planner CODE (explicit
   *  multi-goal enumeration) — never a model judgment. */
  targetCount: number
}

export interface PacketCompileGateResult {
  decision: 'compile' | 'skip'
  reason: string
}

export function decidePacketCompilation(input: PacketCompileGateInput): PacketCompileGateResult {
  if ((NEVER_PACKETIZED as readonly string[]).includes(input.taskType)) {
    return { decision: 'skip', reason: `type_never_packetized:${input.taskType}` }
  }
  if (!(PACKET_ELIGIBLE_TYPES as readonly string[]).includes(input.taskType)) {
    return { decision: 'skip', reason: `type_not_eligible:${input.taskType}` }
  }
  if (!Number.isFinite(input.targetCount) || input.targetCount < 2) {
    return { decision: 'skip', reason: 'single_target' }
  }
  return { decision: 'compile', reason: `eligible:${input.taskType}:targets=${input.targetCount}` }
}

/** Fixed aggregation criteria for the parent packet (09 §3.3) — code-owned,
 *  written at dispatch time, executors may only add not_applicable notes. */
export function buildAggregationCriteria(): CriteriaItem[] {
  return [
    { id: 'c1', kind: 'steps_complete', source: 'template', text: '所有子包均已 Check-in（completed / 显式降级说明）' },
    { id: 'c2', kind: 'artifact', source: 'template', text: '综合产物已生成（引用各子包 proof 而非复述内容）' },
    { id: 'c3', kind: 'response_digest', source: 'template', text: '未决问题已列出（子包的 blocked 项 + 开放问题）' },
  ]
}

export interface CompiledChildPacket {
  title: string
  /** 一包恰好一个可验收交付物。 */
  deliverable: string
  contextRefs: string[]
}

export interface CompiledPacketTree {
  parentTitle: string
  children: CompiledChildPacket[]
}

export type PacketTreeParseResult =
  | { ok: true; tree: CompiledPacketTree }
  | { ok: false; reason: string }

/**
 * Parse + structurally validate the compiler LLM output. Whole-or-nothing:
 * any illegal node rejects the entire tree.
 */
export function parseCompiledPacketTree(raw: string): PacketTreeParseResult {
  let parsed: unknown
  try {
    const trimmed = String(raw || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'not_json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_object' }
  }
  const record = parsed as Record<string, unknown>
  const parentTitle = typeof record.parentTitle === 'string' ? record.parentTitle.trim() : ''
  if (!parentTitle) return { ok: false, reason: 'missing_parent_title' }
  if (!Array.isArray(record.children) || record.children.length === 0) {
    return { ok: false, reason: 'no_children (单目标任务不该进编译)' }
  }
  if (record.children.length > MAX_CHILD_PACKETS) {
    return { ok: false, reason: `too_many_children:${record.children.length} (v1 上限 ${MAX_CHILD_PACKETS})` }
  }
  const children: CompiledChildPacket[] = []
  for (const entry of record.children) {
    const child = entry as Record<string, unknown>
    if (child && typeof child === 'object' && 'children' in child) {
      return { ok: false, reason: 'nested_children (两层上限，子包不得再分包)' }
    }
    const title = typeof child?.title === 'string' ? child.title.trim() : ''
    const deliverable = typeof child?.deliverable === 'string' ? child.deliverable.trim() : ''
    if (!title) return { ok: false, reason: 'child_missing_title' }
    if (!deliverable) return { ok: false, reason: `child_missing_deliverable:${title} (没有产出的协调包非法)` }
    const contextRefs = Array.isArray(child?.contextRefs) ? child.contextRefs.map(String) : []
    try {
      validatePacketFields({ packetRole: 'child', contextRefs })
    } catch (error) {
      return { ok: false, reason: `child_refs_invalid:${title}: ${error instanceof Error ? error.message : String(error)}` }
    }
    children.push({ title, deliverable, contextRefs })
  }
  // prove the shape with the SAME depth validator the write funnel runs
  const syntheticRows = new Map<string, PacketDepthRow>([
    ['parent', { taskId: 'parent', packetRole: 'parent', parentTaskId: null }],
  ])
  try {
    assertPacketDepth(syntheticRows.get('parent')!, () => null)
    children.forEach((_, index) => {
      assertPacketDepth(
        { taskId: `child-${index}`, packetRole: 'child', parentTaskId: 'parent' },
        (taskId) => syntheticRows.get(taskId) ?? null,
      )
    })
  } catch (error) {
    return { ok: false, reason: `depth_invalid: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, tree: { parentTitle, children } }
}

const COMPILE_PROMPT_FALLBACK = [
  '把下面的多目标任务编译成任务包树，输出 JSON：{"parentTitle":"…","children":[{"title":"…","deliverable":"一句可验收产出","contextRefs":["引用"]}]}。',
  '纪律：一包恰好一个可验收交付物；子包最多 4 个；contextRefs 只放执行必需的引用，禁止塞父任务全文或当天摘要；子包不得再分包。',
  '',
  '用户请求：{{request}}',
  '',
  '知识索引：{{knowledge_index}}',
].join('\n')

export function buildCompilePacketsPrompt(input: { request: string; knowledgeIndex: string }): string {
  let body: string
  try {
    const loader = new PromptAssetLoader({
      roots: promptAssetRoots(),
      fallbacks: { 'dispatch/compile-packets': COMPILE_PROMPT_FALLBACK },
    })
    body = loader.load('dispatch/compile-packets').body
  } catch {
    body = COMPILE_PROMPT_FALLBACK
  }
  return body
    .replace('{{request}}', input.request)
    .replace('{{knowledge_index}}', input.knowledgeIndex || '（空）')
}
