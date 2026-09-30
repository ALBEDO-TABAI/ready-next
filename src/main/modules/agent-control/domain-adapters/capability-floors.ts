import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'

/**
 * P1-3 — 能力地板（capability floors）：显式技能引用 / 本地文档资源 / 当前文档上下文产生的
 *   代码级"必在"工具集。一切收窄过滤只做减法且不得移除地板项；裁决面与管线末端据此强制
 *   `surface ⊇ floors`。纯函数、零 IO：只读取 authorization 与资源布尔信号，不碰注册表/运行时。
 *   （只 import 类型，避免 domain-adapters ↔ runtime-core 运行时环依赖。）
 */
export interface CapabilityFloors {
  readonly toolNames: ReadonlySet<string>
  /** 地板来源，用于可观测日志，如 'skill_selected:ready-human-touch-ppt' / 'local_document_resource'。 */
  readonly reasons: ReadonlyArray<string>
}

export const RSS_RESOURCE_FLOOR_TOOL_NAMES: ReadonlyArray<string> = ['rss_query_items', 'rss_read_article', 'rss_read_reference', 'rss_read_processing', 'rss_read_excerpt', 'rss_read_digests', 'rss_read_events', 'rss_read_analysis_report', 'rss_read_catalog']
/** 本地文档资源只授读取，不包含写入。 */
export const LOCAL_DOCUMENT_RESOURCE_FLOOR_TOOL_NAMES: ReadonlyArray<string> = ['file_locate', 'file_read_excerpt']
export const TAG_FORGE_FOLDER_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'tag_forge_prepare_batch',
  'tag_forge_apply_batch',
]
export const TAG_FORGE_FOLDER_RUNTIME_TOOL_NAMES: ReadonlyArray<string> = [
  ...LOCAL_DOCUMENT_RESOURCE_FLOOR_TOOL_NAMES,
  ...TAG_FORGE_FOLDER_FLOOR_TOOL_NAMES,
  'declare_completion_criteria',
]
/**
 * 当前编辑器文档上下文在场时的地板工具：用户正开着的文档是可编辑对象，任何轮
 * （含技能 selected 收窄轮）都必须保有精准编辑与 widget 通道——否则模型会被迫用
 * artifact 整文件覆写或 markdown 表格冒充信息卡（2026-07-11 dogfood 两例）。
 * 刻意不含 set_content / append_content 这类整文覆写工具。
 */
export const CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'document_read_section',
  'document_list_widgets',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_exact',
  'document_save_tab',
]

export function computeCapabilityFloors(params: {
  authorization: SkillToolAuthorization
  hasLocalDocumentResource: boolean
  hasCurrentDocumentContext: boolean
  hasRSSResource?: boolean
}): CapabilityFloors {
  const toolNames = new Set<string>()
  const reasons: string[] = []
  const tagForgeFolderBatch = params.authorization.mode === 'selected'
    && params.authorization.skillId === 'tag-forge'
    && params.hasLocalDocumentResource

  if (params.authorization.mode === 'selected') {
    if (!tagForgeFolderBatch) {
      for (const name of params.authorization.allowedTypedActions) toolNames.add(name)
      for (const name of params.authorization.allowedPrimitives) toolNames.add(name)
    }
    reasons.push(`skill_selected:${params.authorization.skillId}`)
  }
  if (params.hasLocalDocumentResource) {
    for (const name of LOCAL_DOCUMENT_RESOURCE_FLOOR_TOOL_NAMES) toolNames.add(name)
    reasons.push('local_document_resource')
    if (tagForgeFolderBatch) {
      for (const name of TAG_FORGE_FOLDER_FLOOR_TOOL_NAMES) toolNames.add(name)
      reasons.push('tag_forge_folder_batch')
    }
  }
  if (params.hasCurrentDocumentContext) {
    for (const name of CURRENT_DOCUMENT_CONTEXT_FLOOR_TOOL_NAMES) toolNames.add(name)
    reasons.push('current_document_context')
  }

  if (params.hasRSSResource) {
    for (const name of RSS_RESOURCE_FLOOR_TOOL_NAMES) toolNames.add(name)
    reasons.push('rss_resource')
  }

  return { toolNames, reasons }
}

/**
 * P1-3 不变量执行器：断言 `surface ⊇ floors`；缺席的地板项从 `recoverFrom`（收窄前的面）补回。
 * 返回补回后的面与缺席清单（调用方据 missing 落 tool_surface_floor_violation 日志）。纯函数。
 */
export function enforceCapabilityFloors<T extends { name: string }>(
  surface: readonly T[],
  floors: CapabilityFloors,
  recoverFrom: readonly T[],
): { definitions: T[]; missing: string[] } {
  const present = new Set(surface.map((definition) => definition.name))
  const missing = [...floors.toolNames].filter((name) => !present.has(name))
  const definitions = [...surface]
  for (const name of missing) {
    const restored = recoverFrom.find((definition) => definition.name === name)
    if (restored && !present.has(name)) {
      definitions.push(restored)
      present.add(name)
    }
  }
  return { definitions, missing }
}

/**
 * P1-3 硬地板：地板工具即便被组不可见/意图压制而缺席（不在 definitions 里），也从注册表 resolve 补回。
 * resolve 取不到 → 记入 unavailable（调用方落 sdk_runtime_floor_tool_unavailable 日志）。纯函数（resolve 由调用方注入）。
 */
export function recoverAbsentFloorsFromRegistry<T extends { name: string }>(
  definitions: readonly T[],
  floors: CapabilityFloors,
  resolveDefinition: (name: string) => T | null,
): { definitions: T[]; unavailable: string[] } {
  const present = new Set(definitions.map((definition) => definition.name))
  const result = [...definitions]
  const unavailable: string[] = []
  for (const name of floors.toolNames) {
    if (present.has(name)) continue
    const resolved = resolveDefinition(name)
    if (!resolved) {
      unavailable.push(name)
      continue
    }
    result.push(resolved)
    present.add(name)
  }
  return { definitions: result, unavailable }
}
